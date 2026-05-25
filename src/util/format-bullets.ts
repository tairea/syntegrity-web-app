/**
 * Standardised "format info" bullets — one set of bullet templates shared
 * across every SessionFormat so the /schedule and /scheduled pages describe
 * each recipe in the same shape. The longform `description` field on the
 * format is intentionally NOT surfaced: structural facts go through these
 * bullets, free-form departures from canon live in `caveats[]`.
 */
import type { ShapeMeta } from './geometry';
import type { SessionFormat } from './session-formats';
import { formatDuration } from './timetable';

export interface FormatBullet {
  emoji: string;
  text: string;
}

type CriticPolicy =
  | 'all-critics-in-room'
  | 'split-critics-in-room'
  | 'async-notes-only'
  | 'no-critics';

const CRITIC_POLICY_LABEL: Record<CriticPolicy, string> = {
  'all-critics-in-room': 'every critic attends each meeting (Beer canon)',
  'split-critics-in-room': 'critics split across parallel rooms — everyone active',
  'async-notes-only': 'critics post notes between iterations, never in-room',
  'no-critics': 'contributors only (off-protocol)',
};

const CANONICAL_INTENTS = ['explore', 'sharpen', 'refine'];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildFormatBullets(format: SessionFormat, shape: ShapeMeta): FormatBullet[] {
  const bullets: FormatBullet[] = [];

  bullets.push({
    emoji: '🧩',
    text: `${capitalize(format.shape)} — ${shape.participantCount} people · ${shape.topicCount} topics · teams of ${shape.teamSize}`,
  });

  bullets.push({
    emoji: '⏱️',
    text: `Total length: ${formatDuration(format.totalMinutes)}`,
  });

  const or = format.stages.find((s) => s.kind === 'outcome-resolve');
  if (or && or.kind === 'outcome-resolve') {
    const intents = or.iterationIntents ?? (or.iterations === 3 ? CANONICAL_INTENTS : []);
    const intentStr = intents.length ? ` (${intents.join(' → ')})` : '';
    bullets.push({
      emoji: '🔁',
      text: `${or.iterations} iteration${or.iterations === 1 ? '' : 's'}${intentStr}`,
    });

    const covered = or.topicsCovered ?? shape.topicCount;
    bullets.push({
      emoji: '🎯',
      text: `Team Meetings: ${or.slotsPerIteration} slot${or.slotsPerIteration === 1 ? '' : 's'} × ${or.slotMinutes} min · covers ${covered}/${shape.topicCount} topics`,
    });

    if (covered < shape.topicCount) {
      const dropped = shape.topicCount - covered;
      bullets.push({
        emoji: '✂️',
        text: `Bottom ${dropped} by vote drop out — only the top ${covered} topic${covered === 1 ? '' : 's'} get team meetings.`,
      });
    }

    bullets.push({
      emoji: '👥',
      text: `Critics: ${CRITIC_POLICY_LABEL[or.criticPolicy as CriticPolicy]}`,
    });
  }

  const rev = format.stages.find((s) => s.kind === 'reverberation');
  if (rev && rev.kind === 'reverberation') {
    bullets.push({
      emoji: '🌀',
      text: `Reverberation: ${rev.minutes} min — LLM synthesis → team report-back → group convergence`,
    });
  }

  for (const c of format.caveats ?? []) {
    bullets.push({ emoji: '⚠️', text: c });
  }

  return bullets;
}
