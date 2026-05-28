/**
 * Shared helpers for the Meet edge functions.
 *
 * - `getServiceClient()` returns a Supabase client using the service role key
 *   (bypasses RLS so we can read meet_credentials).
 * - `getAccessToken(hostEmail)` swaps the stored refresh token for a short-lived
 *   access token via Google's OAuth2 token endpoint.
 * - `cors`, `json()`, `MEET_API`, `DRIVE_API`, `OAUTH_TOKEN_URL` mirror the
 *   openrouter function's shape (single CORS object, single json helper).
 *
 * Env (Supabase auto-injects SUPABASE_* in edge functions; the GOOGLE_OAUTH_*
 * trio is set by hand via `supabase secrets set`):
 *   SUPABASE_URL                         — auto
 *   SUPABASE_SERVICE_ROLE_KEY            — auto
 *   GOOGLE_OAUTH_CLIENT_ID               — Web OAuth client id
 *   GOOGLE_OAUTH_CLIENT_SECRET           — Web OAuth client secret
 *   GOOGLE_OAUTH_REDIRECT_URI            — meet-oauth-callback URL (registered with Google)
 *   MEET_HOST_EMAIL                      — defaults to ian@sunriselabs.io
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export const MEET_API = 'https://meet.googleapis.com/v2';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OPENID_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export function defaultHostEmail(): string {
  return Deno.env.get('MEET_HOST_EMAIL') ?? 'ian@sunriselabs.io';
}

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export function getServiceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Refresh-token grant: trade the stored refresh token for a short-lived access token. */
export async function getAccessToken(hostEmail = defaultHostEmail()): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('meet_credentials')
    .select('refresh_token')
    .eq('host_email', hostEmail)
    .maybeSingle();
  if (error) throw new Error(`meet_credentials lookup failed: ${error.message}`);
  if (!data?.refresh_token) {
    throw new Error(
      `No refresh token for host ${hostEmail}. Visit /meet-oauth-init to run the consent flow.`,
    );
  }

  const body = new URLSearchParams({
    client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    refresh_token: data.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !payload?.access_token) {
    const detail = payload?.error_description ?? payload?.error ?? `HTTP ${res.status}`;
    throw new Error(`Token refresh failed: ${detail}`);
  }
  return payload.access_token;
}

/** Wraps fetch with a bearer token + JSON parsing. Throws on non-2xx with the API's error text. */
export async function googleFetch<T>(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google API ${res.status} on ${url}: ${detail.slice(0, 500)}`);
  }
  // 204 from :endActiveConference is valid + has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
