/**
 * End every active Meet conference for the given slot. Driver calls this when
 * the slot's timer expires (after the 5s visible warning countdown). Idempotent:
 * already-ended rooms are skipped.
 *
 * POST body: { sessionId: string; slotIndex: number }
 *
 * Deploy:  supabase functions deploy meet-end-rooms --project-ref cuxoxcbzgexaaievfqeb --no-verify-jwt
 */

import {
  MEET_API,
  cors,
  getAccessToken,
  getServiceClient,
  googleFetch,
  json,
} from '../_shared/meet-auth.ts';

interface EndRoomsRequest {
  sessionId?: string;
  slotIndex?: number;
}

interface MeetRoomRow {
  id: string;
  space_name: string;
  ended_at: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: EndRoomsRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { sessionId, slotIndex } = payload;
  if (!sessionId || typeof slotIndex !== 'number') {
    return json({ error: 'sessionId and slotIndex are required' }, 400);
  }

  const supabase = getServiceClient();

  const { data: rooms, error: readError } = await supabase
    .from('meet_rooms')
    .select('id, space_name, ended_at')
    .eq('session_id', sessionId)
    .eq('slot_index', slotIndex)
    .is('ended_at', null);
  if (readError) return json({ error: `meet_rooms read failed: ${readError.message}` }, 500);
  if (!rooms || rooms.length === 0) {
    return json({ ended: 0, note: 'No open rooms for this slot' });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  // End each conference. If a room never had a conference started (no one
  // joined), :endActiveConference returns FAILED_PRECONDITION; we swallow that
  // since the goal — "no more active call" — is met either way.
  const results = await Promise.all(
    (rooms as MeetRoomRow[]).map(async (room) => {
      try {
        await googleFetch<unknown>(
          accessToken,
          `${MEET_API}/${room.space_name}:endActiveConference`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        return { id: room.id, ended: true as const };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('400') || msg.includes('FAILED_PRECONDITION')) {
          return { id: room.id, ended: true as const, note: 'no active conference' };
        }
        return { id: room.id, ended: false as const, error: msg };
      }
    }),
  );

  const endedIds = results.filter((r) => r.ended).map((r) => r.id);
  if (endedIds.length > 0) {
    const { error: updateError } = await supabase
      .from('meet_rooms')
      .update({ ended_at: new Date().toISOString() })
      .in('id', endedIds);
    if (updateError) {
      return json({ error: `meet_rooms ended_at update failed: ${updateError.message}`, results }, 500);
    }
  }

  return json({ ended: endedIds.length, results });
});
