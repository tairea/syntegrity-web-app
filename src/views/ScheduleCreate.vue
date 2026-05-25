<script setup lang="ts">
/**
 * /schedule — host plans a future Syntegrity session.
 *
 * Picks: date + time + IANA timezone (browser-detected default), driving
 * question, shape (3 cards from SHAPE_META), and a session format (chips
 * driven by listFormatsForShape). Renders a read-only timetable of the
 * selected format's Stage[] so the host can see what they're committing to.
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { getShape, SHAPE_META, type ShapeName } from '@/util';
import {
  CANONICAL_ICOSAHEDRON, CANONICAL_TETRAHEDRON, REVERBERATION_120_OCTAHEDRON,
  getFormat, listFormatsForShape, type SessionFormat, type SessionFormatId, type Stage,
} from '@/util/session-formats';
import { useScheduleStore } from '@/stores/schedule';
import PolyhedronScene, { type SceneNode } from '@/components/PolyhedronScene.vue';
import WorldClockMap from '@/components/WorldClockMap.vue';
import { SOURCE_ZONES } from '@/util/world-clock-cities';
import { wallTimeToUtc } from '@/util/world-clock';

const router = useRouter();
const schedule = useScheduleStore();

const DETECTED_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
})();

// IANA zones the user can pick — drawn from the city list rendered on the
// world map so every selection corresponds to a visible label. The browser-
// detected zone is pinned to the top (even if it's not in the city list).
const timezones = computed(() => {
  const fromMap = SOURCE_ZONES.map((z) => ({ value: z.tz, label: `${z.label} — ${z.tz}` }));
  const seen = new Set(fromMap.map((z) => z.value));
  if (!seen.has(DETECTED_TZ)) fromMap.unshift({ value: DETECTED_TZ, label: `Your location — ${DETECTED_TZ}` });
  return fromMap;
});

const SHAPES: ShapeName[] = ['tetrahedron', 'octahedron', 'icosahedron'];
const DEFAULT_FORMAT_BY_SHAPE: Record<ShapeName, SessionFormatId> = {
  tetrahedron: CANONICAL_TETRAHEDRON.id as SessionFormatId,
  octahedron: REVERBERATION_120_OCTAHEDRON.id as SessionFormatId,
  cube: CANONICAL_TETRAHEDRON.id as SessionFormatId,
  cuboctahedron: CANONICAL_TETRAHEDRON.id as SessionFormatId,
  icosahedron: CANONICAL_ICOSAHEDRON.id as SessionFormatId,
  icosidodecahedron: CANONICAL_ICOSAHEDRON.id as SessionFormatId,
};

function nextRoundHour(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const date = ref<string>(todayIso());
const time = ref<string>(nextRoundHour());
const timezone = ref<string>(DETECTED_TZ);
const drivingQuestion = ref('');
const shape = ref<ShapeName>('octahedron');
const formatId = ref<SessionFormatId>(DEFAULT_FORMAT_BY_SHAPE.octahedron);

const showExamples = ref(false);
const busy = ref(false);
const error = ref('');
const showNewFormatDialog = ref(false);
const promptCopied = ref(false);
const showMap = ref(false);

const LLM_CONTEXT_PROMPT = `You are helping me draft a new "session format" for a Team Syntegrity web app.

WHAT TEAM SYNTEGRITY IS
Stafford Beer's Team Syntegrity is a non-hierarchical method for group thinking on a complex question. A group (6–60 people) is mapped onto the edges of a polyhedron whose vertices are the topics the group will work on. Every person sits on a strut (edge) and is a member of the two teams (vertices) it touches; they also critique the topics on opposite vertices. Beer's canonical form is the icosahedron (30 people, 12 topics, teams of 5, three iterations through every topic — status quo → ideal → actions). Truss's "ShortForms" use smaller solids so the protocol scales down.

THIS WEB APP
A prototype that runs Syntegrity sessions in real time. Host enters a driving question, group fills the polyhedron (lobby). After Problem Jostle (statement gathering + clustering) and a vote, the app runs Outcome Resolve — the heart of the protocol, where teams meet to discuss each topic. A SessionFormat defines the recipe: which shape, which stages, how long each lasts, and the structural choices inside Outcome Resolve.

KEY TERMS
- Stage: top-level event segment.
- Iteration: one pass through ALL topics inside Outcome Resolve. Canon = 3.
- Slot: a wall-clock block within an iteration, holding 1+ concurrent team meetings.
- Meeting: one team's session in one slot in one iteration.
- Reverberation: cross-team idea migration. The app supports a dedicated reverberation stage with LLM transcript synthesis + team report-backs.
- Critic policy:
   * all-critics-in-room — Beer canon. Every critic of T attends T's meeting (lowers concurrency on smaller shapes).
   * split-critics-in-room — critics distribute across parallel rooms (experimental; keeps everyone active).
   * async-notes-only — critics never enter the room; post notes between iterations.
   * no-critics — contributors-only. Off-protocol.

AVAILABLE SHAPES
- tetrahedron: 6 people, 4 topics, teams of 3. All teams contain all 6 people => concurrency 1.
- octahedron: 12 people, 6 topics, teams of 4. all-critics => sequential; split-critics => concurrency 2.
- cube: 12 people, 8 topics, teams of 3. (Metadata only — strut table not yet encoded.)
- cuboctahedron: 24 people, 12 topics, teams of 4. (Metadata only.)
- icosahedron: 30 people, 12 topics, teams of 5. Beer canon. Concurrency 2 with all-critics-in-room.
- icosidodecahedron: 60 people, 30 topics, teams of 4. (Metadata only.)

DATA SHAPE (TypeScript)
type StageKind =
  | 'opening' | 'problem-jostle' | 'voting' | 'topic-preference' | 'graph-reveal'
  | 'outcome-resolve' | 'between-iteration' | 'reverberation' | 'closing-plenary'
  | 'face-planning' | 'break' | 'custom';
type CriticPolicy = 'all-critics-in-room' | 'split-critics-in-room' | 'async-notes-only' | 'no-critics';
type ShapeName = 'tetrahedron'|'octahedron'|'cube'|'cuboctahedron'|'icosahedron'|'icosidodecahedron';
type FormatProvenance = 'canonical-beer' | 'canonical-truss' | 'experimental';

interface StageBase { id: string; kind: StageKind; label: string; minutes: number; }
interface AppStage extends StageBase {
  kind: 'opening'|'problem-jostle'|'voting'|'topic-preference'|'graph-reveal'|'closing-plenary'|'face-planning';
}
interface OutcomeResolveStage extends StageBase {
  kind: 'outcome-resolve';
  iterations: number;          // canon = 3
  slotsPerIteration: number;   // wall-clock blocks; slots × concurrency must cover topicsCovered
  slotMinutes: number;
  iterationIntents?: string[]; // defaults to canon when iterations === 3
  topicsCovered?: number;      // default = shape.topicCount
  criticPolicy: CriticPolicy;
  betweenIterationBreakMinutes?: number;
}
interface ReverberationStage extends StageBase {
  kind: 'reverberation';
  parts: { llmSynthesisMinutes: number; teamReportbackMinutes: number; groupConvergenceMinutes: number; };
  transcriptSource: 'zoom-cloud' | 'per-breakout-recorder' | 'manual-scribe';
}
interface BetweenIterationStage extends StageBase { kind: 'between-iteration'; graffitiEnabled: boolean; }
interface BreakStage extends StageBase { kind: 'break'; }
interface CustomStage extends StageBase { kind: 'custom'; notes: string; }
type Stage = AppStage | OutcomeResolveStage | ReverberationStage | BetweenIterationStage | BreakStage | CustomStage;

interface SessionFormat {
  id: string;            // kebab-case, unique
  name: string;
  description: string;   // 1–3 sentences on intent + main trade-off
  provenance: FormatProvenance;
  shape: ShapeName;
  totalMinutes: number;  // MUST equal sum of every stage's minutes
  stages: Stage[];
  caveats?: string[];    // honest disclosure of departures from canon
}

VALIDATION RULES
- totalMinutes MUST equal the sum of every stage's minutes.
- For each outcome-resolve stage:
    minutes >= iterations × slotsPerIteration × slotMinutes + (iterations - 1) × (betweenIterationBreakMinutes ?? 0)
- For 'canonical-beer' provenance: outcome-resolve.iterations MUST be 3.
- For reverberation stages: the three parts.* minutes must sum to stage.minutes.

REFERENCE FORMAT — today's landed octahedron (2 hours)
const REVERBERATION_120_OCTAHEDRON = {
  id: 'reverberation-120-octa',
  name: 'Reverberation 120 (Octahedron)',
  description: '2 hours total. 3 slots × 20 min covers all 6 topics in parallel pairs, then a dedicated Reverberation stage: LLM synthesis, team report-backs, one converged thread.',
  provenance: 'experimental',
  shape: 'octahedron',
  totalMinutes: 120,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 10 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 4 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 3 },
    { id: 'resolve', kind: 'outcome-resolve',
      label: 'Outcome Resolve — 1 iteration × 3 parallel-pair slots × 20 min',
      minutes: 60, iterations: 1, slotsPerIteration: 3, slotMinutes: 20,
      criticPolicy: 'split-critics-in-room' },
    { id: 'regroup', kind: 'custom', label: 'Regroup in Zoom main', minutes: 5, notes: 'Move out of breakouts; LLM synthesis already running.' },
    { id: 'reverberation', kind: 'reverberation', label: 'Reverberation', minutes: 30,
      parts: { llmSynthesisMinutes: 10, teamReportbackMinutes: 15, groupConvergenceMinutes: 5 },
      transcriptSource: 'zoom-cloud' },
  ],
  caveats: [
    'Single iteration — no Beer "three-iteration rhythm".',
    'split-critics-in-room is not yet implemented in the scheduler.',
    'Reverberation requires a transcript pipeline.',
  ],
};

YOUR JOB
Help me design a new SessionFormat. Ask me about:
- the goal (compression / depth / Beer-faithfulness / novel critic dynamic / etc.),
- the available wall-clock time and the shape,
- whether reverberation, breaks, or face-planning belong,
- any caveats I should be honest about.
When you have enough, propose a single SessionFormat object that passes the validation rules. Be honest in caveats[] about any departures from canon.

DO NOT BEGIN DRAFTING YET. First confirm you've read the context, then ask me what kind of format I want to explore.`;

async function copyPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(LLM_CONTEXT_PROMPT);
    promptCopied.value = true;
    setTimeout(() => (promptCopied.value = false), 1800);
  } catch {
    // ignore — the textarea is selectable so users can fallback manually
  }
}

const EXAMPLES = [
  'How should our community move from informal mutual aid to a functioning Integral node this year?',
  'What kinds of contribution should our node recognise, and what should remain freely accessible regardless of contribution?',
  'How do we coordinate production and resources with neighbouring nodes without recreating central authority?',
];

const shapeOptions = computed(() => SHAPES.map((s) => ({
  name: s,
  meta: SHAPE_META[s],
})));

// Empty placeholder edge nodes for the rotating shape preview.
const previewEdgeNodes = computed<(SceneNode | null)[]>(() => {
  const count = getShape(shape.value).participantCount;
  return Array.from({ length: count }, () => null);
});
const previewVertexLabels = computed<string[]>(() => {
  const t = getShape(shape.value).topicCount;
  return Array.from({ length: t }, (_, i) => `Topic ${i + 1}`);
});

const formatOptions = computed<SessionFormat[]>(() => listFormatsForShape(shape.value));
const selectedFormat = computed<SessionFormat>(() => getFormat(formatId.value));
const shapeMeta = computed(() => SHAPE_META[selectedFormat.value.shape]);

/** Pulls the iteration count from the format's OutcomeResolve stage, if any. */
function iterationsOf(f: SessionFormat): number {
  const or = f.stages.find((s) => s.kind === 'outcome-resolve');
  return or && 'iterations' in or ? or.iterations : 0;
}

function pickShape(s: ShapeName): void {
  shape.value = s;
  // Reset to that shape's default format (or first available).
  const def = DEFAULT_FORMAT_BY_SHAPE[s];
  const available = listFormatsForShape(s);
  formatId.value = (available.find((f) => f.id === def)?.id as SessionFormatId)
    ?? (available[0]?.id as SessionFormatId);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

interface StandardRow {
  kind: 'standard';
  id: string;
  label: string;
  minutes: number;
  sub?: string;
}
interface Meeting {
  topic: number;       // 1-based topic index
  members: number[];   // 1-based participant ids
  critics: number[];
}
interface SlotPlacement {
  meetings: Meeting[];
  idle: number[];
}
interface OutcomeResolveRow {
  kind: 'outcome-resolve';
  id: string;
  label: string;
  minutes: number;
  iterations: number;
  slotsPerIteration: number;
  slotMinutes: number;
  concurrency: number;
  criticPolicy: string;
  betweenIterationBreakMinutes: number;
  /** [iteration][slot] = SlotPlacement. */
  schedule: SlotPlacement[][];
}
type TimetableRow = StandardRow | OutcomeResolveRow;

// Stages bundled into the "App opening" row — these are app-driven and
// short relative to Outcome Resolve, so we don't itemise them.
const APP_OPENING_KINDS = new Set(['opening', 'problem-jostle', 'voting', 'topic-preference', 'graph-reveal']);

/**
 * Build a synthetic but consistent placement of every participant across
 * iteration × slot × room. The real scheduler picks the conflict-free
 * assignment from the actual shape struts; this preview rotates participants
 * deterministically so the user can see *every person accounted for* in every
 * slot. Members are cycled, then critics are placed per criticPolicy.
 */
function buildOutcomePlacement(
  stage: Extract<Stage, { kind: 'outcome-resolve' }>,
  shapeMeta: { participantCount: number; topicCount: number; teamSize: number },
): { schedule: SlotPlacement[][]; concurrency: number } {
  const topicsCovered = stage.topicsCovered ?? shapeMeta.topicCount;
  const concurrency = Math.max(1, Math.ceil(topicsCovered / stage.slotsPerIteration));
  const total = shapeMeta.participantCount;
  const teamSize = shapeMeta.teamSize;

  const schedule: SlotPlacement[][] = [];
  for (let it = 0; it < stage.iterations; it++) {
    const slots: SlotPlacement[] = [];
    for (let s = 0; s < stage.slotsPerIteration; s++) {
      // Rotate the participant order per (iteration, slot) so the same person
      // visibly moves through different rooms across the schedule.
      const shift = (it * teamSize * concurrency + s * teamSize * concurrency) % total;
      const order = Array.from({ length: total }, (_, i) => ((i + shift) % total) + 1);

      const startTopic = s * concurrency;
      const endTopic = Math.min(startTopic + concurrency, topicsCovered);
      const meetings: Meeting[] = [];
      let cursor = 0;
      for (let t = startTopic; t < endTopic; t++) {
        const members = order.slice(cursor, cursor + teamSize);
        cursor += teamSize;
        meetings.push({ topic: t + 1, members, critics: [] });
      }
      const remaining = order.slice(cursor);

      let idle: number[] = [];
      if (meetings.length === 0) {
        idle = remaining;
      } else if (stage.criticPolicy === 'all-critics-in-room') {
        for (const m of meetings) m.critics = [...remaining];
      } else if (stage.criticPolicy === 'split-critics-in-room') {
        const perMeeting = Math.floor(remaining.length / meetings.length);
        const extra = remaining.length % meetings.length;
        let r = 0;
        for (let m = 0; m < meetings.length; m++) {
          const count = perMeeting + (m < extra ? 1 : 0);
          meetings[m].critics = remaining.slice(r, r + count);
          r += count;
        }
      } else {
        idle = remaining;
      }
      slots.push({ meetings, idle });
    }
    schedule.push(slots);
  }
  return { schedule, concurrency };
}

function stageRows(stages: Stage[], shapeMeta: { participantCount: number; topicCount: number; teamSize: number }): TimetableRow[] {
  const rows: TimetableRow[] = [];
  let appBucket = 0;
  const flushApp = () => {
    if (appBucket > 0) {
      rows.push({
        kind: 'standard',
        id: `app-opening-${rows.length}`,
        label: 'App opening',
        minutes: appBucket,
        sub: 'Lobby → Jostle → Vote → Rank → Graph reveal',
      });
      appBucket = 0;
    }
  };
  for (const s of stages) {
    if (APP_OPENING_KINDS.has(s.kind)) { appBucket += s.minutes; continue; }
    flushApp();
    if (s.kind === 'outcome-resolve') {
      const { schedule, concurrency } = buildOutcomePlacement(s, shapeMeta);
      rows.push({
        kind: 'outcome-resolve',
        id: s.id, label: s.label, minutes: s.minutes,
        iterations: s.iterations,
        slotsPerIteration: s.slotsPerIteration,
        slotMinutes: s.slotMinutes,
        concurrency,
        criticPolicy: s.criticPolicy,
        betweenIterationBreakMinutes: s.betweenIterationBreakMinutes ?? 0,
        schedule,
      });
    } else if (s.kind === 'reverberation') {
      const p = s.parts;
      rows.push({
        kind: 'standard',
        id: s.id, label: s.label, minutes: s.minutes,
        sub: `LLM ${p.llmSynthesisMinutes}m · Report-back ${p.teamReportbackMinutes}m · Converge ${p.groupConvergenceMinutes}m`,
      });
    } else {
      rows.push({ kind: 'standard', id: s.id, label: s.label, minutes: s.minutes });
    }
  }
  flushApp();
  return rows;
}

const timetable = computed(() => stageRows(selectedFormat.value.stages, SHAPE_META[selectedFormat.value.shape]));

/** UTC Date for the chosen wall-clock (date + time + zone) — drives the map. */
const baseUtc = computed<Date>(() => {
  const [y, mo, d] = date.value.split('-').map(Number);
  const [hh, mm] = time.value.split(':').map(Number);
  return wallTimeToUtc(y ?? 1970, mo ?? 1, d ?? 1, hh ?? 0, mm ?? 0, timezone.value);
});

// ── Slider helpers (0..1439 minutes since local midnight) ─────────────
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minutesToTime(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const timeMinutes = computed({
  get: () => timeToMinutes(time.value),
  set: (v: number) => { time.value = minutesToTime(v); },
});
const bigTime = computed(() => {
  const [h, m] = time.value.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { hm: `${h12}:${String(m).padStart(2, '0')}`, period };
});
// "24 May 2026" — displayed on the date button; native picker stays attached.
const formattedDate = computed(() => {
  if (!date.value) return '';
  const [y, mo, d] = date.value.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(dt);
});

const dateInput = ref<HTMLInputElement | null>(null);
function openDatePicker(): void {
  const el = dateInput.value;
  if (!el) return;
  type WithShowPicker = HTMLInputElement & { showPicker?: () => void };
  const withPicker = el as WithShowPicker;
  if (typeof withPicker.showPicker === 'function') {
    try { withPicker.showPicker(); return; } catch { /* fall through */ }
  }
  el.focus();
  el.click();
}

const canSubmit = computed(() =>
  drivingQuestion.value.trim().length > 0 &&
  !!date.value && !!time.value && !!timezone.value &&
  !!shape.value && !!formatId.value,
);

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true; error.value = '';
  try {
    const startUtc = baseUtc.value.toISOString();
    const { code, creatorToken } = await schedule.createScheduledSession({
      drivingQuestion: drivingQuestion.value.trim(),
      shape: shape.value,
      formatId: formatId.value,
      startUtc,
      timezone: timezone.value,
    });
    router.push({ name: 'scheduled', params: { code }, query: { owner: creatorToken } });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="schedule">
    <div class="hero">
      <h1>Schedule a session</h1>
      <p class="sub">Pick a date and time, pose your driving question, and choose a shape + format. Participants commit ahead of time and get a calendar invite.</p>

      <div class="form">
        <!-- Date + Time (two columns) -->
        <div class="row two">
          <div>
            <label class="lbl">Date</label>
            <button type="button" class="date-field" @click="openDatePicker">{{ formattedDate || 'Pick a date' }}</button>
            <input ref="dateInput" type="date" v-model="date" class="date-native" tabindex="-1" aria-hidden="true" />
          </div>
          <div>
            <label class="lbl">Time</label>
            <input type="time" v-model="time" class="time-field" />
          </div>
        </div>

        <!-- Timezone + toggle for the world map -->
        <div class="tz-row">
          <div class="tz-field">
            <label class="lbl">Timezone</label>
            <select v-model="timezone" class="tz-select">
              <option v-for="tz in timezones" :key="tz.value" :value="tz.value">{{ tz.label }}</option>
            </select>
          </div>
          <button type="button" class="map-toggle" @click="showMap = !showMap">
            {{ showMap ? 'Hide' : 'Show' }} world timezones
          </button>
        </div>

        <!-- Collapsible: big time readout, slider, world map -->
        <div v-if="showMap" class="map-block">
          <div class="big-time">
            <span class="big-time-hm">{{ bigTime.hm }}</span>
            <span class="big-time-period">{{ bigTime.period }}</span>
          </div>
          <input class="time-slider" type="range" min="0" max="1439" step="5"
                 :value="timeMinutes" @input="timeMinutes = Number(($event.target as HTMLInputElement).value)"
                 aria-label="Time of day" />
          <div class="time-ticks">
            <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
          </div>
          <WorldClockMap :base-utc="baseUtc" :source-zone="timezone" />
        </div>

        <section class="dq-card">
          <header class="dq-head">
            <h2 class="dq-title">Driving Question</h2>
            <span class="info-wrap">
              <button class="dq-examples-btn"
                      @mouseenter="showExamples = true" @mouseleave="showExamples = false" @click="showExamples = !showExamples">
                See examples
              </button>
              <span v-if="showExamples" class="tooltip">
                <span class="tt-title">Examples</span>
                <ul><li v-for="ex in EXAMPLES" :key="ex">{{ ex }}</li></ul>
              </span>
            </span>
          </header>
          <p class="dq-sub">Pose one open, shared, and consequential question for the group to explore — it should invite genuinely different answers.</p>
          <textarea v-model="drivingQuestion" rows="4" class="dq-textarea"
                    placeholder="What single question does this group need to think through together?" />
        </section>

        <div>
          <label class="lbl">Shape</label>
          <div class="shapes">
            <button v-for="opt in shapeOptions" :key="opt.name"
                    class="shape-card"
                    :class="{ selected: shape === opt.name }"
                    @click="pickShape(opt.name)">
              <div class="shape-name">{{ opt.name }}</div>
              <div class="shape-stats">
                {{ opt.meta.participantCount }} people · {{ opt.meta.topicCount }} topics · teams of {{ opt.meta.teamSize }}
              </div>
            </button>
          </div>
          <div class="shape-preview">
            <PolyhedronScene
              :shape-name="shape"
              :edge-nodes="previewEdgeNodes"
              :vertex-labels="previewVertexLabels"
              :rotate="true"
            />
          </div>
        </div>

        <div>
          <div class="lbl-row">
            <label class="lbl">Schedule options</label>
            <button class="new-format-btn" type="button" @click="showNewFormatDialog = true">
              + Create new experimental
            </button>
          </div>
          <select v-model="formatId">
            <option v-for="f in formatOptions" :key="f.id" :value="f.id">
              {{ f.name }} — {{ formatDuration(f.totalMinutes) }} — {{ iterationsOf(f) }} iteration{{ iterationsOf(f) === 1 ? '' : 's' }}
            </option>
          </select>
          <div class="format-info" :class="`prov-${selectedFormat.provenance}`">
            <div class="format-meta">
              <span class="provenance">{{ selectedFormat.provenance }}</span>
            </div>
            <p class="format-desc">{{ selectedFormat.description }}</p>
            <ul v-if="selectedFormat.caveats?.length" class="caveats">
              <li v-for="c in selectedFormat.caveats" :key="c">{{ c }}</li>
            </ul>
          </div>
        </div>

        <div>
          <label class="lbl">Timetable</label>
          <div class="timetable">
            <template v-for="row in timetable" :key="row.id">
              <div v-if="row.kind === 'standard'" class="t-row">
                <div class="t-main">
                  <span class="t-label">{{ row.label }}</span>
                  <span class="t-mins">{{ row.minutes }} min</span>
                </div>
                <div v-if="row.sub" class="t-sub">{{ row.sub }}</div>
              </div>

              <div v-else class="t-row or-row">
                <div class="t-main">
                  <span class="t-label">{{ row.label }}</span>
                  <span class="t-mins">{{ row.minutes }} min</span>
                </div>
                <div class="t-sub">
                  {{ row.concurrency }} parallel meeting{{ row.concurrency === 1 ? '' : 's' }} per slot — {{ row.criticPolicy }}
                </div>
                <div class="or-iters">
                  <div v-for="(slots, ii) in row.schedule" :key="ii" class="or-iter">
                    <div v-if="row.iterations > 1" class="or-iter-label">Iteration {{ ii + 1 }}</div>
                    <div class="or-grid" :style="{ gridTemplateColumns: `auto repeat(${row.concurrency}, minmax(0, 1fr)) auto` }">
                      <template v-for="(slot, si) in slots" :key="si">
                        <div class="or-slot-label">{{ row.slotMinutes }}m</div>
                        <div v-for="meeting in slot.meetings" :key="`m-${si}-${meeting.topic}`" class="or-cell">
                          <div class="or-cell-head">
                            <span class="or-cell-main">Topic {{ meeting.topic }}</span>
                            <span class="or-cell-sub">{{ ordinal(ii + 1) }} iteration</span>
                          </div>
                          <div class="people">
                            <span v-for="p in meeting.members" :key="`mem-${p}`" class="pid member">{{ p }}</span>
                            <template v-if="meeting.critics.length">
                              <span class="pid-sep">·</span>
                              <span v-for="p in meeting.critics" :key="`crit-${p}`" class="pid critic">{{ p }}</span>
                            </template>
                          </div>
                          <div class="or-cell-foot">
                            {{ meeting.members.length }} member{{ meeting.members.length === 1 ? '' : 's' }}<span v-if="meeting.critics.length"> · {{ meeting.critics.length }} critic{{ meeting.critics.length === 1 ? '' : 's' }}</span>
                          </div>
                        </div>
                        <div v-for="n in (row.concurrency - slot.meetings.length)" :key="`e-${si}-${n}`" class="or-cell empty"></div>
                        <div class="or-idle" :class="{ none: !slot.idle.length }">
                          <template v-if="slot.idle.length">
                            <span class="or-idle-label">sitting out</span>
                            <div class="people idle">
                              <span v-for="p in slot.idle" :key="`idle-${si}-${p}`" class="pid idle">{{ p }}</span>
                            </div>
                          </template>
                          <template v-else>
                            <span class="or-idle-label all-in">all {{ shapeMeta.participantCount }} engaged</span>
                          </template>
                        </div>
                      </template>
                    </div>
                    <div v-if="ii < row.schedule.length - 1 && row.betweenIterationBreakMinutes" class="or-break">
                      Break — {{ row.betweenIterationBreakMinutes }} min
                    </div>
                  </div>
                </div>
                <div class="or-legend">
                  <span class="pid member sm">1</span> member
                  <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'" class="legend-sep">·</span>
                  <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'" class="pid critic sm">1</span>
                  <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'"> critic</span>
                  <span class="legend-sep">·</span>
                  <span class="pid idle sm">1</span> sitting out
                  <span class="legend-note">— preview placement; the real per-person assignment is computed when the session starts.</span>
                </div>
              </div>
            </template>
            <div class="t-total">
              <span>Total</span>
              <span>{{ formatDuration(selectedFormat.totalMinutes) }}</span>
            </div>
          </div>
        </div>

        <p v-if="error" class="error">{{ error }}</p>

        <div class="row">
          <button class="ghost" @click="router.back()">Back</button>
          <button class="primary" :disabled="!canSubmit || busy" @click="submit">
            {{ busy ? 'Scheduling…' : 'Schedule this session' }}
          </button>
        </div>
      </div>
    </div>

    <!-- New experimental format dialog -->
    <div v-if="showNewFormatDialog" class="modal" @click.self="showNewFormatDialog = false">
      <div class="modal-inner wide">
        <header class="modal-header">
          <h3>Create a new experimental format</h3>
          <button class="modal-close" @click="showNewFormatDialog = false" aria-label="Close">✕</button>
        </header>
        <p class="modal-sub">Draft a new format with the LLM of your choice (Claude, ChatGPT, etc.), then submit it back so it can appear in the Schedule options dropdown.</p>

        <ol class="steps">
          <li>
            <strong>Copy the context block below</strong> and paste it into a fresh chat with your LLM.
            <div class="code-wrap">
              <button class="copy-btn" type="button" @click="copyPrompt">
                {{ promptCopied ? 'Copied!' : 'Copy prompt' }}
              </button>
              <pre class="code-block" v-text="LLM_CONTEXT_PROMPT"></pre>
            </div>
          </li>
          <li>
            <strong>Discuss the format with the LLM.</strong> It will ask about your goal (compression, depth, Beer-faithfulness, novel critic dynamic), the wall-clock time you have, the shape, and whether reverberation or breaks belong. When it has enough, it will draft a <code>SessionFormat</code> object.
          </li>
          <li>
            <strong>Submit your draft</strong> one of two ways:
            <ul class="submit-options">
              <li>Open a pull request that adds your new <code>SessionFormat</code> to <code>src/util/session-formats.ts</code> and registers it in <code>SESSION_FORMATS</code>.</li>
              <li>Or email the format (the full TypeScript object) to <a href="mailto:ian@sunriselabs.io?subject=New%20Syntegrity%20experimental%20format">ian@sunriselabs.io</a>.</li>
            </ul>
          </li>
        </ol>

        <div class="modal-row">
          <button class="primary" @click="showNewFormatDialog = false">Got it</button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.schedule { min-height: 100vh; display: grid; place-items: start center; background: radial-gradient(circle at 50% 0%, #1a2138, #0b0e16); padding: 3rem 1rem 6rem; }
.hero { width: min(720px, 94vw); color: #e6ecff; }
h1 { font-size: 2rem; font-weight: 600; margin: 0 0 0.4rem; }
.sub { color: #9fb0d8; margin: 0 0 2rem; line-height: 1.45; }
.form { display: grid; gap: 1.25rem; text-align: left; }
.lbl { display: inline-block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0d8; margin-bottom: 0.4rem; }
input, select, textarea { width: 100%; box-sizing: border-box; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
textarea { resize: vertical; }

/* Date, Time, Timezone fields share an exact height so the row reads as a pair */
.date-field, .tz-select, .time-field { box-sizing: border-box; width: 100%; height: 2.65rem; padding: 0 0.85rem; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; font: inherit; font-variant-numeric: tabular-nums; }
.date-field { text-align: left; cursor: pointer; display: flex; align-items: center; }
.date-field:hover { border-color: #3a456b; }
.tz-select { padding: 0 0.85rem; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='%239fb0d8' d='M6 8.5L2 4.5h8z'/></svg>"); background-repeat: no-repeat; background-position: right 0.7rem center; padding-right: 2rem; }
.time-field::-webkit-calendar-picker-indicator { filter: invert(0.7); cursor: pointer; }
/* Visually hidden but reachable by .showPicker() / focus */
.date-native { position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px; overflow: hidden; }

.row { display: flex; justify-content: space-between; gap: 0.75rem; }
.row.two { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }

/* Timezone + "Show world timezones" toggle row */
.tz-row { display: flex; align-items: flex-end; gap: 0.75rem; }
.tz-field { flex: 1; min-width: 0; }
.map-toggle { flex-shrink: 0; height: 2.65rem; padding: 0 0.9rem; background: transparent; border: 1px solid #2a3350; color: #7aa2ff; border-radius: 10px; font-size: 0.82rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.map-toggle:hover { border-color: #4f7cff; background: #131a30; }

/* Driving Question — the heart of the session, given its own card */
.dq-card { background: linear-gradient(180deg, #131a30 0%, #0e1428 100%); border: 1px solid #3a456b; border-radius: 14px; padding: 1.4rem 1.5rem 1.5rem; box-shadow: 0 0 0 1px rgba(79, 124, 255, 0.08), 0 12px 32px rgba(0, 0, 0, 0.35); display: grid; gap: 0.7rem; margin: 0.4rem 0; }
.dq-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.dq-title { margin: 0; font-size: 1.25rem; font-weight: 600; color: #e6ecff; letter-spacing: 0.01em; }
.dq-sub { margin: 0; color: #9fb0d8; font-size: 0.88rem; line-height: 1.5; }
.dq-textarea { width: 100%; box-sizing: border-box; min-height: 7.5rem; padding: 0.9rem 1rem; background: #0a0d18; border: 1px solid #2a3350; color: #e6ecff; border-radius: 10px; font: inherit; font-size: 1.02rem; line-height: 1.55; resize: vertical; transition: border-color 0.15s, box-shadow 0.15s; }
.dq-textarea:focus { outline: none; border-color: #4f7cff; box-shadow: 0 0 0 1px rgba(79, 124, 255, 0.35); }
.dq-examples-btn { background: transparent; border: 1px solid #2a3350; color: #7aa2ff; padding: 0.35rem 0.7rem; border-radius: 8px; font-size: 0.78rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.dq-examples-btn:hover { border-color: #4f7cff; background: rgba(79, 124, 255, 0.08); }

/* Collapsible map + slider block */
.map-block { display: grid; gap: 0.7rem; justify-items: center; text-align: center; background: #0c0f18; border: 1px solid #1a2138; border-radius: 12px; padding: 1rem; }
.map-block .time-slider, .map-block .time-ticks { width: 100%; }
.big-time { display: inline-flex; align-items: baseline; gap: 0.4rem; font-variant-numeric: tabular-nums; }
.big-time-hm { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 2.4rem; font-weight: 600; color: #cdd6f4; letter-spacing: -0.02em; text-shadow: 0 0 20px rgba(79, 124, 255, 0.25); line-height: 1; }
.big-time-period { font-size: 1rem; color: #7aa2ff; font-weight: 500; letter-spacing: 0.05em; }

.time-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 999px; background: linear-gradient(90deg, #1a2138, #2d3f6e 50%, #1a2138); border: 1px solid #2a3350; outline: none; padding: 0; }
.time-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #7aa2ff; border: 2px solid #11162a; cursor: pointer; box-shadow: 0 0 12px rgba(122, 160, 255, 0.5); transition: transform 0.1s; }
.time-slider::-webkit-slider-thumb:hover { transform: scale(1.1); }
.time-slider::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #7aa2ff; border: 2px solid #11162a; cursor: pointer; box-shadow: 0 0 12px rgba(122, 160, 255, 0.5); }
.time-ticks { display: flex; justify-content: space-between; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: #6f7c98; padding: 0 4px; }

button { font: inherit; border-radius: 10px; padding: 0.7rem 1.2rem; cursor: pointer; border: 1px solid transparent; }
.primary { background: #4f7cff; color: #fff; }
.primary:disabled { opacity: 0.5; cursor: default; }
.ghost { background: transparent; border-color: #2a3350; color: #cdd6f4; }
.error { color: #e06c75; margin: 0; }

/* Shape cards (compact) + live preview */
.shapes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
.shape-card { background: #11162a; border: 1px solid #2a3350; color: #cdd6f4; padding: 0.7rem 0.8rem; text-align: left; transition: opacity 0.15s, border-color 0.15s, transform 0.15s; opacity: 0.45; }
.shape-card.selected { opacity: 1; border-color: #4f7cff; transform: translateY(-1px); box-shadow: 0 0 0 1px rgba(79,124,255,0.3); }
.shape-card:hover { opacity: 0.85; }
.shape-card.selected:hover { opacity: 1; }
.shape-name { font-weight: 600; text-transform: capitalize; margin-bottom: 0.2rem; }
.shape-stats { font-size: 0.78rem; color: #9fb0d8; line-height: 1.4; }
.shape-preview { margin-top: 0.6rem; height: clamp(260px, 40vh, 380px); background: #0c0f18; border: 1px solid #1a2138; border-radius: 12px; overflow: hidden; }

/* Label row with action button (e.g. "+ Create new experimental") */
.lbl-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; gap: 0.5rem; }
.lbl-row .lbl { margin-bottom: 0; }
.new-format-btn { background: transparent; border: 1px solid #2a3350; color: #7aa2ff; padding: 0.35rem 0.7rem; border-radius: 8px; font-size: 0.78rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.new-format-btn:hover { border-color: #4f7cff; background: #131a30; }

/* Format dropdown + info pane */
.format-info { margin-top: 0.6rem; background: #11162a; border: 1px solid #2a3350; border-radius: 10px; padding: 0.9rem 1rem; }
.format-meta { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
.provenance { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
.prov-canonical-beer .provenance { background: #1a3a2a; color: #8be8a8; }
.prov-canonical-truss .provenance { background: #1a2f3a; color: #8bc4e8; }
.prov-experimental .provenance { background: #3a2f1a; color: #e8c48b; }
.format-desc { font-size: 0.88rem; color: #cdd6f4; line-height: 1.5; margin: 0; }
.caveats { margin: 0.6rem 0 0; padding-left: 1.1rem; font-size: 0.78rem; color: #6f7c98; }
.caveats li { margin: 0.15rem 0; }

/* Timetable */
.timetable { background: #0c0f18; border: 1px solid #2a3350; border-radius: 10px; overflow: hidden; }
.t-row { padding: 0.6rem 0.9rem; border-bottom: 1px solid #1a2138; }
.t-row:last-of-type { border-bottom: none; }
.t-main { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.t-label { color: #e6ecff; }
.t-mins { color: #9fb0d8; font-variant-numeric: tabular-nums; }
.t-sub { font-size: 0.78rem; color: #6f7c98; margin-top: 0.2rem; }
.t-total { display: flex; justify-content: space-between; padding: 0.7rem 0.9rem; background: #11162a; color: #e6ecff; font-weight: 600; border-top: 1px solid #2a3350; }

/* Outcome Resolve grid (rows = time slots, cols = parallel meetings) */
.or-row { background: #0a0d16; }
.or-iters { display: grid; gap: 0.6rem; margin-top: 0.6rem; }
.or-iter-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #7aa2ff; margin-bottom: 0.3rem; }
.or-grid { display: grid; gap: 4px; align-items: stretch; }
.or-slot-label { font-size: 0.72rem; color: #6f7c98; padding: 0.55rem 0.5rem 0 0; align-self: start; font-variant-numeric: tabular-nums; }
.or-cell { background: #1a2138; border: 1px solid #2a3350; border-radius: 6px; padding: 0.5rem 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
.or-cell-head { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.or-cell-main { font-size: 0.82rem; color: #cdd6f4; line-height: 1.1; }
.or-cell-sub { font-size: 0.62rem; color: #6f7c98; line-height: 1.1; }
.or-cell-foot { font-size: 0.65rem; color: #6f7c98; text-align: center; }
.or-cell.empty { background: transparent; border-style: dashed; border-color: #1a2138; }
.or-break { font-size: 0.75rem; color: #6f7c98; padding: 0.4rem 0; text-align: center; border-top: 1px dashed #1a2138; margin-top: 0.4rem; }

/* People badges */
.people { display: flex; flex-wrap: wrap; gap: 3px; justify-content: center; align-items: center; }
.pid { display: inline-flex; align-items: center; justify-content: center; min-width: 1.4em; height: 1.4em; padding: 0 0.3em; border-radius: 999px; font-size: 0.65rem; font-variant-numeric: tabular-nums; line-height: 1; }
.pid.member { background: #2d3f6e; color: #e6ecff; }
.pid.critic { background: transparent; color: #9fb0d8; border: 1px solid #3a456b; }
.pid.idle { background: transparent; color: #6f7c98; border: 1px dashed #2a3350; }
.pid.sm { font-size: 0.6rem; min-width: 1.2em; height: 1.2em; }
.pid-sep { color: #3a456b; font-weight: 700; }

/* Idle column (right side of each slot row) */
.or-idle { padding: 0.5rem 0 0.5rem 0.6rem; border-left: 1px dashed #1a2138; min-width: 110px; display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start; }
.or-idle.none { opacity: 0.6; }
.or-idle-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6f7c98; }
.or-idle-label.all-in { color: #8be8a8; }
.people.idle { gap: 2px; }

/* Legend */
.or-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.6rem; font-size: 0.72rem; color: #9fb0d8; }
.legend-sep { color: #3a456b; }
.legend-note { color: #6f7c98; flex-basis: 100%; margin-top: 0.2rem; }

/* New-format dialog */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: grid; place-items: center; z-index: 200; padding: 1rem; }
.modal-inner { background: #11162a; border: 1px solid #2a3350; border-radius: 12px; padding: 1.4rem 1.5rem; width: min(440px, 100%); display: grid; gap: 0.6rem; max-height: 90vh; overflow-y: auto; }
.modal-inner.wide { width: min(760px, 100%); }
.modal-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.modal-header h3 { margin: 0; }
.modal-close { background: transparent; border: none; color: #9fb0d8; font-size: 1.1rem; cursor: pointer; padding: 0.2rem 0.5rem; border-radius: 6px; }
.modal-close:hover { background: #1a2138; color: #fff; }
.modal-sub { color: #9fb0d8; margin: 0 0 0.6rem; font-size: 0.9rem; line-height: 1.5; }
.modal-row { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.6rem; }

.steps { margin: 0; padding-left: 1.2rem; display: grid; gap: 1rem; color: #cdd6f4; font-size: 0.92rem; line-height: 1.55; }
.steps li::marker { color: #7aa2ff; font-weight: 600; }
.steps code { background: #0c0f18; border: 1px solid #2a3350; padding: 0.05rem 0.4rem; border-radius: 4px; font-size: 0.85em; color: #e6ecff; }

.code-wrap { position: relative; margin-top: 0.6rem; }
.code-block { background: #0a0d16; border: 1px solid #2a3350; border-radius: 8px; padding: 0.9rem 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.74rem; line-height: 1.5; color: #cdd6f4; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
.copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; background: #1a2138; border: 1px solid #2a3350; color: #cdd6f4; padding: 0.3rem 0.7rem; border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.copy-btn:hover { border-color: #4f7cff; background: #131a30; }

.submit-options { margin: 0.4rem 0 0; padding-left: 1.1rem; display: grid; gap: 0.35rem; }
.submit-options li { color: #cdd6f4; }
.submit-options a { color: #7aa2ff; }

/* Tooltip (mirrors 1-Initiate.vue) */
.info-wrap { position: relative; display: inline-flex; vertical-align: middle; margin-left: 0.25rem; }
.info { background: none; border: none; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
.tooltip { position: absolute; left: 0; top: calc(100% + 8px); width: min(340px, 80vw); background: #1c2233; border: 1px solid #3a456b; border-radius: 12px; padding: 0.8rem 1rem; z-index: 100; box-shadow: 0 16px 40px rgba(0,0,0,.6); }
.tt-title { display: block; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0d8; margin-bottom: 0.45rem; }
.tooltip ul { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; color: #eef2ff; }
.tooltip li { margin: 0.25rem 0; }
</style>
