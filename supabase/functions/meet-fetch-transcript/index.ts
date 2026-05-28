/**
 * Pull captured Meet transcripts from Drive and persist them in session_transcripts.
 *
 * Two input shapes:
 *   POST { meetRoomId: string }                 — process exactly one room
 *   POST { sessionId: string; slotIndex: number } — process every ended room in a slot
 *
 * For each room we:
 *   1. Skip if transcript_fetched_at is already set (idempotent).
 *   2. List conferenceRecords for the space; pick the latest.
 *   3. List transcripts on that record; pick the latest FILE_GENERATED one.
 *      (If the transcript is still STARTED/ENDED but not FILE_GENERATED, Meet
 *      hasn't finished assembling the Doc yet. We return notReady so the
 *      driver can poll again on the next tick.)
 *   4. Download the Doc body as text/plain via Drive's export endpoint.
 *   5. Compute the role-label sidecar (participantId/name/role for this team).
 *   6. Upsert session_transcripts (unique on meet_room_id) + stamp meet_rooms.
 *
 * Deploy:  supabase functions deploy meet-fetch-transcript --project-ref cuxoxcbzgexaaievfqeb --no-verify-jwt
 */

import {
  DRIVE_API,
  MEET_API,
  cors,
  getAccessToken,
  getServiceClient,
  googleFetch,
  json,
} from '../_shared/meet-auth.ts';

interface FetchRequest {
  meetRoomId?: string;
  sessionId?: string;
  slotIndex?: number;
}

interface MeetRoomRow {
  id: string;
  session_id: string;
  slot_index: number;
  team_topic_id: string;
  iteration: number;
  space_name: string;
  ended_at: string | null;
  transcript_fetched_at: string | null;
}

interface ConferenceRecord {
  name: string;            // "conferenceRecords/abc"
  startTime?: string;
  endTime?: string;
}
interface TranscriptResource {
  name: string;            // "conferenceRecords/abc/transcripts/xyz"
  state?: 'STATE_UNSPECIFIED' | 'STARTED' | 'ENDED' | 'FILE_GENERATED';
  docsDestination?: { document?: string; exportUri?: string };
  startTime?: string;
  endTime?: string;
}

interface Team {
  topicId: string;
  memberParticipantIds: string[];
  criticParticipantIds: string[];
}
interface SessionSchedule {
  teams: Team[];
}

interface ProcessResult {
  meetRoomId: string;
  status: 'saved' | 'skipped' | 'notReady' | 'noRecord' | 'error';
  detail?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let payload: FetchRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const supabase = getServiceClient();

  // Load target rooms.
  let rooms: MeetRoomRow[] = [];
  if (payload.meetRoomId) {
    const { data, error } = await supabase
      .from('meet_rooms')
      .select('id, session_id, slot_index, team_topic_id, iteration, space_name, ended_at, transcript_fetched_at')
      .eq('id', payload.meetRoomId)
      .maybeSingle();
    if (error) return json({ error: `meet_rooms read failed: ${error.message}` }, 500);
    if (!data) return json({ error: 'meet_rooms row not found' }, 404);
    rooms = [data as MeetRoomRow];
  } else if (payload.sessionId && typeof payload.slotIndex === 'number') {
    const { data, error } = await supabase
      .from('meet_rooms')
      .select('id, session_id, slot_index, team_topic_id, iteration, space_name, ended_at, transcript_fetched_at')
      .eq('session_id', payload.sessionId)
      .eq('slot_index', payload.slotIndex);
    if (error) return json({ error: `meet_rooms read failed: ${error.message}` }, 500);
    rooms = (data ?? []) as MeetRoomRow[];
  } else {
    return json({ error: 'Provide either meetRoomId or {sessionId, slotIndex}' }, 400);
  }

  if (rooms.length === 0) return json({ results: [] });

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const results: ProcessResult[] = [];
  for (const room of rooms) {
    try {
      results.push(await processRoom(room, accessToken, supabase));
    } catch (e) {
      results.push({ meetRoomId: room.id, status: 'error', detail: (e as Error).message });
    }
  }

  return json({ results });
});

// deno-lint-ignore no-explicit-any
async function processRoom(room: MeetRoomRow, accessToken: string, supabase: any): Promise<ProcessResult> {
  if (room.transcript_fetched_at) {
    return { meetRoomId: room.id, status: 'skipped', detail: 'already fetched' };
  }

  // 1. Find a conferenceRecord for this space.
  const filter = encodeURIComponent(`space.name="${room.space_name}"`);
  const recList = await googleFetch<{ conferenceRecords?: ConferenceRecord[] }>(
    accessToken,
    `${MEET_API}/conferenceRecords?filter=${filter}`,
  );
  const records = recList.conferenceRecords ?? [];
  if (records.length === 0) {
    return { meetRoomId: room.id, status: 'noRecord', detail: 'no conferenceRecords yet' };
  }
  // Latest first
  records.sort((a, b) => (b.endTime ?? b.startTime ?? '').localeCompare(a.endTime ?? a.startTime ?? ''));
  const record = records[0];

  // 2. List transcripts on that record.
  const trList = await googleFetch<{ transcripts?: TranscriptResource[] }>(
    accessToken,
    `${MEET_API}/${record.name}/transcripts`,
  );
  const transcripts = trList.transcripts ?? [];
  const finished = transcripts
    .filter((t) => t.state === 'FILE_GENERATED' && t.docsDestination?.document)
    .sort((a, b) => (b.endTime ?? '').localeCompare(a.endTime ?? ''));
  if (finished.length === 0) {
    // Update conference_name even if transcript not ready, so future calls don't re-list.
    await supabase.from('meet_rooms').update({ conference_name: record.name }).eq('id', room.id);
    return { meetRoomId: room.id, status: 'notReady', detail: `${transcripts.length} transcript(s), none FILE_GENERATED` };
  }
  const transcript = finished[0];
  const fileId = transcript.docsDestination!.document!;

  // 3. Download as text/plain from Drive.
  const driveRes = await fetch(`${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!driveRes.ok) {
    const detail = await driveRes.text().catch(() => '');
    throw new Error(`Drive export ${driveRes.status}: ${detail.slice(0, 300)}`);
  }
  const transcriptText = await driveRes.text();

  // 4. Build the labels sidecar (participant role map for this team).
  const labels = await buildLabels(supabase, room);

  // 5. Fetch topic title for denormalisation.
  const { data: topicRow } = await supabase
    .from('topic_cards')
    .select('title')
    .eq('id', room.team_topic_id)
    .maybeSingle();
  const topicTitle = (topicRow?.title as string | undefined) ?? '(untitled topic)';

  // 6. Upsert session_transcripts (unique on meet_room_id).
  const { error: upsertError } = await supabase
    .from('session_transcripts')
    .upsert(
      {
        session_id: room.session_id,
        slot_index: room.slot_index,
        team_topic_id: room.team_topic_id,
        topic_title: topicTitle,
        iteration: room.iteration,
        meet_room_id: room.id,
        transcript_text: transcriptText,
        participants: labels,
      },
      { onConflict: 'meet_room_id' },
    );
  if (upsertError) throw new Error(`session_transcripts upsert: ${upsertError.message}`);

  // 7. Stamp meet_rooms.
  const { error: stampError } = await supabase
    .from('meet_rooms')
    .update({
      conference_name: record.name,
      transcript_drive_file_id: fileId,
      transcript_fetched_at: new Date().toISOString(),
    })
    .eq('id', room.id);
  if (stampError) throw new Error(`meet_rooms stamp: ${stampError.message}`);

  return { meetRoomId: room.id, status: 'saved', detail: `${transcriptText.length} chars` };
}

interface ParticipantLabel { participantId: string; name: string; role: 'member' | 'critic' }

// deno-lint-ignore no-explicit-any
async function buildLabels(supabase: any, room: MeetRoomRow): Promise<ParticipantLabel[]> {
  // Pull the algorithm schedule (deterministic, always present) to find this team.
  const { data: assignment } = await supabase
    .from('role_assignments')
    .select('schedule')
    .eq('session_id', room.session_id)
    .eq('method', 'algorithm')
    .maybeSingle();
  const schedule = assignment?.schedule as SessionSchedule | undefined;
  const team = schedule?.teams.find((t) => t.topicId === room.team_topic_id);
  if (!team) return [];

  const ids = [...team.memberParticipantIds, ...team.criticParticipantIds];
  if (ids.length === 0) return [];

  const { data: participants } = await supabase
    .from('participants')
    .select('id, name')
    .in('id', ids);
  const nameById = new Map<string, string>(((participants ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));

  const out: ParticipantLabel[] = [];
  for (const id of team.memberParticipantIds) out.push({ participantId: id, name: nameById.get(id) ?? 'Unknown', role: 'member' });
  for (const id of team.criticParticipantIds) out.push({ participantId: id, name: nameById.get(id) ?? 'Unknown', role: 'critic' });
  return out;
}
