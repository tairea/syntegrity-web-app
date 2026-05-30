-- Syntegrity prototype schema. Run in the Supabase SQL editor.
-- Prototype RLS is permissive (anon read/write). HARDEN BEFORE PRODUCTION.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  driving_question text not null default '',
  creator_participant_id uuid,
  phase text not null default 'lobby',          -- lobby|reconciliation|jostle|voting|preference|graph|resolve|done
  phase_payload jsonb not null default '{}'::jsonb,
  locked_shape text,                             -- tetrahedron|octahedron|icosahedron (null until reconciled)
  roster_locked boolean not null default false,
  headcount_target int,                          -- 6|12|30 (null until lock)
  -- Scheduling (null on synchronous sessions; populated by /schedule flow)
  status text not null default 'live',          -- live|scheduled|done
  scheduled_start_at timestamptz,
  scheduled_timezone text,                       -- IANA TZ string (e.g. 'Pacific/Auckland')
  session_format_id text,                        -- SessionFormatId from util/session-formats.ts
  scheduled_duration_minutes int,                -- denormalised from getFormat().totalMinutes
  creator_token uuid,                            -- secret returned to creator for ownership checks
  -- Outcome Resolve: which slot of the schedule is currently live, and when it started
  resolve_current_slot_index int,                -- null pre-resolve and post-resolve; 0..N during
  resolve_slot_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent column adds for pre-existing deployments.
alter table sessions add column if not exists status text not null default 'live';
alter table sessions add column if not exists scheduled_start_at timestamptz;
alter table sessions add column if not exists scheduled_timezone text;
alter table sessions add column if not exists session_format_id text;
alter table sessions add column if not exists scheduled_duration_minutes int;
-- Secret token returned to the user who created a scheduled session, so they
-- can later be recognised as the owner (e.g. edit the driving question).
alter table sessions add column if not exists creator_token uuid;
-- Outcome Resolve runtime state.
alter table sessions add column if not exists resolve_current_slot_index int;
alter table sessions add column if not exists resolve_slot_started_at timestamptz;
-- Persistent session-level Meet coordination space (lobby → done). Distinct from
-- meet_rooms.space_name / meet_uri which are per-slot, per-team breakout rooms.
alter table sessions add column if not exists meet_space_name text;
alter table sessions add column if not exists meet_space_uri  text;

create table if not exists participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  name text not null default '',
  avatar_url text,
  discord_handle text,
  is_bot boolean not null default false,
  removed boolean not null default false,        -- trimmed by reconciliation
  ready_flags jsonb not null default '{}'::jsonb, -- {jostle:bool, vote:bool, pref:bool, bot_acted:{...}}
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists statements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  participant_id uuid not null,
  cluster_id uuid,
  text text not null,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists clusters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  name text not null default '',
  summary text not null default '',              -- LLM rationale; reused as Topic.rationale
  vertex_hint int,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cluster_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  cluster_id uuid not null,
  participant_id uuid not null,
  text text not null,
  created_at timestamptz not null default now()
);

create table if not exists topic_cards (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  title text not null default '',
  rationale text not null default '',
  source_cluster_ids jsonb not null default '[]'::jsonb,
  merged_from jsonb,                             -- [cardA, cardB] when produced by a merge
  vote_count int not null default 0,             -- denormalized cache
  removed boolean not null default false,        -- soft-deleted when merged away
  created_at timestamptz not null default now()
);

create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  participant_id uuid not null,
  topic_card_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists merge_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  kind text not null default 'merge',            -- merge|reconciliation
  proposer_id uuid,
  card_a uuid,
  card_b uuid,
  expires_at timestamptz not null,
  up jsonb not null default '[]'::jsonb,          -- participantId[]
  down jsonb not null default '[]'::jsonb,        -- participantId[]
  status text not null default 'open',           -- open|approved|rejected
  result_card_id uuid,
  payload jsonb not null default '{}'::jsonb,     -- reconciliation: {trimTo, padTo, affected, ...}
  created_at timestamptz not null default now()
);

create table if not exists preferences (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  participant_id uuid not null,
  ranked_topic_ids jsonb not null default '[]'::jsonb,
  saved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, participant_id)
);

create table if not exists role_assignments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  method text not null,                          -- algorithm|llm
  result jsonb not null,                         -- RoleAssignmentResult
  schedule jsonb not null,                       -- SessionSchedule
  created_at timestamptz not null default now(),
  unique (session_id, method)
);

-- Pre-commitments on a scheduled session. Email is the unique key per session;
-- commit_token authenticates the emailed return link. Flips to a real
-- participants row at T-10min via scheduleStore.promoteToLive().
create table if not exists scheduled_commitments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  email text not null,
  name text not null default '',
  avatar_url text,
  discord_handle text,
  commit_token uuid not null default gen_random_uuid(),
  participant_id uuid,                            -- filled when promoted at T-10min
  created_at timestamptz not null default now(),
  unique (session_id, email)
);

alter table scheduled_commitments add column if not exists discord_handle text;

-- ── Outcome Resolve: Google Meet rooms + captured transcripts ────────────────

-- One row per Meet room the host has spun up (one per (slot, team)). The room
-- is created via the Meet REST API at /v2/spaces and its `name` ("spaces/abc")
-- + join URL are recorded so the client can deep-link participants. Transcript
-- columns are backfilled by meet-fetch-transcript after the room ends.
create table if not exists meet_rooms (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  slot_index int not null,
  team_topic_id uuid not null,                    -- the TopicId of the team meeting in this room
  iteration int not null,                          -- 1..N; informational, mirrors MeetingSession.iteration
  space_name text not null,                        -- "spaces/abc..." (Meet API resource name)
  meet_uri text not null,                          -- https://meet.google.com/... join URL
  conference_name text,                            -- "conferenceRecords/xyz..."; filled after the room ends
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript_drive_file_id text,                   -- Drive file id of the transcript Doc
  transcript_fetched_at timestamptz
);
create index if not exists meet_rooms_session_slot_idx on meet_rooms (session_id, slot_index);

-- Final stored transcripts (post-meeting, pulled from Drive). One row per
-- meet_rooms row once the host's transcript Doc is exported. Topic title and
-- participants-role map are denormalized so exports/filenames stay stable
-- after participants/topics evolve.
create table if not exists session_transcripts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  slot_index int not null,
  team_topic_id uuid not null,
  topic_title text not null,
  iteration int not null,
  meet_room_id uuid not null references meet_rooms(id) on delete cascade,
  transcript_text text not null,
  -- [{participantId, name, role}] so we can relabel Meet's display-name speakers
  -- against our roles. Critical because the Meet API can't force display names.
  participants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (meet_room_id)
);
create index if not exists session_transcripts_session_slot_idx on session_transcripts (session_id, slot_index);

-- Host OAuth state for the Meet API. One row per host email. Refresh token is
-- minted by the one-time meet-oauth-callback consent flow and reused by all
-- runtime meet-* functions to mint short-lived access tokens.
create table if not exists meet_credentials (
  host_email text primary key,
  refresh_token text not null,
  scopes text not null,                            -- space-separated list of granted scopes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Realtime publication ─────────────────────────────────────────────────────
alter publication supabase_realtime add table
  sessions, participants, statements, clusters, cluster_messages,
  topic_cards, votes, merge_requests, preferences, role_assignments,
  scheduled_commitments, meet_rooms, session_transcripts;

-- REPLICA IDENTITY FULL so filtered realtime DELETE events carry the full old
-- row (incl. session_id). Without this, filtered subscriptions never receive
-- DELETEs (the filter column isn't in the default PK-only delete payload).
do $$
declare t text;
begin
  foreach t in array array[
    'sessions','participants','statements','clusters','cluster_messages',
    'topic_cards','votes','merge_requests','preferences','role_assignments',
    'scheduled_commitments','meet_rooms','session_transcripts'
  ] loop
    execute format('alter table %I replica identity full;', t);
  end loop;
end $$;

-- ── Permissive prototype RLS (HARDEN BEFORE PRODUCTION) ──────────────────────
-- meet_credentials is intentionally NOT in the anon_all list: the refresh token
-- is server-only and must never be readable by the anon key. Edge functions
-- using the service role bypass RLS regardless.
do $$
declare t text;
begin
  foreach t in array array[
    'sessions','participants','statements','clusters','cluster_messages',
    'topic_cards','votes','merge_requests','preferences','role_assignments',
    'scheduled_commitments','meet_rooms','session_transcripts'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists anon_all on %I;', t);
    execute format('create policy anon_all on %I for all using (true) with check (true);', t);
  end loop;
end $$;

-- meet_credentials: RLS on, no anon policy → anon key cannot read or write.
alter table meet_credentials enable row level security;
drop policy if exists anon_all on meet_credentials;

-- ── Avatars storage bucket (run once) ────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Permissive storage policy so anon can upload/read/replace avatars.
-- Upsert needs INSERT + SELECT + UPDATE, so use FOR ALL. HARDEN BEFORE PRODUCTION.
drop policy if exists avatars_anon_all on storage.objects;
create policy avatars_anon_all on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'avatars')
  with check (bucket_id = 'avatars');
