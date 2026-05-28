/**
 * Supabase row shapes (mirror supabase/schema.sql) and mappers to/from the pure
 * domain types in @/util. Stores convert at this boundary so the compute layer
 * never sees DB concerns.
 */
import type {
  Participant,
  ParticipantId,
  ShapeName,
  Topic,
  TopicId,
  TopicPreference,
  VertexIndex,
} from '@/util';

export type SessionPhase =
  | 'lobby'
  | 'reconciliation'
  | 'jostle'
  | 'voting'
  | 'preference'
  | 'graph'
  | 'resolve'
  | 'done';

export type SessionStatus = 'live' | 'scheduled' | 'done';

/** ready_flags JSONB shape on participants. */
export interface ReadyFlags {
  jostle?: boolean;
  vote?: boolean;
  pref?: boolean;
  /** Set when a participant clicks "Ready to Begin" on the schedule sidebar; gates the graph→resolve transition. */
  resolve?: boolean;
  /** Per-phase markers so the bot driver's actions stay idempotent. */
  bot_acted?: Partial<Record<SessionPhase, boolean>>;
}

export interface SessionRow {
  id: string;
  code: string;
  driving_question: string;
  creator_participant_id: string | null;
  phase: SessionPhase;
  phase_payload: Record<string, unknown>;
  locked_shape: ShapeName | null;
  roster_locked: boolean;
  headcount_target: number | null;
  status: SessionStatus;
  scheduled_start_at: string | null;
  scheduled_timezone: string | null;
  session_format_id: string | null;
  scheduled_duration_minutes: number | null;
  creator_token: string | null;
  /** Outcome Resolve: which slot of the schedule is currently live (0..N), or null pre-/post-resolve. */
  resolve_current_slot_index: number | null;
  /** ISO timestamp for the current slot's start; driver uses this + the format's minutesPerIteration to auto-end. */
  resolve_slot_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledCommitmentRow {
  id: string;
  session_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  discord_handle: string | null;
  commit_token: string;
  participant_id: string | null;
  created_at: string;
}

export interface ParticipantRow {
  id: string;
  session_id: string;
  name: string;
  avatar_url: string | null;
  discord_handle: string | null;
  is_bot: boolean;
  removed: boolean;
  ready_flags: ReadyFlags;
  joined_at: string;
  created_at: string;
}

export interface StatementRow {
  id: string;
  session_id: string;
  participant_id: string;
  cluster_id: string | null;
  text: string;
  deleted: boolean;
  created_at: string;
}

export interface ClusterRow {
  id: string;
  session_id: string;
  name: string;
  summary: string;
  vertex_hint: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ClusterMessageRow {
  id: string;
  session_id: string;
  cluster_id: string;
  participant_id: string;
  text: string;
  created_at: string;
}

export interface TopicCardRow {
  id: string;
  session_id: string;
  title: string;
  rationale: string;
  source_cluster_ids: string[];
  merged_from: string[] | null;
  vote_count: number;
  removed: boolean;
  created_at: string;
}

export interface VoteRow {
  id: string;
  session_id: string;
  participant_id: string;
  topic_card_id: string;
  created_at: string;
}

export interface MergeRequestRow {
  id: string;
  session_id: string;
  kind: 'merge' | 'reconciliation';
  proposer_id: string | null;
  card_a: string | null;
  card_b: string | null;
  expires_at: string;
  up: string[];
  down: string[];
  status: 'open' | 'approved' | 'rejected';
  result_card_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  session_id: string;
  participant_id: string;
  ranked_topic_ids: string[];
  saved: boolean;
  created_at: string;
}

export interface RoleAssignmentRow {
  id: string;
  session_id: string;
  method: 'algorithm' | 'llm';
  result: unknown; // RoleAssignmentResult
  schedule: unknown; // SessionSchedule
  created_at: string;
}

export interface MeetRoomRow {
  id: string;
  session_id: string;
  slot_index: number;
  team_topic_id: string;
  iteration: number;
  /** Meet API resource name, e.g. "spaces/abc123...". */
  space_name: string;
  /** Join URL (https://meet.google.com/...). */
  meet_uri: string;
  /** "conferenceRecords/..." resource name; backfilled when the room ends and Meet creates a record. */
  conference_name: string | null;
  created_at: string;
  ended_at: string | null;
  transcript_drive_file_id: string | null;
  transcript_fetched_at: string | null;
}

/** Speaker label on a captured transcript line. role mirrors SessionRole. */
export interface TranscriptParticipantLabel {
  participantId: string;
  name: string;
  role: 'member' | 'critic';
}

export interface SessionTranscriptRow {
  id: string;
  session_id: string;
  slot_index: number;
  team_topic_id: string;
  topic_title: string;
  iteration: number;
  meet_room_id: string;
  transcript_text: string;
  participants: TranscriptParticipantLabel[];
  created_at: string;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

export function participantRowToDomain(row: ParticipantRow): Participant {
  return {
    id: row.id as ParticipantId,
    name: row.name,
    avatarUrl: row.avatar_url ?? undefined,
    discordHandle: row.discord_handle ?? undefined,
  };
}

/** A finalized topic card bound to a vertex (its index in the ordered winners). */
export function topicCardRowToTopic(row: TopicCardRow, vertexIndex: VertexIndex): Topic {
  return {
    id: row.id as TopicId,
    vertexIndex,
    title: row.title,
    rationale: row.rationale,
  };
}

export function preferenceRowToDomain(row: PreferenceRow): TopicPreference {
  return {
    participantId: row.participant_id as ParticipantId,
    rankedTopicIds: row.ranked_topic_ids as TopicId[],
  };
}
