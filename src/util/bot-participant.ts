/**
 * Bot participant contributions (shared infrastructure — spans steps 4/5/6).
 *
 * Bots are LLM-driven pseudo-participants spawned by PAD reconciliation to fill a
 * shape. Exactly one elected client (the bot driver) runs these to produce a
 * bot's contribution at each step, then writes it to Supabase like a human's.
 * Transport-agnostic via injected `LlmComplete`.
 *
 * Each function returns plain data; the driver is responsible for persistence
 * and for idempotency (per-(bot,phase) markers in participants.ready_flags).
 */
import type { LlmComplete } from './7-role-assignment-llm';
import { INTEGRAL_COLLECTIVE_CONTEXT } from './bot-context-integral';

/** Prepend the collective context so every bot contribution is grounded in it. */
function grounded(taskSystem: string): string {
  return `${INTEGRAL_COLLECTIVE_CONTEXT}\n\n--- YOUR TASK RIGHT NOW ---\n${taskSystem}`;
}

function parseJsonObject<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Bot reply contained no JSON object.');
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

/** Pool of bot surnames (cybernetics / systems / cooperative thinkers). */
export const BOT_NAMES = [
  'Ada', 'Boole', 'Wiener', 'Ashby', 'Beer', 'Pask', 'Mead', 'Bateson', 'Maturana', 'Varela',
  'Shannon', 'Turing', 'Neumann', 'McCulloch', 'Pitts', 'Forrester', 'Meadows', 'Odum', 'Prigogine', 'Luhmann',
  'Simon', 'Holland', 'Kauffman', 'Lovelace', 'Hopper', 'Engelbart', 'Licklider', 'Nelson', 'Papert', 'Minsky',
  'Foerster', 'Glanville', 'Krippendorff', 'Espejo', 'Leonard', 'Capra', 'Morin', 'Snowden', 'Rosenblueth', 'Walker',
];

/** A deterministic avatar colour from an id (names are assigned at spawn for uniqueness). */
export function botIdentity(seed: string): { name: string; color: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { name: `${BOT_NAMES[h % BOT_NAMES.length]}·bot`, color: `hsl(${h % 360} 65% 55%)` };
}

const STATEMENT_SYSTEM = `You role-play a participant in a Team Syntegrity problem-jostle. You are given a
DRIVING QUESTION. Contribute 1-3 SHORT statements (each < 20 words) that are DIRECT, concrete answers
to that driving question - proposals or positions on what the group should actually do about it. Each
must be debatable (someone in the group might plausibly disagree). Reason from your Integral
perspective, but the statement itself must clearly respond to the driving question, NOT describe
Integral's architecture in the abstract. Avoid duplicating existing statements. Respond with ONLY
JSON: {"statements": string[]}.`;

export async function botStatements(opts: {
  drivingQuestion: string;
  existing: string[];
  complete: LlmComplete;
}): Promise<string[]> {
  const prompt = JSON.stringify({ drivingQuestion: opts.drivingQuestion, existing: opts.existing }, null, 2);
  const text = await opts.complete(prompt, grounded(STATEMENT_SYSTEM));
  const { statements } = parseJsonObject<{ statements: string[] }>(text);
  return (statements ?? []).slice(0, 3);
}

const STATEMENTS_BATCH_SYSTEM = `You role-play SEVERAL different participants in a Team Syntegrity
problem-jostle. You are given a DRIVING QUESTION and a requested count N. Produce EXACTLY N distinct
SHORT statements (each < 20 words), one per participant. Each must be a direct, concrete answer to
the driving question (a proposal or position on what the group should actually do), debatable
(someone might disagree), and distinct from the others and from any existing statements. Reason from
an Integral perspective, but each statement must clearly respond to the driving question, NOT
describe Integral's architecture in the abstract. Respond with ONLY JSON: {"statements": string[]}
containing exactly N items.`;

/** One call → N statements (one per bot). Far faster than N sequential calls. */
export async function botStatementsBatch(opts: {
  drivingQuestion: string;
  existing: string[];
  count: number;
  complete: LlmComplete;
}): Promise<string[]> {
  if (opts.count <= 0) return [];
  const prompt = JSON.stringify({ drivingQuestion: opts.drivingQuestion, count: opts.count, existing: opts.existing }, null, 2);
  const text = await opts.complete(prompt, grounded(STATEMENTS_BATCH_SYSTEM));
  const { statements } = parseJsonObject<{ statements: string[] }>(text);
  return (statements ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, opts.count);
}

const VOTE_SYSTEM = `You role-play a participant casting 5 sticker votes across candidate topics in a
Team Syntegrity voting stage. You may put multiple votes on a topic you feel strongly about. Return
exactly 5 votes as topic card ids (repeats allowed). Respond with ONLY JSON: {"cardIds": string[]}.`;

function normalizeBallot(cardIds: string[] | undefined, cards: { id: string }[]): string[] {
  const valid = new Set(cards.map((c) => c.id));
  const out = (cardIds ?? []).filter((id) => valid.has(id)).slice(0, 5);
  while (out.length < 5 && cards.length) out.push(cards[out.length % cards.length].id);
  return out;
}

export async function botVotes(opts: {
  drivingQuestion: string;
  cards: { id: string; title: string; rationale: string }[];
  complete: LlmComplete;
}): Promise<string[]> {
  const prompt = JSON.stringify({ drivingQuestion: opts.drivingQuestion, cards: opts.cards, totalVotes: 5 }, null, 2);
  const text = await opts.complete(prompt, grounded(VOTE_SYSTEM));
  const { cardIds } = parseJsonObject<{ cardIds: string[] }>(text);
  return normalizeBallot(cardIds, opts.cards);
}

const VOTES_BATCH_SYSTEM = `You role-play SEVERAL different participants casting sticker votes in a
Team Syntegrity voting stage. Each participant gets 5 votes to distribute across the candidate topic
cards (you MAY stack multiple votes on a card to weight it). You are given the list of voters and the
candidate cards. Return ONE ballot per voter: exactly 5 card ids each (repeats allowed). Vary the
ballots by voter so they reflect distinct viewpoints. Respond with ONLY JSON:
{"ballots":[{"participantId":string,"cardIds":string[]}]} with exactly one entry per voter.`;

/** One call → a 5-vote ballot for every voter. Returns participantId → cardIds. */
export async function botVotesBatch(opts: {
  drivingQuestion: string;
  cards: { id: string; title: string; rationale: string }[];
  voters: { id: string; name: string }[];
  complete: LlmComplete;
}): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!opts.voters.length || !opts.cards.length) return out;
  const prompt = JSON.stringify({ drivingQuestion: opts.drivingQuestion, votesPerVoter: 5, cards: opts.cards, voters: opts.voters }, null, 2);
  const text = await opts.complete(prompt, grounded(VOTES_BATCH_SYSTEM));
  const { ballots } = parseJsonObject<{ ballots: { participantId: string; cardIds: string[] }[] }>(text);
  const byId = new Map((ballots ?? []).map((b) => [b.participantId, b.cardIds]));
  for (const v of opts.voters) out.set(v.id, normalizeBallot(byId.get(v.id), opts.cards));
  return out;
}

const PREF_SYSTEM = `You role-play a participant ranking topics by personal preference (most preferred
first) in a Team Syntegrity session. Rank ALL provided topic ids. Respond with ONLY JSON:
{"rankedTopicIds": string[]}.`;

export async function botPreference(opts: {
  drivingQuestion: string;
  topics: { id: string; title: string }[];
  complete: LlmComplete;
}): Promise<string[]> {
  const prompt = JSON.stringify({ drivingQuestion: opts.drivingQuestion, topics: opts.topics }, null, 2);
  const text = await opts.complete(prompt, grounded(PREF_SYSTEM));
  const { rankedTopicIds } = parseJsonObject<{ rankedTopicIds: string[] }>(text);
  const valid = new Set(opts.topics.map((t) => t.id));
  const ranked = (rankedTopicIds ?? []).filter((id) => valid.has(id));
  // Ensure completeness: append any topics the model omitted.
  for (const t of opts.topics) if (!ranked.includes(t.id)) ranked.push(t.id);
  return ranked;
}
