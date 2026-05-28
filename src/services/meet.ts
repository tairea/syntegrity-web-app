/**
 * Thin typed wrappers around the meet-* Supabase edge functions.
 *
 * Uses supabase.functions.invoke so the anon key + Authorization header are
 * auto-attached. The functions themselves run under --no-verify-jwt (they
 * accept the anon key for routing but do their own input validation).
 *
 * Each wrapper throws on transport/edge-function errors, but inspects the
 * payload for the function's own `{error: string}` shape and surfaces that
 * too — so callers can `try { ... } catch (e)` once for both layers.
 */
import { supabase } from './supabase';
import type { MeetRoomRow } from './db-types';

interface InvokeOk<T> { data: T; error: null }
interface InvokeErr { data: null; error: { message: string } }
type Invoked<T> = InvokeOk<T> | InvokeErr;

async function call<TReq extends Record<string, unknown>, TRes>(fn: string, body: TReq): Promise<TRes> {
  const { data, error } = (await supabase.functions.invoke(fn, { body })) as unknown as Invoked<TRes & { error?: string }>;
  if (error) throw new Error(`${fn} transport: ${error.message}`);
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(`${fn}: ${data.error as string}`);
  }
  return data as TRes;
}

export interface CreateRoomsResponse {
  rooms: MeetRoomRow[];
  reused: boolean;
  note?: string;
}

export function createMeetRooms(
  sessionId: string,
  slotIndex: number,
  method: 'algorithm' | 'llm' = 'algorithm',
): Promise<CreateRoomsResponse> {
  return call('meet-create-rooms', { sessionId, slotIndex, method });
}

export interface EndRoomsResponse {
  ended: number;
  results?: { id: string; ended: boolean; note?: string; error?: string }[];
}

export function endMeetRooms(sessionId: string, slotIndex: number): Promise<EndRoomsResponse> {
  return call('meet-end-rooms', { sessionId, slotIndex });
}

export interface FetchTranscriptResult {
  meetRoomId: string;
  status: 'saved' | 'skipped' | 'notReady' | 'noRecord' | 'error';
  detail?: string;
}
export interface FetchTranscriptResponse {
  results: FetchTranscriptResult[];
}

export function fetchMeetTranscripts(
  input: { meetRoomId: string } | { sessionId: string; slotIndex: number },
): Promise<FetchTranscriptResponse> {
  return call('meet-fetch-transcript', input);
}
