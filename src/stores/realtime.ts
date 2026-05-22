/**
 * Realtime helpers shared by stores. Thin wrappers over the Supabase channel so
 * each store registers its postgres_changes handler the same way. All handlers
 * must be attached BEFORE channel.subscribe() (Supabase requirement) — the
 * session store orchestrates that ordering.
 *
 * Payloads are typed loosely (Supabase's default record shape); stores cast
 * `payload.new` / `payload.old` to their concrete row type. Interface row types
 * don't satisfy Supabase's `Record<string, unknown>` generic constraint, so we
 * deliberately don't parameterize here.
 */
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '@/services/supabase';

/** The exact channel type the client produces (avoids re-export version skew). */
export type Channel = ReturnType<typeof supabase.channel>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyChange = RealtimePostgresChangesPayload<{ [key: string]: any }>;

/**
 * Subscribe to one table's changes on its OWN channel.
 *
 * IMPORTANT: multiple postgres_changes bindings on a single channel silently
 * fail to deliver events with the current Supabase Realtime (verified: 1 binding
 * works, 10 bindings deliver nothing despite SUBSCRIBED). So we use one channel
 * per table. All channels multiplex over the single client websocket, so this is
 * cheap. Returns the channel for cleanup.
 */
export function subscribeTable(
  sessionId: string,
  table: string,
  handler: (payload: AnyChange) => void,
  // The `sessions` table is keyed by `id`; every other table references it via
  // `session_id`. Filtering on the wrong column silently delivers nothing.
  filterColumn: 'session_id' | 'id' = 'session_id',
): Channel {
  const ch = supabase.channel(`session:${sessionId}:${table}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ch as any).on(
    'postgres_changes',
    { event: '*', schema: 'public', table, filter: `${filterColumn}=eq.${sessionId}` },
    handler,
  );
  ch.subscribe();
  return ch;
}

/** Fetch all rows of a table for a session (initial hydrate after subscribe). */
export async function loadTable<T>(table: string, sessionId: string): Promise<T[]> {
  const { data, error } = await supabase.from(table).select('*').eq('session_id', sessionId);
  if (error) {
    console.error(`[realtime] load ${table} failed`, error);
    return [];
  }
  return (data ?? []) as T[];
}
