/**
 * OpenRouter transport for the LLM role-assignment method.
 *
 * Produces an `LlmComplete` (the function `assignRolesLlm` depends on), keeping
 * that script transport-agnostic. The model defaults to MiniMax M2.7. All
 * bot/clustering/merge/assignment calls inherit it.
 *
 * SECURITY: this no longer talks to OpenRouter directly. It calls the Supabase
 * Edge Function `openrouter` (see supabase/functions/openrouter/index.ts), which
 * holds OPENROUTER_API_KEY server-side — the key never reaches the browser. The
 * `LlmComplete` seam means the rest of the app is unaffected.
 */

import { assignRolesLlm, type LlmComplete } from './7-role-assignment-llm';
import type { RoleAssignmentInput, RoleAssignmentResult } from './types';
import { supabase } from '@/services/supabase';

export const DEFAULT_OPENROUTER_MODEL = 'minimax/minimax-m2.7';

/** Name of the Supabase Edge Function that proxies OpenRouter (holds the key). */
const PROXY_FUNCTION = 'openrouter';

export interface OpenRouterOptions {
  /** Model slug. Defaults to {@link DEFAULT_OPENROUTER_MODEL}. */
  model?: string;
  /** 0..1; assignment wants determinism, so default low. */
  temperature?: number;
  /** Ask OpenRouter to enforce a JSON object response. Default true. */
  jsonMode?: boolean;
}

interface ProxyResponse {
  content?: string;
  error?: string;
}

/** Pull the best error detail out of a supabase-js FunctionsError (it carries the Response). */
async function describeFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as ProxyResponse;
      if (body?.error) return body.error;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build an `LlmComplete` bound to the OpenRouter proxy. The returned function
 * takes the (prompt, system) pair that `assignRolesLlm` produces and returns the
 * model's raw text content for downstream JSON parsing.
 */
export function createOpenRouterComplete(options: OpenRouterOptions = {}): LlmComplete {
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const temperature = options.temperature ?? 0.2;
  const jsonMode = options.jsonMode ?? true;

  return async (prompt: string, system: string): Promise<string> => {
    const { data, error } = await supabase.functions.invoke<ProxyResponse>(PROXY_FUNCTION, {
      body: {
        model,
        temperature,
        jsonMode,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
    });

    if (error) throw new Error(`OpenRouter proxy request failed: ${await describeFunctionError(error)}`);
    if (data?.error) throw new Error(`OpenRouter proxy error: ${data.error}`);
    if (!data?.content) throw new Error('OpenRouter proxy returned no message content.');
    return data.content;
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
