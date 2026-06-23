<script setup lang="ts">
/**
 * Shared "create a new experimental format" dialog.
 *
 * Drafting a new SessionFormat is a guided, LLM-assisted task: copy a context
 * block into Claude/ChatGPT, discuss, then submit the resulting object via PR
 * or email. The same flow is offered from /schedule (ScheduleCreate.vue) and
 * from the lobby format picker (3-LobbyFormatPanel.vue), so the dialog — and
 * especially the long context prompt that must stay in sync with the data
 * model — lives here once.
 *
 * Teleported to <body>: the lobby picker is a transformed (centered) overlay,
 * and a transformed ancestor reparents `position: fixed` descendants to itself.
 * Teleporting escapes that so this modal always covers the full viewport.
 */
import { ref } from 'vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

function close(): void { emit('update:open', false); }

const promptCopied = ref(false);

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
      label: 'Team Meetings — 1 iteration × 3 parallel-pair slots × 20 min',
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
    // ignore — the <pre> is selectable so users can fall back to manual copy
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="nfd-modal" @click.self="close">
      <div class="nfd-inner">
        <header class="nfd-header">
          <h3>Create a new experimental format</h3>
          <button class="nfd-close" @click="close" aria-label="Close">✕</button>
        </header>
        <p class="nfd-sub">Draft a new format with the LLM of your choice (Claude, ChatGPT, etc.), then submit it back so it can appear in the format dropdown.</p>

        <ol class="nfd-steps">
          <li>
            <strong>Copy the context block below</strong> and paste it into a fresh chat with your LLM.
            <div class="nfd-code-wrap">
              <button class="nfd-copy-btn" type="button" @click="copyPrompt">
                {{ promptCopied ? 'Copied!' : 'Copy prompt' }}
              </button>
              <pre class="nfd-code-block" v-text="LLM_CONTEXT_PROMPT"></pre>
            </div>
          </li>
          <li>
            <strong>Discuss the format with the LLM.</strong> It will ask about your goal (compression, depth, Beer-faithfulness, novel critic dynamic), the wall-clock time you have, the shape, and whether reverberation or breaks belong. When it has enough, it will draft a <code>SessionFormat</code> object.
          </li>
          <li>
            <strong>Submit your draft</strong> one of two ways:
            <ul class="nfd-submit-options">
              <li>Open a pull request that adds your new <code>SessionFormat</code> to <code>src/util/session-formats.ts</code> and registers it in <code>SESSION_FORMATS</code>.</li>
              <li>Or email the format (the full TypeScript object) to <a href="mailto:ian@sunriselabs.io?subject=New%20Syntegrity%20experimental%20format">ian@sunriselabs.io</a>.</li>
            </ul>
          </li>
        </ol>

        <div class="nfd-row">
          <button class="nfd-primary" @click="close">Got it</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.nfd-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: grid; place-items: center; z-index: 300; padding: 1rem; }
.nfd-inner { background: #11162a; border: 1px solid #2a3350; border-radius: 12px; padding: 1.4rem 1.5rem; width: min(760px, 100%); display: grid; gap: 0.6rem; max-height: 90vh; overflow-y: auto; color: #e6ecff; }
.nfd-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.nfd-header h3 { margin: 0; }
.nfd-close { background: transparent; border: none; color: #9fb0d8; font-size: 1.1rem; cursor: pointer; padding: 0.2rem 0.5rem; border-radius: 6px; }
.nfd-close:hover { background: #1a2138; color: #fff; }
.nfd-sub { color: #9fb0d8; margin: 0 0 0.6rem; font-size: 0.9rem; line-height: 1.5; }
.nfd-row { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.6rem; }
.nfd-primary { background: #4f7cff; color: #fff; font: inherit; border: 1px solid transparent; border-radius: 10px; padding: 0.7rem 1.2rem; cursor: pointer; }

.nfd-steps { margin: 0; padding-left: 1.2rem; display: grid; gap: 1rem; color: #cdd6f4; font-size: 0.92rem; line-height: 1.55; }
.nfd-steps li::marker { color: #7aa2ff; font-weight: 600; }
.nfd-steps code { background: #0c0f18; border: 1px solid #2a3350; padding: 0.05rem 0.4rem; border-radius: 4px; font-size: 0.85em; color: #e6ecff; }

.nfd-code-wrap { position: relative; margin-top: 0.6rem; }
.nfd-code-block { background: #0a0d16; border: 1px solid #2a3350; border-radius: 8px; padding: 0.9rem 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.74rem; line-height: 1.5; color: #cdd6f4; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
.nfd-copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; background: #1a2138; border: 1px solid #2a3350; color: #cdd6f4; padding: 0.3rem 0.7rem; border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.nfd-copy-btn:hover { border-color: #4f7cff; background: #131a30; }

.nfd-submit-options { margin: 0.4rem 0 0; padding-left: 1.1rem; display: grid; gap: 0.35rem; }
.nfd-submit-options li { color: #cdd6f4; }
.nfd-submit-options a { color: #7aa2ff; }
</style>
