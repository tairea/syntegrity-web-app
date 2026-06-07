/**
 * Create (or return cached) a persistent session-level Google Meet space.
 * Transcription is intentionally OFF — this is the informal coordination call
 * that runs lobby → done; slot meetings handle their own transcription via
 * meet-create-rooms (which passes artifactConfig).
 *
 * POST body: { sessionId: string }
 * Idempotent: if sessions.meet_space_name is already set, returns it immediately.
 *
 * Deploy: supabase functions deploy meet-create-session-space --no-verify-jwt
 */

import {
  MEET_API,
  cors,
  getAccessToken,
  getServiceClient,
  googleFetch,
  json,
} from '../_shared/meet-auth.ts';

interface CreateSessionSpaceRequest {
  sessionId?: string;
}

interface MeetSpaceResponse {
  name?: string;       // "spaces/abc..."
  meetingUri?: string; // "https://meet.google.com/..."
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: CreateSessionSpaceRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const sessionId = payload.sessionId;
  if (!sessionId) return json({ error: 'sessionId is required' }, 400);

  const supabase = getServiceClient();

  // Idempotency: return the cached space if already created for this session.
  const { data: row, error: selectError } = await supabase
    .from('sessions')
    .select('meet_space_name, meet_space_uri')
    .eq('id', sessionId)
    .maybeSingle();
  if (selectError) return json({ error: `sessions read failed: ${selectError.message}` }, 500);
  if (!row) return json({ error: `Session not found: ${sessionId}` }, 404);
  if (row.meet_space_name && row.meet_space_uri) {
    return json({ meet_space_name: row.meet_space_name, meet_space_uri: row.meet_space_uri, reused: true });
  }

  // Mint a new Meet space. No artifactConfig → transcription stays OFF.
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  let space: MeetSpaceResponse;
  try {
    space = await googleFetch<MeetSpaceResponse>(accessToken, `${MEET_API}/spaces`, {
      method: 'POST',
      body: JSON.stringify({ config: { accessType: 'OPEN' } }),
    });
  } catch (e) {
    return json({ error: `Meet API call failed: ${(e as Error).message}` }, 502);
  }

  if (!space.name || !space.meetingUri) {
    return json({ error: 'Meet API returned malformed space (no name/meetingUri)' }, 502);
  }

  const { error: updateError } = await supabase
    .from('sessions')
    .update({ meet_space_name: space.name, meet_space_uri: space.meetingUri })
    .eq('id', sessionId);
  if (updateError) {
    return json({ error: `sessions update failed: ${updateError.message}` }, 500);
  }

  return json({ meet_space_name: space.name, meet_space_uri: space.meetingUri, reused: false });
});
