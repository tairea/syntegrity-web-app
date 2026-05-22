/**
 * Step 3 (lobby → jostle boundary) — roster reconciliation helpers.
 *
 * When the lobby locks (>50% of jostle participants ready), the headcount may
 * not equal an exact encoded shape size. This pure module computes the two
 * options the group then votes on (right-popout, 👍/👎, 30s timer):
 *   - TRIM: remove the last-joined participants down to the nearest-lower size.
 *   - PAD:  add LLM bots up to the nearest-higher size.
 *
 * No I/O, no LLM. The store applies the chosen plan (marking rows removed or
 * spawning bots). Only the 3 encoded shapes are considered.
 */
import type { ShapeName } from './types';

/** Encoded shape sizes available to the prototype, ascending. */
export const ENCODED_SIZES: { size: number; shape: ShapeName }[] = [
  { size: 6, shape: 'tetrahedron' },
  { size: 12, shape: 'octahedron' },
  { size: 30, shape: 'icosahedron' },
];

/** Hard ceiling on participants: the largest encoded shape (icosahedron = 30). */
export const MAX_PARTICIPANTS = ENCODED_SIZES[ENCODED_SIZES.length - 1].size;

/**
 * The shape a lobby of `headcount` people should show: the SMALLEST encoded
 * shape that fits everyone (so a full shape rolls up to the next), capped at the
 * largest. 1-6 → tetra, 7-12 → octa, 13-30 → icosa.
 */
export function encodedShapeForHeadcount(headcount: number): ShapeName {
  const n = Math.max(1, headcount);
  const fit = ENCODED_SIZES.find((e) => e.size >= n);
  return (fit ?? ENCODED_SIZES[ENCODED_SIZES.length - 1]).shape;
}

export interface ReconciliationPlan {
  /** True when headcount already equals an encoded size (no vote needed). */
  exact: boolean;
  /** Nearest-lower encoded option, or null if headcount is below the smallest. */
  trim: { toShape: ShapeName; toCount: number; removeCount: number } | null;
  /** Nearest-higher encoded option, or null if headcount is above the largest. */
  pad: { toShape: ShapeName; toCount: number; addCount: number } | null;
}

/**
 * Given a locked headcount, return the trim/pad options. Pass the join order
 * (participant ids oldest→newest) to resolve exactly who is trimmed.
 */
export function reconciliationPlan(headcount: number): ReconciliationPlan {
  const exactMatch = ENCODED_SIZES.find((e) => e.size === headcount);
  if (exactMatch) return { exact: true, trim: null, pad: null };

  const lower = [...ENCODED_SIZES].reverse().find((e) => e.size < headcount) ?? null;
  const higher = ENCODED_SIZES.find((e) => e.size > headcount) ?? null;

  return {
    exact: false,
    trim: lower ? { toShape: lower.shape, toCount: lower.size, removeCount: headcount - lower.size } : null,
    pad: higher ? { toShape: higher.shape, toCount: higher.size, addCount: higher.size - headcount } : null,
  };
}

/**
 * Resolve which participant ids get trimmed: the last `removeCount` to join.
 * `joinOrder` is oldest → newest (e.g. sorted by joined_at). Bots are never
 * trimmed (they only exist via PAD), but callers should pass humans here.
 */
export function participantsToTrim(joinOrder: string[], removeCount: number): string[] {
  if (removeCount <= 0) return [];
  return joinOrder.slice(Math.max(0, joinOrder.length - removeCount));
}
