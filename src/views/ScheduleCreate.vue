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
  getFormat, listFormatsForShape, type SessionFormat, type SessionFormatId,
} from '@/util/session-formats';
import { formatDuration } from '@/util/timetable';
import { useScheduleStore } from '@/stores/schedule';
import PolyhedronScene, { type SceneNode } from '@/components/PolyhedronScene.vue';
import FormatInfo from '@/components/FormatInfo.vue';
import SessionTimetable from '@/components/SessionTimetable.vue';
import NewExperimentalFormatDialog from '@/components/NewExperimentalFormatDialog.vue';
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
const showMap = ref(false);

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
          <FormatInfo :format="selectedFormat" class="format-info-spacing" />
        </div>

        <div>
          <label class="lbl">Timetable</label>
          <SessionTimetable :format="selectedFormat" />
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

    <!-- New experimental format dialog (shared with the lobby format picker) -->
    <NewExperimentalFormatDialog v-model:open="showNewFormatDialog" />
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

/* FormatInfo card sits flush under the format dropdown. */
.format-info-spacing { margin-top: 0.6rem; }

/* Tooltip (mirrors 1-Initiate.vue) */
.info-wrap { position: relative; display: inline-flex; vertical-align: middle; margin-left: 0.25rem; }
.info { background: none; border: none; cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
.tooltip { position: absolute; left: 0; top: calc(100% + 8px); width: min(340px, 80vw); background: #1c2233; border: 1px solid #3a456b; border-radius: 12px; padding: 0.8rem 1rem; z-index: 100; box-shadow: 0 16px 40px rgba(0,0,0,.6); }
.tt-title { display: block; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0d8; margin-bottom: 0.45rem; }
.tooltip ul { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; color: #eef2ff; }
.tooltip li { margin: 0.25rem 0; }
</style>
