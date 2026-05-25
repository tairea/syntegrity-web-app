/**
 * Scheduled-session store.
 *
 * Owns the lifecycle of a session that is created in the future:
 *   create  → insert sessions row with status='scheduled' + chosen format
 *   load    → fetch session + commitments + realtime-subscribe to commitments
 *   commit  → insert a scheduled_commitments row + fire schedule-invite email
 *   uncommit → delete commitment
 *   promoteToLive → idempotent flip at T-10min: create participants from
 *                   commitments, set status='live', so the existing lobby
 *                   flow takes over.
 *
 * Kept separate from useSessionStore because the schedule lifecycle is short
 * and table-disjoint (it only writes sessions + scheduled_commitments +
 * participants), and the invite page doesn't need the full session machinery.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { Channel } from './realtime';
import type { ScheduledCommitmentRow, SessionRow } from '@/services/db-types';
import { SHAPE_META, type ShapeName } from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';

/** T−10min: from this point the invite link opens the live lobby instead. */
export const LOBBY_OPEN_OFFSET_MS = 10 * 60 * 1000;

const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const PID_KEY = (sid: string) => `syntegrity:pid:${sid}`;
const OWNER_KEY = (code: string) => `syntegrity:scheduled-owner:${code.toUpperCase()}`;

export const useScheduleStore = defineStore('schedule', () => {
  const session = ref<SessionRow | null>(null);
  const commitments = ref<ScheduledCommitmentRow[]>([]);
  let commitChannel: Channel | null = null;

  const capacity = computed(() => session.value?.headcount_target ?? 0);
  const isFull = computed(() => commitments.value.length >= capacity.value && capacity.value > 0);

  // ── create ────────────────────────────────────────────────────────────
  async function createScheduledSession(params: {
    drivingQuestion: string;
    shape: ShapeName;
    formatId: SessionFormatId;
    startUtc: string;       // ISO
    timezone: string;       // IANA TZ string
  }): Promise<{ sessionId: string; code: string; creatorToken: string }> {
    const format = getFormat(params.formatId);
    if (format.shape !== params.shape) {
      throw new Error(`Format ${params.formatId} is for ${format.shape}, not ${params.shape}`);
    }
    const meta = SHAPE_META[params.shape];
    const creatorToken = crypto.randomUUID();

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        code: randomCode(),
        driving_question: params.drivingQuestion,
        phase: 'lobby',
        status: 'scheduled',
        locked_shape: params.shape,
        headcount_target: meta.participantCount,
        roster_locked: true,
        scheduled_start_at: params.startUtc,
        scheduled_timezone: params.timezone,
        session_format_id: params.formatId,
        scheduled_duration_minutes: format.totalMinutes,
        creator_token: creatorToken,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Create scheduled session failed: ${error?.message}`);
    const row = data as SessionRow;
    rememberCreatorToken(row.code, creatorToken);
    return { sessionId: row.id, code: row.code, creatorToken };
  }

  // ── creator-token helpers ─────────────────────────────────────────────
  function rememberCreatorToken(code: string, token: string): void {
    try { localStorage.setItem(OWNER_KEY(code), token); } catch { /* ignore */ }
  }
  function getStoredCreatorToken(code: string): string | null {
    try { return localStorage.getItem(OWNER_KEY(code)); } catch { return null; }
  }

  // ── load (+ realtime) ─────────────────────────────────────────────────
  async function loadByCode(code: string): Promise<void> {
    const { data: s } = await supabase
      .from('sessions')
      .select('*')
      .eq('code', code.toUpperCase())
      .maybeSingle();
    if (!s) throw new Error('Scheduled session not found');
    session.value = s as SessionRow;
    await refreshCommitments();
    subscribeCommitments(session.value.id);
  }

  async function refreshCommitments(): Promise<void> {
    if (!session.value) return;
    const { data } = await supabase
      .from('scheduled_commitments')
      .select('*')
      .eq('session_id', session.value.id)
      .order('created_at', { ascending: true });
    commitments.value = (data ?? []) as ScheduledCommitmentRow[];
  }

  function subscribeCommitments(sid: string): void {
    if (commitChannel) {
      void supabase.removeChannel(commitChannel);
      commitChannel = null;
    }
    const ch = supabase.channel(`schedule:${sid}:commitments`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ch as any).on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'scheduled_commitments', filter: `session_id=eq.${sid}` },
      // Cheap: refetch the whole list on any change. Capacity caps at 60.
      () => { void refreshCommitments(); },
    );
    ch.subscribe();
    commitChannel = ch;
  }

  async function unsubscribe(): Promise<void> {
    if (commitChannel) {
      await supabase.removeChannel(commitChannel);
      commitChannel = null;
    }
  }

  // ── commit / uncommit ─────────────────────────────────────────────────
  async function commit(params: {
    email: string;
    name: string;
    avatarUrl: string | null;
    discordHandle?: string | null;
  }): Promise<ScheduledCommitmentRow> {
    if (!session.value) throw new Error('No scheduled session loaded');
    if (isFull.value) throw new Error('This session is full');

    const { data, error } = await supabase
      .from('scheduled_commitments')
      .insert({
        session_id: session.value.id,
        email: params.email.trim().toLowerCase(),
        name: params.name.trim(),
        avatar_url: params.avatarUrl,
        discord_handle: params.discordHandle?.trim() || null,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Commit failed: ${error?.message}`);
    const row = data as ScheduledCommitmentRow;

    // Fire the calendar invite. We don't block the user on email delivery — they
    // see their slot filled regardless — but we surface failures so they can
    // retry.
    const returnUrl = `${window.location.origin}/scheduled/${session.value.code}?token=${row.commit_token}`;
    try {
      const { error: fnErr } = await supabase.functions.invoke('schedule-invite', {
        body: {
          to: row.email,
          sessionCode: session.value.code,
          drivingQuestion: session.value.driving_question,
          startUtc: session.value.scheduled_start_at,
          durationMinutes: session.value.scheduled_duration_minutes,
          returnUrl,
          commitToken: row.commit_token,
        },
      });
      if (fnErr) console.warn('[schedule-invite] email failed', fnErr);
    } catch (e) {
      console.warn('[schedule-invite] invoke threw', e);
    }
    return row;
  }

  async function uncommit(commitmentId: string): Promise<void> {
    await supabase.from('scheduled_commitments').delete().eq('id', commitmentId);
  }

  /**
   * Update the driving question on the loaded scheduled session. Only callable
   * if the caller knows the session's creator_token — checked server-side via
   * the .eq('creator_token', …) filter so a wrong token returns zero rows.
   */
  async function updateDrivingQuestion(token: string, text: string): Promise<void> {
    if (!session.value) throw new Error('No scheduled session loaded');
    const next = text.trim();
    if (!next) throw new Error('Driving question cannot be empty');
    const { data, error } = await supabase
      .from('sessions')
      .update({ driving_question: next })
      .eq('id', session.value.id)
      .eq('creator_token', token)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Not authorised to edit this session');
    session.value = data as SessionRow;
  }

  function findByToken(token: string): ScheduledCommitmentRow | undefined {
    return commitments.value.find((c) => c.commit_token === token);
  }

  // ── promote to live (idempotent) ──────────────────────────────────────
  /**
   * Materialise commitments as real participants and flip status='live'. Safe to
   * call concurrently: every step is filtered to act only on rows that haven't
   * been promoted yet.
   */
  async function promoteToLive(sessionId: string): Promise<void> {
    const { data: s } = await supabase.from('sessions').select('*').eq('id', sessionId).maybeSingle();
    if (!s) throw new Error('Session not found');
    const row = s as SessionRow;
    if (row.status === 'live') return;

    const { data: pending } = await supabase
      .from('scheduled_commitments')
      .select('*')
      .eq('session_id', sessionId)
      .is('participant_id', null);

    for (const c of (pending ?? []) as ScheduledCommitmentRow[]) {
      const { data: p, error: pErr } = await supabase
        .from('participants')
        .insert({
          session_id: sessionId,
          name: c.name,
          avatar_url: c.avatar_url,
          discord_handle: c.discord_handle,
        })
        .select()
        .single();
      if (pErr || !p) continue;
      await supabase
        .from('scheduled_commitments')
        .update({ participant_id: (p as { id: string }).id })
        .eq('id', c.id)
        .is('participant_id', null);
    }

    await supabase.from('sessions').update({ status: 'live' }).eq('id', sessionId).eq('status', 'scheduled');
  }

  /**
   * After promoteToLive, claim the participant slot for the current browser by
   * writing its id to localStorage. The existing session store reads this on
   * connect.
   */
  function claimLocalIdentity(sessionId: string, participantId: string): void {
    localStorage.setItem(PID_KEY(sessionId), participantId);
  }

  return {
    // state
    session, commitments, capacity, isFull,
    // create / load
    createScheduledSession, loadByCode, refreshCommitments, unsubscribe,
    // commit
    commit, uncommit, findByToken,
    // creator/edit
    rememberCreatorToken, getStoredCreatorToken, updateDrivingQuestion,
    // promote
    promoteToLive, claimLocalIdentity,
  };
});
