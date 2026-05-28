/**
 * Step 7 — Role assignment, DETERMINISTIC method.
 *
 * Problem shape: assign N participants to N struts (1:1). Each strut carries a
 * fixed pair of member topics + pair of critic topics. We want the assignment
 * that maximizes preference satisfaction => a classic LINEAR SUM ASSIGNMENT
 * PROBLEM (a.k.a. the Hungarian / Kuhn-Munkres problem):
 *
 *   cost[p][s] = strutCostForParticipant(person p, strut s)   // lower = better
 *   minimize  Σ cost[p][assigned_strut(p)]   over all perfect matchings
 *
 * Because cost is purely per (person, strut) pair, the optimum is well-defined
 * and solvable in O(N^3). The default solver is the exact Hungarian
 * (Kuhn-Munkres) algorithm; a fast greedy baseline is kept behind
 * `solver: 'greedy'` for comparison. Both return the same shape, so switching
 * solvers never changes the I/O contract.
 *
 * Input/Output is the SHARED contract in types.ts, identical to the LLM method,
 * so the UI toggle compares like with like.
 */

import {
  assertInputConsistency,
  preferenceRankIndex,
  resolveAssignment,
  scoreAssignments,
  strutCostForParticipant,
  vertexToTopicMap,
} from './7-assignment-shared';
import type {
  ParticipantAssignment,
  RoleAssignmentInput,
  RoleAssignmentResult,
} from './types';

export interface AlgorithmOptions {
  /** Relative weight of critic-topic ranks vs member-topic ranks. */
  criticWeight?: number;
  /** 'hungarian' (default, exact optimum) or 'greedy' (fast baseline). */
  solver?: 'greedy' | 'hungarian';
}

/**
 * Build the full cost matrix cost[participantIndex][strutId].
 * Exposed so a future Hungarian solver (and unit tests) can consume it directly.
 */
export function buildCostMatrix(
  input: RoleAssignmentInput,
  criticWeight = 0.25,
): number[][] {
  const vertexToTopic = vertexToTopicMap(input);
  const ranksByPerson = preferenceRankIndex(input);
  const strutIds = input.shape.struts.map((s) => s.id);

  return input.participants.map((p) => {
    const ranks = ranksByPerson.get(p.id) ?? new Map();
    return strutIds.map((sid) =>
      strutCostForParticipant(input, ranks, sid, vertexToTopic, criticWeight),
    );
  });
}

/**
 * Greedy baseline: repeatedly take the globally cheapest unused (person, strut)
 * pair. Deterministic, O(N^2 log N). Decent quality; not guaranteed optimal.
 */
function solveGreedy(cost: number[][]): number[] {
  const n = cost.length;
  const cells: { p: number; s: number; c: number }[] = [];
  for (let p = 0; p < n; p++) for (let s = 0; s < n; s++) cells.push({ p, s, c: cost[p][s] });
  cells.sort((a, b) => a.c - b.c);

  const personStrut = new Array<number>(n).fill(-1);
  const strutTaken = new Array<boolean>(n).fill(false);
  let placed = 0;
  for (const { p, s } of cells) {
    if (placed === n) break;
    if (personStrut[p] === -1 && !strutTaken[s]) {
      personStrut[p] = s;
      strutTaken[s] = true;
      placed++;
    }
  }
  return personStrut; // index = participant index, value = strutId
}

/**
 * Exact O(N^3) Kuhn-Munkres (Hungarian) solver for the square linear sum
 * assignment problem. Finds the minimum-total-cost perfect matching of rows
 * (participants) to columns (struts). Returns the same shape as solveGreedy:
 * `result[participantIndex] = strutId`.
 *
 * Implementation: the potentials/augmenting-shortest-path variant. `u`/`v` are
 * dual potentials, `p[j]` is the row currently matched to column j, `way[j]`
 * reconstructs the augmenting path. Works with real-valued costs (our critic
 * weighting produces fractional costs). 1-indexed internally to keep the
 * sentinel column 0; converted back to 0-indexed on return.
 */
function solveHungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  if (cost.some((row) => row.length !== n)) throw new Error('Hungarian solver requires a square cost matrix.');

  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0); // row potentials
  const v = new Array<number>(n + 1).fill(0); // column potentials
  const p = new Array<number>(n + 1).fill(0); // p[j] = row assigned to column j (1-indexed); p[0] = current row
  const way = new Array<number>(n + 1).fill(0); // backpointers for path reconstruction

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0; // current column (0 = virtual start)
    const minv = new Array<number>(n + 1).fill(INF);
    const used = new Array<boolean>(n + 1).fill(false);

    // Grow a shortest augmenting path until we reach an unmatched column.
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      // Update potentials along the path.
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Augment: flip matches back along the reconstructed path.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const result = new Array<number>(n).fill(-1); // result[row] = col
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) result[p[j] - 1] = j - 1;
  }
  return result;
}

export function assignRolesAlgorithm(
  input: RoleAssignmentInput,
  options: AlgorithmOptions = {},
): RoleAssignmentResult {
  assertInputConsistency(input);
  const criticWeight = options.criticWeight ?? 0.25;
  const solver = options.solver ?? 'hungarian'; // exact optimum; greedy kept for comparison

  // Sub-shape support: when fewer participants than struts (e.g. 4 humans on a
  // 12-position octahedron), pad the cost matrix with phantom participants at
  // a uniform very-high cost. Hungarian still gets the square matrix it needs;
  // because phantom rows uniformly dominate any real row's cost on any column,
  // the optimum assignment of REAL rows is identical to the rectangular LSAP
  // optimum on (real-participants × struts). We then slice out the phantom
  // entries — the struts they "took" become vacant positions in the result.
  const realN = input.participants.length;
  const K = input.shape.struts.length;
  const realCost = buildCostMatrix(input, criticWeight);
  const PHANTOM_COST = 1e9; // dominates any plausible real cost (bounded by ~topics*teamSize)
  const cost: number[][] = realCost.map((row) => row.slice());
  for (let i = realN; i < K; i++) cost.push(new Array<number>(K).fill(PHANTOM_COST));

  const personStrut = solver === 'hungarian' ? solveHungarian(cost) : solveGreedy(cost);

  const vertexToTopic = vertexToTopicMap(input);
  // Slice out phantom rows: only the first realN entries are real participants.
  const assignments: ParticipantAssignment[] = input.participants.map((p, i) =>
    resolveAssignment(input, p.id, personStrut[i], vertexToTopic),
  );

  const satisfaction = scoreAssignments(input, assignments);
  return {
    method: 'algorithm',
    assignments,
    satisfaction,
    meta: { solver, criticWeight },
  };
}
