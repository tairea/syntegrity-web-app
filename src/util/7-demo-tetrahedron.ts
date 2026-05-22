/**
 * Throwaway smoke test proving the step-7 data objects flow end-to-end on the
 * fully-encoded tetrahedron (6 people / 4 topics). Run: `npx tsx src/util/7-demo-tetrahedron.ts`.
 * Replace the synthetic `topics`/`preferences` with real step-6 output later.
 */
import { assignRolesAlgorithm } from './7-role-assignment-algorithm';
import { assignRolesLlm } from './7-role-assignment-llm';
import { getShape, validateShape } from './geometry';
import { buildSchedule } from './7-scheduler';
import type { Participant, RoleAssignmentInput, Topic, TopicPreference } from './types';

const shape = getShape('tetrahedron');
console.log('shape valid:', validateShape(shape)); // expect { ok: true, errors: [] }

const topics: Topic[] = [
  { id: 'T-water', vertexIndex: 0, title: 'Water security', rationale: '...' },
  { id: 'T-energy', vertexIndex: 1, title: 'Energy mix', rationale: '...' },
  { id: 'T-housing', vertexIndex: 2, title: 'Housing', rationale: '...' },
  { id: 'T-transit', vertexIndex: 3, title: 'Transit', rationale: '...' },
];
const allTopicIds = topics.map((t) => t.id);
const participants: Participant[] = Array.from({ length: 6 }, (_, i) => ({ id: `P${i + 1}`, name: `Person ${i + 1}` }));

// Deterministic pseudo-shuffle so the demo is reproducible.
const preferences: TopicPreference[] = participants.map((p, i) => ({
  participantId: p.id,
  rankedTopicIds: [...allTopicIds].sort((a, b) => ((a.length * (i + 2)) % 7) - ((b.length * (i + 3)) % 7)),
}));

const input: RoleAssignmentInput = { shape, topics, participants, preferences };

const algo = assignRolesAlgorithm(input);
console.log('\n[algorithm] avg satisfaction:', algo.satisfaction.average.toFixed(3), '| worst member rank:', algo.satisfaction.worstMemberRank);
console.table(algo.assignments.map((a) => ({ p: a.participantId, strut: a.strutId, member: a.memberTopicIds.join('+'), critic: a.criticTopicIds.join('+') })));

const schedule = buildSchedule({ shape, assignment: algo, topics, participants });
console.log('\n[scheduler] effective concurrency:', schedule.concurrency, '(tetrahedron forces 1) | slots:', schedule.slots.length, '| conflicts:', schedule.conflicts.length);
console.table(schedule.slots.map((s) => ({ slot: s.index, teams: s.sessions.map((x) => `${x.teamTopicId}#${x.iteration}`).join(', ') })));

// Mocked LLM: just hand back the identity permutation to prove the parse/validate/score path.
const mockComplete = async () =>
  JSON.stringify({ assignments: participants.map((p, i) => ({ participantId: p.id, strutId: i, reason: 'mock' })), rationale: 'identity mapping (mock)' });
const llm = await assignRolesLlm(input, { complete: mockComplete, model: 'mock' });
console.log('\n[llm/mock] avg satisfaction:', llm.satisfaction.average.toFixed(3), '| assignments:', llm.assignments.length);
