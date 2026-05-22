/**
 * Step 7 — Role assignment, LLM method.
 *
 * Same input/output contract as 7-role-assignment-algorithm.ts. The difference
 * is HOW the person->strut permutation is chosen: instead of minimizing a fixed
 * cost, we hand the model the topics, each person's ranked preferences, and the
 * strut structure, and ask it to produce a 1:1 assignment it can justify — which
 * lets it weigh qualitative factors a pure cost function can't (e.g. spreading
 * a person's two member topics across different themes, balancing critic load,
 * keeping a reluctant participant off a topic they ranked dead last).
 *
 * The model's job is ONLY to output the permutation `participantId -> strutId`.
 * We then resolve + score it with the SHARED helpers, so an LLM result is
 * directly comparable to the algorithmic one in the prototype toggle.
 *
 * This file is transport-agnostic: it builds the prompt and parses/validates the
 * response, but takes the actual model call as an injected `complete` function
 * so it works against Anthropic, an edge function, or a mock in tests.
 */

import {
  assertInputConsistency,
  resolveAssignment,
  scoreAssignments,
  vertexToTopicMap,
} from './7-assignment-shared';
import type {
  ParticipantAssignment,
  RoleAssignmentInput,
  RoleAssignmentResult,
  StrutId,
} from './types';

/** Injected model call. Returns the raw model text for `prompt`. */
export type LlmComplete = (prompt: string, system: string) => Promise<string>;

export interface LlmOptions {
  complete: LlmComplete;
  /** For meta/telemetry only. */
  model?: string;
}

/** What we expect the model to return (parsed from JSON in its reply). */
interface LlmAssignmentReply {
  /** One entry per participant. */
  assignments: { participantId: string; strutId: number; reason?: string }[];
  /** Optional model-level explanation of the overall strategy. */
  rationale?: string;
}

const SYSTEM_PROMPT = `You are assigning people to roles in a Stafford Beer Team Syntegrity session.
The session geometry is fixed: each "strut" is one role slot that makes its holder a
full MEMBER of exactly two topic-teams and a CRITIC of exactly two other topic-teams.
You must output a strict 1:1 assignment of every participant to exactly one strut.
Honour participants' ranked topic preferences for their MEMBER seats as much as
possible while keeping the assignment fair (no one stuck with two bottom-ranked
member topics if it can be avoided). Critic seats matter less but avoid clear clashes.
Respond with ONLY valid JSON, no prose outside the JSON.`;

/** Build the user prompt: topics, per-person preferences, and the strut table. */
export function buildAssignmentPrompt(input: RoleAssignmentInput): string {
  const topics = input.topics.map((t) => ({ id: t.id, vertex: t.vertexIndex, title: t.title }));
  const struts = input.shape.struts.map((s) => ({
    strutId: s.id,
    memberOfVertices: s.memberOf,
    criticOfVertices: s.criticOf,
  }));
  const preferences = input.preferences.map((p) => ({
    participantId: p.participantId,
    rankedTopicIds: p.rankedTopicIds, // most-preferred first
  }));

  return JSON.stringify(
    {
      instruction:
        'Assign every participantId to exactly one strutId (a permutation). ' +
        'Topics are bound to vertices via topics[].vertex. A strut makes its holder ' +
        'a member of memberOfVertices and a critic of criticOfVertices.',
      shape: input.shape.name,
      teamSize: input.shape.teamSize,
      topics,
      struts,
      preferences,
      responseSchema: {
        assignments: [{ participantId: 'string', strutId: 'number', reason: 'string (optional)' }],
        rationale: 'string (optional)',
      },
    },
    null,
    2,
  );
}

/** Extract the first JSON object from a model reply that may include code fences. */
function parseReply(text: string): LlmAssignmentReply {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM reply contained no JSON object.');
  return JSON.parse(raw.slice(start, end + 1)) as LlmAssignmentReply;
}

/** Validate that the parsed reply is a true permutation over participants & struts. */
export function validatePermutation(
  input: RoleAssignmentInput,
  reply: LlmAssignmentReply,
): Map<string, StrutId> {
  const n = input.participants.length;
  const personIds = new Set(input.participants.map((p) => p.id));
  const seenPerson = new Set<string>();
  const seenStrut = new Set<number>();
  const map = new Map<string, StrutId>();

  if (!Array.isArray(reply.assignments) || reply.assignments.length !== n) {
    throw new Error(`Expected ${n} assignments, got ${reply.assignments?.length ?? 0}.`);
  }
  for (const a of reply.assignments) {
    if (!personIds.has(a.participantId)) throw new Error(`Unknown participantId ${a.participantId}.`);
    if (seenPerson.has(a.participantId)) throw new Error(`Duplicate participant ${a.participantId}.`);
    if (a.strutId < 0 || a.strutId >= n) throw new Error(`strutId ${a.strutId} out of range.`);
    if (seenStrut.has(a.strutId)) throw new Error(`Duplicate strut ${a.strutId}.`);
    seenPerson.add(a.participantId);
    seenStrut.add(a.strutId);
    map.set(a.participantId, a.strutId);
  }
  return map;
}

export async function assignRolesLlm(
  input: RoleAssignmentInput,
  options: LlmOptions,
): Promise<RoleAssignmentResult> {
  assertInputConsistency(input);

  const prompt = buildAssignmentPrompt(input);
  const text = await options.complete(prompt, SYSTEM_PROMPT);
  const reply = parseReply(text);
  const personStrut = validatePermutation(input, reply);

  const vertexToTopic = vertexToTopicMap(input);
  const assignments: ParticipantAssignment[] = input.participants.map((p) =>
    resolveAssignment(input, p.id, personStrut.get(p.id)!, vertexToTopic),
  );

  const satisfaction = scoreAssignments(input, assignments);
  return {
    method: 'llm',
    assignments,
    satisfaction,
    meta: {
      model: options.model,
      rationale: reply.rationale,
      reasons: reply.assignments.reduce<Record<string, string>>((acc, a) => {
        if (a.reason) acc[a.participantId] = a.reason;
        return acc;
      }, {}),
    },
  };
}
