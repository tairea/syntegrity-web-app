/**
 * OpenRouter proxy (Supabase Edge Function).
 *
 * Holds OPENROUTER_API_KEY server-side as a Supabase secret so it never reaches
 * the browser bundle. The client (src/util/llm-openrouter.ts → createOpenRouterComplete)
 * POSTs { model, temperature, jsonMode, messages } here; we attach the key + app
 * attribution, forward to OpenRouter, and return { content } (or { error }).
 *
 * Deploy:   supabase functions deploy openrouter --project-ref <ref> --no-verify-jwt
 * Secret:   supabase secrets set OPENROUTER_API_KEY=sk-or-... --project-ref <ref>
 *
 * HARDENING (prototype is intentionally permissive — open CORS, no per-user auth):
 * before a real launch, restrict CORS to known origins and/or require Supabase
 * auth so this can't be used as an open OpenRouter proxy against your credits.
 * MAX_INPUT_CHARS bounds per-request cost in the meantime.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'minimax/minimax-m2.7';
const MAX_INPUT_CHARS = 200_000; // bound per-request cost / abuse

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

interface ProxyPayload {
  model?: string;
  temperature?: number;
  jsonMode?: boolean;
  max_tokens?: number;
  messages?: { role: string; content: string }[];
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) return json({ error: 'Server misconfigured: OPENROUTER_API_KEY not set' }, 500);

  let payload: ProxyPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages[] is required' }, 400);
  }
  const totalChars = messages.reduce((n, m) => n + (m?.content?.length ?? 0), 0);
  if (totalChars > MAX_INPUT_CHARS) {
    return json({ error: `Input too large (${totalChars} > ${MAX_INPUT_CHARS} chars)` }, 413);
  }

  const body: Record<string, unknown> = {
    model: payload.model ?? DEFAULT_MODEL,
    temperature: payload.temperature ?? 0.2,
    messages,
  };
  // jsonMode defaults true (matches the previous client behaviour).
  if (payload.jsonMode !== false) body.response_format = { type: 'json_object' };
  if (payload.max_tokens) body.max_tokens = payload.max_tokens;

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': Deno.env.get('OPENROUTER_REFERER') ?? 'https://syntegrity-web-app.vercel.app',
        'X-Title': 'Syntegrity Web App',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json({ error: `Upstream fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: `OpenRouter ${res.status}: ${detail.slice(0, 500)}` }, res.status);
  }

  const data = (await res.json().catch(() => null)) as OpenRouterResponse | null;
  if (!data) return json({ error: 'OpenRouter returned non-JSON' }, 502);
  if (data.error) return json({ error: data.error.message ?? 'OpenRouter error' }, 502);
  const content = data.choices?.[0]?.message?.content;
  if (!content) return json({ error: 'OpenRouter returned no message content' }, 502);

  return json({ content });
});
