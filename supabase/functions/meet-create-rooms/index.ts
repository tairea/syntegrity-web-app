/**
 * Create one Google Meet room per MeetingSession in a given slot of the session
 * schedule. Each room is created with transcription ON at creation and OPEN
 * access (no knocking), and the resulting space_name + meet_uri are recorded
 * in meet_rooms so clients can subscribe via realtime.
 *
 * POST body: { sessionId: string; slotIndex: number; method?: 'algorithm' | 'llm' }
 *   - method defaults to 'algorithm' (the deterministic, always-computed schedule).
 *
 * Idempotent on (session_id, slot_index): if rows already exist for that slot,
 * we return them unchanged rather than minting duplicate Meet rooms.
 *
 * Deploy:  supabase functions deploy meet-create-rooms --project-ref cuxoxcbzgexaaievfqeb --no-verify-jwt
 */

import {
  MEET_API,
  cors,
  getAccessToken,
  getServiceClient,
  googleFetch,
  json,
} from '../_shared/meet-auth.ts';

interface CreateRoomsRequest {
  sessionId?: string;
  slotIndex?: number;
  method?: 'algorithm' | 'llm';
}

interface MeetingSession {
  teamTopicId: string;
  iteration: number;
  slotIndex: number;
  attendeeMemberIds: string[];
  attendeeCriticIds: string[];
}

interface ScheduleSlot {
  index: number;
  sessions: MeetingSession[];
}

interface SessionSchedule {
  slots: ScheduleSlot[];
}

interface MeetSpaceResponse {
  name?: string;             // "spaces/abc..."
  meetingUri?: string;       // "https://meet.google.com/..."
  meetingCode?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: CreateRoomsRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const sessionId = payload.sessionId;
  const slotIndex = payload.slotIndex;
  const method = payload.method ?? 'algorithm';
  if (!sessionId || typeof slotIndex !== 'number') {
    return json({ error: 'sessionId and slotIndex are required' }, 400);
  }

  const supabase = getServiceClient();

  // 1. If we already have rooms for this slot, return them (idempotent).
  const { data: existing, error: existingError } = await supabase
    .from('meet_rooms')
    .select('*')
    .eq('session_id', sessionId)
    .eq('slot_index', slotIndex);
  if (existingError) return json({ error: `meet_rooms read failed: ${existingError.message}` }, 500);
  if (existing && existing.length > 0) {
    return json({ rooms: existing, reused: true });
  }

  // 2. Load the schedule from role_assignments.
  const { data: assignment, error: assignmentError } = await supabase
    .from('role_assignments')
    .select('schedule')
    .eq('session_id', sessionId)
    .eq('method', method)
    .maybeSingle();
  if (assignmentError) return json({ error: `role_assignments read failed: ${assignmentError.message}` }, 500);
  if (!assignment?.schedule) {
    return json({ error: `No ${method} schedule found for session ${sessionId}. Has the graph phase finished computing?` }, 404);
  }

  const schedule = assignment.schedule as SessionSchedule;
  const slot = schedule.slots?.find((s) => s.index === slotIndex);
  if (!slot) {
    return json({ error: `Slot ${slotIndex} not in schedule (have ${schedule.slots?.length ?? 0} slots)` }, 404);
  }
  if (slot.sessions.length === 0) {
    return json({ rooms: [], reused: false, note: 'Slot has no meetings (off-round)' });
  }

  // 3. Mint Meet spaces in parallel.
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const spaceBody = {
    config: {
      accessType: 'OPEN',
      artifactConfig: {
        transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
      },
    },
  };

  const created = await Promise.all(
    slot.sessions.map(async (meeting) => {
      const space = await googleFetch<MeetSpaceResponse>(accessToken, `${MEET_API}/spaces`, {
        method: 'POST',
        body: JSON.stringify(spaceBody),
      });
      if (!space.name || !space.meetingUri) {
        throw new Error(`Meet API returned malformed space (no name/meetingUri)`);
      }
      return { meeting, space };
    }),
  ).catch((e) => {
    return { error: (e as Error).message };
  });

  if ('error' in created) return json({ error: `Meet API call failed: ${created.error}` }, 502);

  // 4. Persist the rows.
  const insertRows = created.map(({ meeting, space }) => ({
    session_id: sessionId,
    slot_index: slotIndex,
    team_topic_id: meeting.teamTopicId,
    iteration: meeting.iteration,
    space_name: space.name!,
    meet_uri: space.meetingUri!,
  }));
  const { data: inserted, error: insertError } = await supabase
    .from('meet_rooms')
    .insert(insertRows)
    .select('*');
  if (insertError) {
    return json({ error: `meet_rooms insert failed: ${insertError.message}`, partial: created.map((c) => c.space) }, 500);
  }

  return json({ rooms: inserted ?? [], reused: false });
});
