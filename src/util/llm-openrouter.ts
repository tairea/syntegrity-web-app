/**
 * OpenRouter transport for the LLM role-assignment method.
 *
 * Produces an `LlmComplete` (the function `assignRolesLlm` depends on), keeping
 * that script transport-agnostic. The model defaults to Qwen3.6-35B-A3B (cheap
 * MoE: ~$0.15/M in, $1.00/M out). All bot/clustering/merge/assignment calls
 * inherit it.
 *
 * SECURITY: this calls OpenRouter directly with `VITE_OPENROUTER_API_KEY`, which
 * Vite bundles into client code => the key is PUBLIC in the browser. Acceptable
 * for local prototyping only. Before deploying, move this call behind a Supabase
 * edge function and have the browser call that instead; the `LlmComplete` seam
 * means only this file changes.
 */

import { assignRolesLlm, type LlmComplete } from './7-role-assignment-llm';
import type { RoleAssignmentInput, RoleAssignmentResult } from './types';

export const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3.6-35b-a3b';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterOptions {
  /** OpenRouter API key. Falls back to env (VITE_OPENROUTER_API_KEY) if omitted. */
  apiKey?: string;
  /** Model slug. Defaults to Claude Sonnet 4.6. */
  model?: string;
  /** 0..1; assignment wants determinism, so default low. */
  temperature?: number;
  /** Ask OpenRouter to enforce a JSON object response. Default true. */
  jsonMode?: boolean;
  /** Optional app attribution for OpenRouter rankings. */
  referer?: string;
  title?: string;
  /** Override endpoint (tests/proxies). */
  baseUrl?: string;
  /** Abort/timeout support. */
  signal?: AbortSignal;
}

/** Read the key from Vite env (browser/build) or process.env (node/tests). */
export function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;
  // import.meta.env exists under Vite; process.env under node/tests. Access both
  // defensively via globalThis so this file typechecks without node globals and
  // runs in either environment.
  const viteEnv = (import.meta as unknown as { env?: Record<string, string> }).env;
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
  const key = viteEnv?.VITE_OPENROUTER_API_KEY ?? nodeEnv?.VITE_OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OpenRouter API key not found. Set VITE_OPENROUTER_API_KEY in .env or pass apiKey.');
  }
  return key;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Build an `LlmComplete` bound to OpenRouter. The returned function takes the
 * (prompt, system) pair that `assignRolesLlm` produces and returns the model's
 * raw text content for downstream JSON parsing.
 */
export function createOpenRouterComplete(options: OpenRouterOptions = {}): LlmComplete {
  const apiKey = resolveApiKey(options.apiKey);
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const temperature = options.temperature ?? 0.2;
  const jsonMode = options.jsonMode ?? true;
  const url = options.baseUrl ?? OPENROUTER_URL;

  return async (prompt: string, system: string): Promise<string> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (options.referer) headers['HTTP-Referer'] = options.referer;
    if (options.title) headers['X-OpenRouter-Title'] = options.title;

    const body: Record<string, unknown> = {
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter request failed (${res.status} ${res.statusText}): ${detail.slice(0, 500)}`);
    }

    const data = (await res.json()) as OpenRouterResponse;
    if (data.error) throw new Error(`OpenRouter error: ${data.error.message ?? 'unknown'}`);

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter returned no message content.');
    return content;
  };
}

/**
 * Convenience: run the LLM role-assignment method against OpenRouter in one call.
 * Equivalent to `assignRolesLlm(input, { complete: createOpenRouterComplete(opts), model })`.
 */
export function assignRolesOpenRouter(
  input: RoleAssignmentInput,
  options: OpenRouterOptions = {},
): Promise<RoleAssignmentResult> {
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  return assignRolesLlm(input, { complete: createOpenRouterComplete(options), model });
}
