/**
 * Session formats — recipes for complete Syntegrity events.
 *
 * A `SessionFormat` is a named, sharable schedule: which shape, which stages in
 * which order, how long each lasts, and the structural choices inside the
 * Outcome Resolve (iterations, slot count, critic handling). This module owns
 * the *structure* of an event; the scheduler in `7-scheduler.ts` owns the
 * conflict-free packing of meetings inside a single Outcome Resolve stage.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMINOLOGY (from Beer / Truss / the existing scheduler)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Stage       — top-level event segment, e.g. Problem Jostle, Outcome Resolve.
 *                 Maps to Beer's numbered stages 0–8.
 *   Iteration   — one pass through ALL teams within Outcome Resolve. Canon = 3.
 *                 Beer's word. ("The three-iteration rhythm of the Outcome
 *                 Resolve must be preserved in any variant." — digital mapping
 *                 doc.) The three canonical intents are: explore → sharpen →
 *                 refine (a.k.a. status-quo → ideal → actions).
 *   Slot        — a wall-clock block within an iteration holding 1+ concurrent
 *                 team meetings. Already named `ScheduleSlot` in the scheduler.
 *                 (We colloquially call these "rounds" in conversation; this
 *                 module sticks to "slot" to match the code.)
 *   Meeting     — one team's session in one slot in one iteration
 *                 (`MeetingSession`).
 *   Reverberation — Beer's word for cross-team idea migration. Used here as a
 *                   dedicated final stage that surfaces the migration explicitly
 *                   (LLM synthesis + team report-backs); not in Beer's original
 *                   protocol but Beer-aligned in spirit.
 *
 * Critic policy is the main new axis this module exposes that the scheduler
 * doesn't yet vary: today the scheduler always treats critics as full in-room
 * attendees (Beer canon). The other policies here are aspirational and need
 * scheduler support to actually run, but the formats can already be authored.
 */

import type { ShapeName } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Stages
// ─────────────────────────────────────────────────────────────────────────────

export type StageKind =
  | 'opening'            // welcome / lobby fill / brief
  | 'problem-jostle'     // Beer Stage 2 — statement generation + clustering
  | 'voting'             // Beer Stage 3 — narrow to N topics
  | 'topic-preference'   // Beer Stage 4a — rank topics
  | 'graph-reveal'       // Beer Stage 4b — see your roles + schedule
  | 'outcome-resolve'    // Beer Stage 5 — the team meetings
  | 'between-iteration'  // Beer Stage 5b — public statement wall + graffiti
  | 'reverberation'      // NEW — LLM synthesis + team report-backs
  | 'closing-plenary'    // Beer Stage 6 — full-group statement gallery
  | 'face-planning'      // Beer Stage 7 — Truss's triangular-face action plans
  | 'break'              // mandatory rest / meal
  | 'custom';

interface StageBase {
  id: string;
  kind: StageKind;
  label: string;
  minutes: number;
}

export interface AppStage extends StageBase {
  kind:
    | 'opening'
    | 'problem-jostle'
    | 'voting'
    | 'topic-preference'
    | 'graph-reveal'
    | 'closing-plenary'
    | 'face-planning';
}

export interface OutcomeResolveStage extends StageBase {
  kind: 'outcome-resolve';
  /** Number of passes through all teams. Canon = 3. Compressed variants may use 1–2. */
  iterations: number;
  /**
   * Wall-clock blocks per iteration. Each block holds 1+ concurrent team meetings,
   * conflict-free per the scheduler. Computed by the scheduler from shape +
   * criticPolicy; given here explicitly so formats are self-documenting.
   */
  slotsPerIteration: number;
  /** Minutes per slot. */
  slotMinutes: number;
  /**
   * Optional per-iteration framing. Defaults to CANONICAL_ITERATION_INTENTS
   * when iterations === 3.
   */
  iterationIntents?: string[];
  /**
   * Default = shape.topicCount. Lower drops the lowest-voted topics from
   * Outcome Resolve entirely (the format's caveat should call this out).
   */
  topicsCovered?: number;
  /**
   * How critics participate. Only `all-critics-in-room` is honored by the
   * current scheduler; other values describe an authored intent and need
   * scheduler support to run.
   *
   *  - all-critics-in-room   Every critic of T attends T's meeting and gets a
   *                          designated critique window. Beer canon. Scheduler
   *                          counts critics as attendees, so concurrency may
   *                          drop (e.g. octahedron forces sequential).
   *  - split-critics-in-room Critics distribute themselves across parallel
   *                          meetings they are qualified for, reducing per-room
   *                          critic count but keeping everyone active. (Our
   *                          octahedron-with-parallel-pairs pattern.)
   *  - async-notes-only      Critics never join the meeting; they write notes
   *                          on the public wall between iterations.
   *  - no-critics            Contributors-only meetings. Strictly off-protocol.
   */
  criticPolicy:
    | 'all-critics-in-room'
    | 'split-critics-in-room'
    | 'async-notes-only'
    | 'no-critics';
  /** Break inserted between iterations within this stage's minute budget. */
  betweenIterationBreakMinutes?: number;
}

export interface ReverberationStage extends StageBase {
  kind: 'reverberation';
  parts: {
    llmSynthesisMinutes: number;
    teamReportbackMinutes: number;
    groupConvergenceMinutes: number;
  };
  transcriptSource: 'zoom-cloud' | 'per-breakout-recorder' | 'manual-scribe';
}

export interface BetweenIterationStage extends StageBase {
  kind: 'between-iteration';
  /** Whether participants can post lightweight reactions on the public wall. */
  graffitiEnabled: boolean;
  /**
   * Optional: structured critique meetings during the break. The 4 critics for
   * each active topic gather (often in parallel) to produce critique notes that
   * iter-2 contributors will read.
   *
   * For the octahedron, parallelism is constrained by critic-set overlap:
   * critics of opposite topics are the same 4 people, so opposite topics'
   * critique meetings cannot run in the same slot. All 6 topics fit in
   * 2 slots × 3 parallel; 4 topics (one opposite pair dropped) fit in
   * 2 slots × 2 parallel.
   */
  criticMeetings?: {
    slots: number;
    slotMinutes: number;
  };
}

export interface BreakStage extends StageBase {
  kind: 'break';
}

export interface CustomStage extends StageBase {
  kind: 'custom';
  notes: string;
}

export type Stage =
  | AppStage
  | OutcomeResolveStage
  | ReverberationStage
  | BetweenIterationStage
  | BreakStage
  | CustomStage;

// ─────────────────────────────────────────────────────────────────────────────
// Formats
// ─────────────────────────────────────────────────────────────────────────────

export type FormatProvenance =
  | 'canonical-beer'   // Beer's original protocol
  | 'canonical-truss'  // Truss's ShortForms (smaller shapes)
  | 'experimental';    // designed in the prototype, not (yet) validated in literature

export interface SessionFormat {
  id: string;
  name: string;
  description: string;
  provenance: FormatProvenance;
  shape: ShapeName;
  /** Sum of stage minutes; validated by validateFormat(). */
  totalMinutes: number;
  stages: Stage[];
  /** Caveats / departures from canon, surfaced in any UI that uses the format. */
  caveats?: string[];
}

export const CANONICAL_ITERATION_INTENTS = [
  'Status quo / explore',
  'Ideal / what is reverberating',
  'Actions / refine',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

export function sumStageMinutes(format: SessionFormat): number {
  return format.stages.reduce((acc, s) => acc + s.minutes, 0);
}

export interface FormatValidationIssue {
  kind:
    | 'minute-mismatch'
    | 'outcome-resolve-budget'
    | 'reverberation-budget'
    | 'critic-meeting-budget'
    | 'iteration-count';
  detail: string;
}

/**
 * Cheap structural checks. Does not consult the geometry (that's a job for the
 * scheduler at runtime); only enforces internal arithmetic and Beer-canon hints.
 */
export function validateFormat(format: SessionFormat): FormatValidationIssue[] {
  const issues: FormatValidationIssue[] = [];

  const sum = sumStageMinutes(format);
  if (sum !== format.totalMinutes) {
    issues.push({
      kind: 'minute-mismatch',
      detail: `totalMinutes=${format.totalMinutes} but stages sum to ${sum}`,
    });
  }

  for (const stage of format.stages) {
    if (stage.kind === 'outcome-resolve') {
      const meetingMinutes = stage.iterations * stage.slotsPerIteration * stage.slotMinutes;
      const breakMinutes = (stage.iterations - 1) * (stage.betweenIterationBreakMinutes ?? 0);
      const required = meetingMinutes + breakMinutes;
      if (stage.minutes < required) {
        issues.push({
          kind: 'outcome-resolve-budget',
          detail: `outcome-resolve stage "${stage.id}" allocates ${stage.minutes} min but needs ${required} (= ${stage.iterations}×${stage.slotsPerIteration}×${stage.slotMinutes} + breaks)`,
        });
      }
      if (format.provenance === 'canonical-beer' && stage.iterations !== 3) {
        issues.push({
          kind: 'iteration-count',
          detail: `canonical-beer format "${format.id}" uses ${stage.iterations} iterations; Beer canon is 3`,
        });
      }
    }
    if (stage.kind === 'reverberation') {
      const partsSum =
        stage.parts.llmSynthesisMinutes +
        stage.parts.teamReportbackMinutes +
        stage.parts.groupConvergenceMinutes;
      if (partsSum !== stage.minutes) {
        issues.push({
          kind: 'reverberation-budget',
          detail: `reverberation stage "${stage.id}" minutes=${stage.minutes} but parts sum to ${partsSum}`,
        });
      }
    }
    if (stage.kind === 'between-iteration' && stage.criticMeetings) {
      const required = stage.criticMeetings.slots * stage.criticMeetings.slotMinutes;
      if (stage.minutes < required) {
        issues.push({
          kind: 'critic-meeting-budget',
          detail: `between-iteration stage "${stage.id}" allocates ${stage.minutes} min but critique meetings need ${required} (= ${stage.criticMeetings.slots}×${stage.criticMeetings.slotMinutes})`,
        });
      }
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical formats — one per implemented shape (tetrahedron, octahedron, icosahedron)
// ─────────────────────────────────────────────────────────────────────────────
//
// Times for the canonical formats are nominal. Real Beer events run across
// multiple days with substantial flex for meals, breaks, walking-around time,
// and Face Planning. These recipes capture the *structural* canon (3 iterations,
// all critics in room, all topics covered) at a defensible meeting length per
// shape.

export const CANONICAL_TETRAHEDRON: SessionFormat = {
  id: 'canonical-tetrahedron',
  name: 'Canonical Tetrahedron (Truss ShortForm)',
  description:
    '6 people, 4 topics, teams of 3. Smallest workable form. Every team contains all 6 people, so meetings are strictly sequential. Reverberation cycles fast — ideas can over-echo on this shape.',
  provenance: 'canonical-truss',
  shape: 'tetrahedron',
  totalMinutes: 780, // 13 hours of scheduled activity; fits 1 long day or 1.5 short days
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 20 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 60 },
    { id: 'vote', kind: 'voting', label: 'Voting (top 4)', minutes: 20 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 15 },
    { id: 'graph', kind: 'graph-reveal', label: 'Role assignment + Graph reveal', minutes: 20 },
    { id: 'break-1', kind: 'break', label: 'Break', minutes: 30 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 3 iterations × 4 sequential meetings × 45 min',
      minutes: 3 * 4 * 45 + 2 * 20, // = 580
      iterations: 3,
      slotsPerIteration: 4,
      slotMinutes: 45,
      iterationIntents: [...CANONICAL_ITERATION_INTENTS],
      criticPolicy: 'all-critics-in-room',
      betweenIterationBreakMinutes: 20,
    },
    { id: 'plenary', kind: 'closing-plenary', label: 'Closing Plenary', minutes: 35 },
  ],
  caveats: [
    'Tetrahedron forces concurrency 1 (every team has all 6 people).',
    'Teams of 3 leave little room for disagreement; reverberation can repeat.',
  ],
};

export const CANONICAL_OCTAHEDRON: SessionFormat = {
  id: 'canonical-octahedron',
  name: 'Canonical Octahedron (Truss ShortForm)',
  description:
    '12 people, 6 topics, teams of 4. With critics in-room, each meeting has 8 attendees — sequential only. "A 2-day event works comfortably" (Leonard).',
  provenance: 'canonical-truss',
  shape: 'octahedron',
  totalMinutes: 1420, // ~24 hours of scheduled activity over 2 days
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 30 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 90 },
    { id: 'vote', kind: 'voting', label: 'Voting (top 6)', minutes: 30 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 20 },
    { id: 'graph', kind: 'graph-reveal', label: 'Role assignment + Graph reveal', minutes: 30 },
    { id: 'break-1', kind: 'break', label: 'Break', minutes: 30 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 3 iterations × 6 sequential meetings × 60 min',
      minutes: 3 * 6 * 60 + 2 * 30, // = 1140
      iterations: 3,
      slotsPerIteration: 6,
      slotMinutes: 60,
      iterationIntents: [...CANONICAL_ITERATION_INTENTS],
      criticPolicy: 'all-critics-in-room',
      betweenIterationBreakMinutes: 30,
    },
    { id: 'plenary', kind: 'closing-plenary', label: 'Closing Plenary', minutes: 50 },
  ],
  caveats: [
    'All-critics-in-room on octahedron forces sequential meetings (8 attendees per topic, 12 people total).',
    'Two-day event in practice; the 1020-minute total assumes substantial overnight rest is taken outside the format.',
  ],
};

export const CANONICAL_ICOSAHEDRON: SessionFormat = {
  id: 'canonical-icosahedron',
  name: 'Canonical Icosahedron (Beer original)',
  description:
    "Beer's canonical form. 30 people, 12 topics, teams of 5. Non-adjacent topics meet in parallel (concurrency 2). 90-min team meetings — the gold standard.",
  provenance: 'canonical-beer',
  shape: 'icosahedron',
  totalMinutes: 2400, // 40 hours of scheduled activity — a 5-day event at 8 hrs/day
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 60 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 180 },
    { id: 'vote', kind: 'voting', label: 'Voting (top 12)', minutes: 45 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 30 },
    { id: 'graph', kind: 'graph-reveal', label: 'Role assignment + Graph reveal', minutes: 45 },
    { id: 'break-1', kind: 'break', label: 'Break', minutes: 60 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 3 iterations × 6 parallel-pair slots × 90 min',
      minutes: 3 * 6 * 90 + 2 * 60, // = 1740
      iterations: 3,
      slotsPerIteration: 6,
      slotMinutes: 90,
      iterationIntents: [...CANONICAL_ITERATION_INTENTS],
      criticPolicy: 'all-critics-in-room',
      betweenIterationBreakMinutes: 60,
    },
    { id: 'plenary', kind: 'closing-plenary', label: 'Closing Plenary', minutes: 90 },
    { id: 'face-planning', kind: 'face-planning', label: 'Face Planning (Truss, optional)', minutes: 150 },
  ],
  caveats: [
    'Real Beer events run 3–5 days with substantial walking-around, meals, and reflection time outside this minute budget.',
    'Face Planning is optional but standard; remove the stage to skip.',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Experimental formats — octahedron and tetrahedron variants designed in the prototype
// ─────────────────────────────────────────────────────────────────────────────
//
// All compress Beer's protocol to a single hour-scale session. Each sacrifices
// something specific from canon; the caveats spell it out. Tetrahedron variants
// are strictly sequential (every meeting overlaps in members), so they use
// all-critics-in-room to keep all 6 participants active in every meeting.

export const COMPACT_60_OCTAHEDRON: SessionFormat = {
  id: 'compact-60-octa',
  name: 'Compact 60 (Octahedron)',
  description:
    '60-minute Syntegrity in a single sitting. 1 iteration, 3 slots × 10 min, all 6 topics covered via opposite-vertex parallel pairs. Critics split 2/2 across parallel rooms so nobody is idle.',
  provenance: 'experimental',
  shape: 'octahedron',
  totalMinutes: 60,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 10 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 5 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 2 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 3 parallel-pair slots × 10 min',
      minutes: 30,
      iterations: 1,
      slotsPerIteration: 3,
      slotMinutes: 10,
      criticPolicy: 'split-critics-in-room',
    },
    { id: 'close', kind: 'custom', label: 'Close', minutes: 5, notes: 'One-sentence outcome per topic.' },
  ],
  caveats: [
    'Single iteration — breaks Beer\'s "three-iteration rhythm" rule.',
    '10 min per meeting is brutally tight; topics will be coarse.',
    'split-critics-in-room is not yet implemented in the scheduler.',
  ],
};

export const EXPERIMENTAL_2ROUND_60_OCTAHEDRON: SessionFormat = {
  id: 'experimental-2round-60-octa',
  name: 'Top four 60 (Octahedron)',
  description:
    '60 minutes, 2 slots × 20 min, parallel-pair meetings on 4 of 6 topics (drop the bottom two by vote). Everyone is active in both slots as contributor or critic.',
  provenance: 'experimental',
  shape: 'octahedron',
  totalMinutes: 60,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 8 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 3 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 2 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 2 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 2 parallel-pair slots × 20 min',
      minutes: 40,
      iterations: 1,
      slotsPerIteration: 2,
      slotMinutes: 20,
      topicsCovered: 4,
      criticPolicy: 'split-critics-in-room',
    },
  ],
  /**
   * Drop rule: bottom-two votes cut. Voting still selects all 6 topics (needed
   * to position people around the polyhedron's vertices), but only the top 4
   * by vote actually receive team meetings. The format-bullets generator emits
   * this whenever topicsCovered < shape.topicCount.
   */
  caveats: [
    'Single iteration — no Beer "three-iteration rhythm".',
  ],
};

export const REVERBERATION_120_OCTAHEDRON: SessionFormat = {
  id: 'reverberation-120-octa',
  name: 'Reverberation 120 (Octahedron)',
  description:
    'Today\'s landed format. 2 hours total. 3 slots × 20 min covers all 6 topics in parallel pairs, then a dedicated 30-min Reverberation stage: LLM-surfaced insights, team report-backs, and one converged thread.',
  provenance: 'experimental',
  shape: 'octahedron',
  totalMinutes: 120,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 10 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 4 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 3 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 3 parallel-pair slots × 20 min',
      minutes: 60,
      iterations: 1,
      slotsPerIteration: 3,
      slotMinutes: 20,
      criticPolicy: 'split-critics-in-room',
    },
    { id: 'regroup', kind: 'custom', label: 'Regroup in Zoom main', minutes: 5, notes: 'Move out of breakouts; LLM synthesis already running on transcripts.' },
    {
      id: 'reverberation',
      kind: 'reverberation',
      label: 'Reverberation',
      minutes: 30,
      parts: { llmSynthesisMinutes: 10, teamReportbackMinutes: 15, groupConvergenceMinutes: 5 },
      transcriptSource: 'zoom-cloud',
    },
  ],
  caveats: [
    'Single iteration — no Beer "three-iteration rhythm".',
    'split-critics-in-room is not yet implemented in the scheduler.',
    'Reverberation requires a transcript pipeline (Zoom cloud or per-breakout recorder).',
  ],
};

export const COMPACT_60_TETRAHEDRON: SessionFormat = {
  id: 'compact-60-tetra',
  name: 'Compact 60 (Tetrahedron)',
  description:
    '60-minute Syntegrity for 6 people. 1 iteration × 4 sequential meetings × 8 min covers all 4 topics. Tetrahedron meetings always include everyone (3 contributors + 3 critics), so nobody is idle.',
  provenance: 'experimental',
  shape: 'tetrahedron',
  totalMinutes: 60,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 10 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 5 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 2 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 4 sequential meetings × 8 min',
      minutes: 32,
      iterations: 1,
      slotsPerIteration: 4,
      slotMinutes: 8,
      criticPolicy: 'all-critics-in-room',
    },
    { id: 'close', kind: 'custom', label: 'Close', minutes: 3, notes: 'One-sentence outcome per topic.' },
  ],
  caveats: [
    'Single iteration — breaks Beer\'s "three-iteration rhythm" rule.',
    '8 min per meeting is brutally tight; topics will be coarse.',
  ],
};

export const EXPERIMENTAL_TOP3_60_TETRAHEDRON: SessionFormat = {
  id: 'experimental-top3-60-tetra',
  name: 'Top three 60 (Tetrahedron)',
  description:
    '60 minutes for 6 people. 1 iteration × 3 sequential meetings × 12 min on the top 3 voted topics (the lowest-voted topic is dropped from Outcome Resolve). All 6 participants in every meeting.',
  provenance: 'experimental',
  shape: 'tetrahedron',
  totalMinutes: 60,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 10 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 4 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 2 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 3 sequential meetings × 12 min',
      minutes: 36,
      iterations: 1,
      slotsPerIteration: 3,
      slotMinutes: 12,
      topicsCovered: 3,
      criticPolicy: 'all-critics-in-room',
    },
  ],
  /**
   * Drop rule: lowest-voted topic cut. Voting still selects all 4 topics
   * (needed to position people around the tetrahedron's vertices), but only the
   * top 3 by vote actually receive team meetings. The format-bullets generator
   * emits this whenever topicsCovered < shape.topicCount.
   */
  caveats: [
    'Single iteration — no Beer "three-iteration rhythm".',
  ],
};

export const REVERBERATION_120_TETRAHEDRON: SessionFormat = {
  id: 'reverberation-120-tetra',
  name: 'Reverberation 120 (Tetrahedron)',
  description:
    '2 hours for 6 people. 1 iteration × 4 sequential meetings × 15 min covers all 4 topics, then a dedicated 30-min Reverberation stage: LLM-surfaced insights, team report-backs, and one converged thread.',
  provenance: 'experimental',
  shape: 'tetrahedron',
  totalMinutes: 120,
  stages: [
    { id: 'opening', kind: 'opening', label: 'Opening + lobby', minutes: 5 },
    { id: 'jostle', kind: 'problem-jostle', label: 'Problem Jostle', minutes: 12 },
    { id: 'vote', kind: 'voting', label: 'Voting', minutes: 4 },
    { id: 'rank', kind: 'topic-preference', label: 'Topic Preference', minutes: 3 },
    { id: 'graph', kind: 'graph-reveal', label: 'Graph reveal', minutes: 3 },
    {
      id: 'resolve',
      kind: 'outcome-resolve',
      label: 'Team Meetings — 1 iteration × 4 sequential meetings × 15 min',
      minutes: 60,
      iterations: 1,
      slotsPerIteration: 4,
      slotMinutes: 15,
      criticPolicy: 'all-critics-in-room',
    },
    { id: 'regroup', kind: 'custom', label: 'Regroup in Zoom main', minutes: 3, notes: 'Move out of breakouts; LLM synthesis already running on transcripts.' },
    {
      id: 'reverberation',
      kind: 'reverberation',
      label: 'Reverberation',
      minutes: 30,
      parts: { llmSynthesisMinutes: 10, teamReportbackMinutes: 15, groupConvergenceMinutes: 5 },
      transcriptSource: 'zoom-cloud',
    },
  ],
  caveats: [
    'Single iteration — no Beer "three-iteration rhythm".',
    'Reverberation requires a transcript pipeline (Zoom cloud or per-breakout recorder).',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_FORMATS = {
  // Canonical (one per implemented shape)
  [CANONICAL_TETRAHEDRON.id]: CANONICAL_TETRAHEDRON,
  [CANONICAL_OCTAHEDRON.id]: CANONICAL_OCTAHEDRON,
  [CANONICAL_ICOSAHEDRON.id]: CANONICAL_ICOSAHEDRON,
  // Experimental octahedron variants
  [COMPACT_60_OCTAHEDRON.id]: COMPACT_60_OCTAHEDRON,
  [EXPERIMENTAL_2ROUND_60_OCTAHEDRON.id]: EXPERIMENTAL_2ROUND_60_OCTAHEDRON,
  [REVERBERATION_120_OCTAHEDRON.id]: REVERBERATION_120_OCTAHEDRON,
  // Experimental tetrahedron variants
  [COMPACT_60_TETRAHEDRON.id]: COMPACT_60_TETRAHEDRON,
  [EXPERIMENTAL_TOP3_60_TETRAHEDRON.id]: EXPERIMENTAL_TOP3_60_TETRAHEDRON,
  [REVERBERATION_120_TETRAHEDRON.id]: REVERBERATION_120_TETRAHEDRON,
} as const satisfies Record<string, SessionFormat>;

export type SessionFormatId = keyof typeof SESSION_FORMATS;

export function getFormat(id: SessionFormatId): SessionFormat {
  return SESSION_FORMATS[id];
}

export function listFormatsForShape(shape: ShapeName): SessionFormat[] {
  return Object.values(SESSION_FORMATS).filter((f) => f.shape === shape);
}
