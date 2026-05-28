/**
 * Shared helpers for BOTH role-assignment methods (algorithm + LLM).
 *
 * Keeping resolution and scoring here guarantees the two methods produce
 * identically-shaped, directly-comparable `RoleAssignmentResult`s for the
 * prototype's toggle. A method only has to decide WHICH person sits on WHICH
 * strut; everything downstream (resolving topic ids, scoring satisfaction) is
 * common and lives here.
 */

import type {
  AssignmentSatisfaction,
  ParticipantAssignment,
  ParticipantId,
  ParticipantSatisfaction,
  RoleAssignmentInput,
  StrutId,
  TopicId,
} from './types';

/** vertexIndex -> topicId, derived from the topics' `vertexIndex` binding. */
export function vertexToTopicMap(input: RoleAssignmentInput): Map<number, TopicId> {
  const m = new Map<number, TopicId>();
  for (const t of input.topics) m.set(t.vertexIndex, t.id);
  return m;
}

/** participantId -> (topicId -> 0-based preference rank). Lower rank = preferred. */
export function preferenceRankIndex(
  input: RoleAssignmentInput,
): Map<ParticipantId, Map<TopicId, number>> {
  const byPerson = new Map<ParticipantId, Map<TopicId, number>>();
  for (const pref of input.preferences) {
    const ranks = new Map<TopicId, number>();
    pref.rankedTopicIds.forEach((topicId, i) => ranks.set(topicId, i));
    byPerson.set(pref.participantId, ranks);
  }
  return byPerson;
}

/**
 * Turn a raw person->strut assignment into the resolved `ParticipantAssignment`,
 * mapping the strut's member/critic vertices to topic ids.
 */
export function resolveAssignment(
  input: RoleAssignmentInput,
  participantId: ParticipantId,
  strutId: StrutId,
  vertexToTopic: Map<number, TopicId>,
): ParticipantAssignment {
  const strut = input.shape.struts[strutId];
  const topicFor = (v: number): TopicId => {
    const id = vertexToTopic.get(v);
    if (id === undefined) throw new Error(`No topic bound to vertex ${v}`);
    return id;
  };
  return {
    participantId,
    strutId,
    memberTopicIds: [topicFor(strut.memberOf[0]), topicFor(strut.memberOf[1])],
    criticTopicIds: [topicFor(strut.criticOf[0]), topicFor(strut.criticOf[1])],
  };
}

/**
 * Per-person cost of sitting on a given strut, used by the algorithmic solver.
 * Cost is dominated by MEMBER topic ranks (that's the person's real seat);
 * critic ranks contribute at a smaller weight. Lower cost = better fit.
 * If a topic isn't in a person's ranking (shouldn't happen — they rank all),
 * it is treated as the worst possible rank.
 */
export function strutCostForParticipant(
  input: RoleAssignmentInput,
  ranks: Map<TopicId, number>,
  strutId: StrutId,
  vertexToTopic: Map<number, TopicId>,
  criticWeight = 0.25,
): number {
  const worst = input.topics.length;
  const strut = input.shape.struts[strutId];
  const rankOf = (v: number) => ranks.get(vertexToTopic.get(v)!) ?? worst;
  const memberCost = rankOf(strut.memberOf[0]) + rankOf(strut.memberOf[1]);
  const criticCost = rankOf(strut.criticOf[0]) + rankOf(strut.criticOf[1]);
  return memberCost + criticWeight * criticCost;
}

/** Score a complete set of resolved assignments into comparable metrics. */
export function scoreAssignments(
  input: RoleAssignmentInput,
  assignments: ParticipantAssignment[],
): AssignmentSatisfaction {
  const ranksByPerson = preferenceRankIndex(input);
  const topicCount = input.topics.length;
  const teamSize = input.shape.teamSize;
  const worst = topicCount - 1;

  const perParticipant: ParticipantSatisfaction[] = [];
  let totalMemberRank = 0;
  let worstMemberRank = 0;
  let happyCount = 0;

  for (const a of assignments) {
    const ranks = ranksByPerson.get(a.participantId) ?? new Map<TopicId, number>();
    const r = (id: TopicId) => ranks.get(id) ?? worst;
    const memberRanks: [number, number] = [r(a.memberTopicIds[0]), r(a.memberTopicIds[1])];
    const criticRanks: [number, number] = [r(a.criticTopicIds[0]), r(a.criticTopicIds[1])];

    // Normalize: best possible member outcome is ranks {0,1} -> score 1.
    const bestSum = 0 + 1;
    const worstSum = worst + (worst - 1);
    const memberSum = memberRanks[0] + memberRanks[1];
    const score = worstSum === bestSum ? 1 : 1 - (memberSum - bestSum) / (worstSum - bestSum);

    totalMemberRank += memberSum;
    worstMemberRank = Math.max(worstMemberRank, memberRanks[0], memberRanks[1]);
    if (memberRanks[0] < teamSize && memberRanks[1] < teamSize) happyCount++;

    perParticipant.push({ participantId: a.participantId, memberRanks, criticRanks, score });
  }

  const average = perParticipant.length
    ? perParticipant.reduce((s, p) => s + p.score, 0) / perParticipant.length
    : 0;

  return { perParticipant, average, totalMemberRank, worstMemberRank, happyCount };
}

/**
 * Guardrail: confirm input sizes line up with the chosen shape before either
 * method runs. Throws with an actionable message rather than producing a
 * silently-wrong graph.
 *
 * Topics are a fixed property of the shape — those still must match exactly.
 * Participants/preferences are allowed to be FEWER than shape.participantCount
 * (vacant-position case: 4 humans on an icosahedron-shaped graph). Methods that
 * support it handle the vacancies; those that can't should detect and throw
 * their own clearer message AFTER this gate.
 */
export function assertInputConsistency(input: RoleAssignmentInput): void {
  const { shape, topics, participants, preferences } = input;
  const problems: string[] = [];
  if (topics.length !== shape.topicCount)
    problems.push(`topics ${topics.length} !== shape.topicCount ${shape.topicCount}`);
  if (participants.length < 1)
    problems.push(`participants ${participants.length} < 1 (need at least one)`);
  if (participants.length > shape.participantCount)
    problems.push(`participants ${participants.length} > shape.participantCount ${shape.participantCount}`);
  if (preferences.length !== participants.length)
    problems.push(`preferences ${preferences.length} !== participants ${participants.length}`);
  if (problems.length) throw new Error(`RoleAssignmentInput inconsistent with shape:\n - ${problems.join('\n - ')}`);
}

/** True when fewer participants than struts — i.e., the resulting graph has vacant positions. */
export function hasVacancies(input: RoleAssignmentInput): boolean {
  return input.participants.length < input.shape.participantCount;
}
