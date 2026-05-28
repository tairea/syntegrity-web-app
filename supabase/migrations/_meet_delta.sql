-- Outcome Resolve + Google Meet delta. Idempotent: re-runnable safely.
-- After applying, the canonical source remains supabase/schema.sql.

-- ── sessions: outcome-resolve runtime state ──────────────────────────────────
alter table sessions add column if not exists resolve_current_slot_index int;
alter table sessions add column if not exists resolve_slot_started_at timestamptz;

-- ── meet_rooms ───────────────────────────────────────────────────────────────
create table if not exists meet_rooms (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  slot_index int not null,
  team_topic_id uuid not null,
  iteration int not null,
  space_name text not null,
  meet_uri text not null,
  conference_name text,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript_drive_file_id text,
  transcript_fetched_at timestamptz
);
create index if not exists meet_rooms_session_slot_idx on meet_rooms (session_id, slot_index);

-- ── session_transcripts ──────────────────────────────────────────────────────
create table if not exists session_transcripts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  slot_index int not null,
  team_topic_id uuid not null,
  topic_title text not null,
  iteration int not null,
  meet_room_id uuid not null references meet_rooms(id) on delete cascade,
  transcript_text text not null,
  participants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (meet_room_id)
);
create index if not exists session_transcripts_session_slot_idx on session_transcripts (session_id, slot_index);

-- ── meet_credentials (server-only; refresh tokens) ───────────────────────────
create table if not exists meet_credentials (
  host_email text primary key,
  refresh_token text not null,
  scopes text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Realtime publication: add new public tables if not already published ─────
-- `alter publication ... add table` errors on duplicates, so wrap each in
-- a per-table do-block that swallows duplicate_object.
do $$
begin
  alter publication supabase_realtime add table meet_rooms;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table session_transcripts;
exception
  when duplicate_object then null;
end $$;

-- ── REPLICA IDENTITY FULL on the new public tables ───────────────────────────
alter table meet_rooms replica identity full;
alter table session_transcripts replica identity full;

-- ── RLS: anon_all on the new public tables; lockdown on meet_credentials ─────
alter table meet_rooms enable row level security;
drop policy if exists anon_all on meet_rooms;
create policy anon_all on meet_rooms for all using (true) with check (true);

alter table session_transcripts enable row level security;
drop policy if exists anon_all on session_transcripts;
create policy anon_all on session_transcripts for all using (true) with check (true);

-- meet_credentials: RLS on, no anon policy → anon key cannot read or write.
-- Edge functions using the service role key bypass RLS, which is the point.
alter table meet_credentials enable row level security;
drop policy if exists anon_all on meet_credentials;
