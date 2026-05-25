/**
 * Timetable row builder shared between /schedule (creator preview) and
 * /scheduled/:code (invite page). Takes a SessionFormat + ShapeMeta and
 * returns an array of rows that can be rendered by SessionTimetable.vue.
 *
 * The "app opening" stages (lobby, jostle, voting, …) are bucketed into a
 * single short row so the eye lands on the Outcome Resolve block, which is
 * the structurally interesting bit.
 */
import type { Stage, SessionFormat } from './session-formats';
import type { ShapeMeta } from './geometry';

export interface StandardRow {
  kind: 'standard';
  id: string;
  label: string;
  minutes: number;
  sub?: string;
}

export interface Meeting {
  topic: number;       // 1-based topic index
  members: number[];   // 1-based participant ids
  critics: number[];
}

export interface SlotPlacement {
  meetings: Meeting[];
  idle: number[];
}

export interface OutcomeResolveRow {
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

export type TimetableRow = StandardRow | OutcomeResolveRow;

// Stages bundled into the "App opening" row — these are app-driven and
// short relative to Outcome Resolve, so we don't itemise them.
const APP_OPENING_KINDS = new Set(['opening', 'problem-jostle', 'voting', 'topic-preference', 'graph-reveal']);

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Build a synthetic but consistent placement of every participant across
 * iteration × slot × room. The real scheduler picks the conflict-free
 * assignment from the actual shape struts; this preview rotates participants
 * deterministically so the user can see *every person accounted for* in every
 * slot. Members are cycled, then critics are placed per criticPolicy.
 */
function buildOutcomePlacement(
  stage: Extract<Stage, { kind: 'outcome-resolve' }>,
  shapeMeta: ShapeMeta,
): { schedule: SlotPlacement[][]; concurrency: number } {
  const topicsCovered = stage.topicsCovered ?? shapeMeta.topicCount;
  const concurrency = Math.max(1, Math.ceil(topicsCovered / stage.slotsPerIteration));
  const total = shapeMeta.participantCount;
  const teamSize = shapeMeta.teamSize;

  const schedule: SlotPlacement[][] = [];
  for (let it = 0; it < stage.iterations; it++) {
    const slots: SlotPlacement[] = [];
    for (let s = 0; s < stage.slotsPerIteration; s++) {
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

export function buildTimetableRows(format: SessionFormat, shapeMeta: ShapeMeta): TimetableRow[] {
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
  for (const s of format.stages) {
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
