/**
 * Step 5 (Voting) — topic-card seeding and LLM merge.
 *
 * Two jobs:
 *  - summarizeClusterToCard: turn a step-4 cluster into a votable topic card
 *    (title + rationale). Mostly pass-through of the cluster's name/summary, but
 *    can refine wording via the LLM when statement text is available.
 *  - mergeTopicCards: when a user drags one card onto another and the group
 *    approves, produce a single merged card (new LLM title + combined rationale).
 *
 * Transport-agnostic via injected `LlmComplete`.
 */
import type { LlmComplete } from './7-role-assignment-llm';

export interface TopicCardSeed {
  title: string;
  rationale: string;
}

/** Lightweight, no-LLM seed straight from a cluster. */
export function clusterToCardSeed(cluster: { name: string; summary: string }): TopicCardSeed {
  return { title: cluster.name, rationale: cluster.summary };
}

const MERGE_SYSTEM = `You merge two candidate discussion topics from a Team Syntegrity voting stage
into one. Produce a single concise title (<= 6 words) that captures both, and a rationale (1-2
sentences) that fairly combines the substance of both topics without losing either's intent.
Respond with ONLY valid JSON: {"title": string, "rationale": string}.`;

function parseMerge(text: string): TopicCardSeed {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Merge reply contained no JSON object.');
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<TopicCardSeed>;
  if (!parsed.title) throw new Error('Merge reply missing title.');
  return { title: parsed.title, rationale: parsed.rationale ?? '' };
}

export async function mergeTopicCards(opts: {
  a: TopicCardSeed;
  b: TopicCardSeed;
  drivingQuestion: string;
  complete: LlmComplete;
}): Promise<TopicCardSeed> {
  const prompt = JSON.stringify(
    { drivingQuestion: opts.drivingQuestion, topicA: opts.a, topicB: opts.b },
    null,
    2,
  );
  const text = await opts.complete(prompt, MERGE_SYSTEM);
  return parseMerge(text);
}
