/**
 * Step 4 (Problem Jostle) — LLM topic clustering.
 *
 * Groups the free-floating statements into named clusters as they relate to the
 * driving question. The store calls this on a ~5s debounce, only when statements
 * changed. MUST surface at least `minClusters` clusters (= the chosen shape's
 * vertex count) even if some clusters hold a single statement — the downstream
 * voting step needs at least that many candidate topics.
 *
 * Transport-agnostic: takes an injected `LlmComplete` (pass
 * createOpenRouterComplete() from the store). Mirrors the role-assignment LLM
 * pattern: build prompt → call → parse/validate JSON.
 */
import type { LlmComplete } from './7-role-assignment-llm';

export interface ClusterInputStatement {
  id: string;
  text: string;
}

export interface ClusterResult {
  /** Stable-ish label for matching across re-clusters (best effort). */
  name: string;
  /** One-line rationale summarizing the cluster's statements. */
  summary: string;
  /** Ids of the statements assigned to this cluster. */
  statementIds: string[];
}

export interface ClusteringResult {
  clusters: ClusterResult[];
}

const SYSTEM_PROMPT = `You are clustering short "statements of importance" from a Team Syntegrity
problem-jostle session into candidate topics, judged by how they relate to the driving question.
Rules:
- Every statement id must appear in exactly one cluster.
- Produce AT LEAST the requested minimum number of clusters; it is fine for a cluster to contain a
  single statement if it is genuinely distinct. More clusters than the minimum is allowed.
- Give each cluster a short human title (<= 5 words) and a one-sentence "summary" that BEGINS with
  the words "This cluster" and describes what its statements have in common.
- Respond with ONLY valid JSON, no prose outside the JSON.`;

export function buildClusteringPrompt(opts: {
  statements: ClusterInputStatement[];
  drivingQuestion: string;
  minClusters: number;
}): string {
  return JSON.stringify(
    {
      drivingQuestion: opts.drivingQuestion,
      minClusters: opts.minClusters,
      statements: opts.statements,
      responseSchema: {
        clusters: [{ name: 'string', summary: 'string', statementIds: ['string'] }],
      },
    },
    null,
    2,
  );
}

function parseReply(text: string): ClusteringResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Clustering reply contained no JSON object.');
  const parsed = JSON.parse(raw.slice(start, end + 1)) as ClusteringResult;
  if (!Array.isArray(parsed.clusters)) throw new Error('Clustering reply missing clusters[].');
  return parsed;
}

/**
 * Ensure every statement is covered exactly once and there are >= minClusters.
 * If the model under-clusters, split the largest clusters until the minimum is
 * met (deterministic fallback) so the invariant downstream always holds.
 */
function normalize(result: ClusteringResult, statementIds: string[], minClusters: number): ClusteringResult {
  const seen = new Set<string>();
  const clusters = result.clusters
    .map((c) => ({
      name: c.name?.trim() || 'Untitled',
      summary: c.summary?.trim() || '',
      statementIds: (c.statementIds ?? []).filter((id) => statementIds.includes(id) && !seen.has(id) && (seen.add(id), true)),
    }))
    .filter((c) => c.statementIds.length > 0);

  // Any statements the model dropped → append to a catch-all cluster.
  const missing = statementIds.filter((id) => !seen.has(id));
  if (missing.length) clusters.push({ name: 'Other', summary: '', statementIds: missing });

  // Under-clustered → split largest clusters until we reach minClusters
  // (only possible while clusters still have >1 statement to split).
  while (clusters.length < minClusters) {
    clusters.sort((a, b) => b.statementIds.length - a.statementIds.length);
    const biggest = clusters[0];
    if (!biggest || biggest.statementIds.length < 2) break;
    const half = Math.ceil(biggest.statementIds.length / 2);
    const movedIds = biggest.statementIds.splice(half);
    clusters.push({ name: `${biggest.name} (2)`, summary: biggest.summary, statementIds: movedIds });
  }

  return { clusters };
}

export async function clusterStatements(opts: {
  statements: ClusterInputStatement[];
  drivingQuestion: string;
  minClusters: number;
  complete: LlmComplete;
}): Promise<ClusteringResult> {
  if (opts.statements.length === 0) return { clusters: [] };

  const prompt = buildClusteringPrompt(opts);
  const text = await opts.complete(prompt, SYSTEM_PROMPT);
  const parsed = parseReply(text);
  return normalize(
    parsed,
    opts.statements.map((s) => s.id),
    opts.minClusters,
  );
}
