-- Syntegrity prototype schema. Run in the Supabase SQL editor.
-- Prototype RLS is permissive (anon read/write). HARDEN BEFORE PRODUCTION.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  driving_question text not null default '',
  creator_participant_id uuid,
  phase text not null default 'lobby',          -- lobby|reconciliation|jostle|voting|preference|graph|done
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

-- ── Realtime publication ─────────────────────────────────────────────────────
alter publication supabase_realtime add table
  sessions, participants, statements, clusters, cluster_messages,
  topic_cards, votes, merge_requests, preferences, role_assignments,
  scheduled_commitments;

-- REPLICA IDENTITY FULL so filtered realtime DELETE events carry the full old
-- row (incl. session_id). Without this, filtered subscriptions never receive
-- DELETEs (the filter column isn't in the default PK-only delete payload).
do $$
declare t text;
begin
  foreach t in array array[
    'sessions','participants','statements','clusters','cluster_messages',
    'topic_cards','votes','merge_requests','preferences','role_assignments',
    'scheduled_commitments'
  ] loop
    execute format('alter table %I replica identity full;', t);
  end loop;
end $$;

-- ── Permissive prototype RLS (HARDEN BEFORE PRODUCTION) ──────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'sessions','participants','statements','clusters','cluster_messages',
    'topic_cards','votes','merge_requests','preferences','role_assignments',
    'scheduled_commitments'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists anon_all on %I;', t);
    execute format('create policy anon_all on %I for all using (true) with check (true);', t);
  end loop;
end $$;

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
