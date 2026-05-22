/**
 * Singleton Supabase client.
 *
 * Reads the public (anon/publishable) credentials from Vite env. These are
 * client-side keys by design; row access is governed by RLS (permissive in the
 * prototype — see supabase/schema.sql). No auth/session is used: identity is the
 * anonymous participantId we generate and persist locally (see useSessionStore).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  // Surface a clear message rather than a cryptic network error later.
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing — realtime features will not work. Copy .env.example to .env.',
  );
}

export const supabase: SupabaseClient = createClient(url ?? 'http://localhost', key ?? 'public-anon-key', {
  realtime: { params: { eventsPerSecond: 20 } },
});

/** Channel name for a session's realtime traffic. */
export function sessionChannelName(sessionId: string): string {
  return `session:${sessionId}`;
}
