/**
 * Session orchestrator: anonymous identity, create/join, the single realtime
 * channel, the phase state machine, driver election, and the driver tick that
 * advances phases / runs reconciliation / drives bots.
 *
 * Driver = the one client that performs authoritative writes (phase transitions,
 * roster lock, reconciliation resolve, bot actions). Elected deterministically:
 * the creator if present, else the lowest-id present human. Phase writes are
 * conditional (eq('phase', from)) so a race can't double-advance.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase, sessionChannelName } from '@/services/supabase';
import { subscribeTable, loadTable, type Channel } from './realtime';
import type {
  ClusterMessageRow, ClusterRow, MeetRoomRow, MergeRequestRow, ParticipantRow, PreferenceRow,
  RoleAssignmentRow, SessionPhase, SessionRow, StatementRow, TopicCardRow, VoteRow,
} from '@/services/db-types';
import { ENCODED_SIZES, reconciliationPlan, participantsToTrim } from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import { createMeetRooms, endMeetRooms, fetchMeetTranscripts } from '@/services/meet';
import { useParticipantsStore } from './participants';
import { useJostleStore } from './jostle';
import { useVotingStore } from './voting';
import { usePreferenceStore } from './preference';
import { useGraphStore } from './graph';
import { useBotStore } from './bots';
import { useMeetRoomsStore } from './meetRooms';

const PID_KEY = (sessionId: string) => `syntegrity:pid:${sessionId}`;
const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

export const useSessionStore = defineStore('session', () => {
  const session = ref<SessionRow | null>(null);
  const myParticipantId = ref<string | null>(null);
  const channel = ref<Channel | null>(null);
  const countdown = ref<{ to: SessionPhase; n: number } | null>(null);
  /** Participant ids currently flagged as in the session coordination call. */
  const callParticipantIds = ref<string[]>([]);
  /** Whether THIS client is in the call right now (drives its presence meta). */
  const inCallSelf = ref(false);
  let transitioning = false;
  let ticking = false;
  let sessionSpaceCreating = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let tableChannels: Channel[] = [];
  /** Merge/reconciliation request ids this client has already resolved (idempotency vs realtime lag). */
  const resolvedRequests = new Set<string>();

  const sessionId = computed(() => session.value?.id ?? '');
  const phase = computed<SessionPhase>(() => session.value?.phase ?? 'lobby');
  const drivingQuestion = computed(() => session.value?.driving_question ?? '');
  const isCreator = computed(() => !!session.value && session.value.creator_participant_id === myParticipantId.value);

  /** Deterministic driver election (creator if online, else lowest-id online human). */
  const driverId = computed<string | null>(() => {
    const p = useParticipantsStore();
    const onlineHumans = p.humans.filter((h) => p.online.has(h.id)).map((h) => h.id);
    if (session.value?.creator_participant_id && onlineHumans.includes(session.value.creator_participant_id)) {
      return session.value.creator_participant_id;
    }
    return onlineHumans.sort()[0] ?? null;
  });
  const isDriver = computed(() => !!myParticipantId.value && myParticipantId.value === driverId.value);

  // ── identity ──────────────────────────────────────────────────────────
  function ensureIdentity(sid: string): string {
    if (myParticipantId.value) return myParticipantId.value;
    const stored = localStorage.getItem(PID_KEY(sid));
    const id = stored ?? crypto.randomUUID();
    if (!stored) localStorage.setItem(PID_KEY(sid), id);
    myParticipantId.value = id;
    return id;
  }

  // ── create / join ─────────────────────────────────────────────────────
  async function createSession(question: string): Promise<{ sessionId: string; code: string }> {
    const code = randomCode();
    const pid = crypto.randomUUID();
    myParticipantId.value = pid;
    const { data, error } = await supabase
      .from('sessions')
      .insert({ code, driving_question: question, creator_participant_id: pid, phase: 'lobby' })
      .select()
      .single();
    if (error || !data) throw new Error(`Create session failed: ${error?.message}`);
    const row = data as SessionRow;
    localStorage.setItem(PID_KEY(row.id), pid);
    session.value = row;
    return { sessionId: row.id, code: row.code };
  }

  async function resolveCode(code: string): Promise<SessionRow> {
    const { data } = await supabase.from('sessions').select('*').eq('code', code.toUpperCase()).maybeSingle();
    if (!data) throw new Error('Session not found.');
    return data as SessionRow;
  }

  // ── connect (wire channel + hydrate) ────────────────────────────────────
  async function connect(sid: string): Promise<void> {
    if (channel.value && session.value?.id === sid) return;
    ensureIdentity(sid);
    // maybeSingle so a deleted/missing session returns null (not a 406).
    const { data } = await supabase.from('sessions').select('*').eq('id', sid).maybeSingle();
    session.value = (data as SessionRow) ?? null;
    if (!session.value) return; // SessionShell handles the missing-session redirect.

    const participants = useParticipantsStore();
    const jostle = useJostleStore();
    const voting = useVotingStore();
    const preference = usePreferenceStore();
    const graph = useGraphStore();
    const meetRooms = useMeetRoomsStore();

    // One channel per table (multiple postgres_changes bindings on a single
    // channel silently fail — see subscribeTable).
    tableChannels = [
      subscribeTable(sid, 'sessions', (p) => { if (p.eventType !== 'DELETE') session.value = p.new as SessionRow; }, 'id'),
      subscribeTable(sid, 'participants', (p) => participants.applyChange(p)),
      subscribeTable(sid, 'statements', (p) => jostle.applyStatement(p)),
      subscribeTable(sid, 'clusters', (p) => jostle.applyCluster(p)),
      subscribeTable(sid, 'cluster_messages', (p) => jostle.applyMessage(p)),
      subscribeTable(sid, 'topic_cards', (p) => voting.applyCard(p)),
      subscribeTable(sid, 'votes', (p) => voting.applyVote(p)),
      subscribeTable(sid, 'merge_requests', (p) => voting.applyMerge(p)),
      subscribeTable(sid, 'preferences', (p) => preference.applyChange(p)),
      subscribeTable(sid, 'role_assignments', (p) => { if (p.eventType !== 'DELETE') graph.apply(p.new as RoleAssignmentRow); }),
      subscribeTable(sid, 'meet_rooms', (p) => meetRooms.applyChange(p)),
    ];

    // Main channel carries presence + broadcast only.
    const ch = supabase.channel(sessionChannelName(sid), { config: { presence: { key: myParticipantId.value ?? 'anon' } } });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as unknown as Record<string, Array<{ inCall?: boolean }>>;
      participants.setOnline(Object.keys(state));
      // Best-effort "in the call" count: app-level presence meta (set when a
      // client clicks Join Live Call, cleared when they return to the app tab),
      // NOT a true Google Meet roster (that would require the Meet API).
      callParticipantIds.value = Object.entries(state)
        .filter(([, metas]) => metas.some((m) => m?.inCall))
        .map(([key]) => key);
    });
    ch.on('broadcast', { event: 'countdown' }, ({ payload }) => {
      countdown.value = payload as { to: SessionPhase; n: number };
      if ((payload as { n: number }).n <= 0) setTimeout(() => (countdown.value = null), 800);
    });

    // Hydrate via REST BEFORE resolving connect, so callers (e.g. SessionShell's
    // profile guard) can rely on data being present once connect() returns.
    // Initial fetch doesn't need the realtime channel — only live updates do.
    participants.load(await loadTable<ParticipantRow>('participants', sid));
    jostle.load(
      await loadTable<StatementRow>('statements', sid),
      await loadTable<ClusterRow>('clusters', sid),
      await loadTable<ClusterMessageRow>('cluster_messages', sid),
    );
    voting.load(
      await loadTable<TopicCardRow>('topic_cards', sid),
      await loadTable<VoteRow>('votes', sid),
      await loadTable<MergeRequestRow>('merge_requests', sid),
    );
    preference.load(await loadTable<PreferenceRow>('preferences', sid));
    graph.load(await loadTable<RoleAssignmentRow>('role_assignments', sid));
    meetRooms.load(await loadTable<MeetRoomRow>('meet_rooms', sid));

    // Subscribe for live updates + presence (fire-and-forget; hydration is done).
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ participantId: myParticipantId.value, at: Date.now(), inCall: inCallSelf.value });
    });

    channel.value = ch;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => void driverTick(), 1500);
  }

  async function disconnect(): Promise<void> {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    const all = [...tableChannels, ...(channel.value ? [channel.value] : [])];
    tableChannels = [];
    channel.value = null;
    for (const c of all) {
      await supabase.removeChannel(c as Parameters<typeof supabase.removeChannel>[0]);
    }
  }

  // ── phase transitions ─────────────────────────────────────────────────
  async function setPhase(from: SessionPhase, to: SessionPhase): Promise<void> {
    await supabase.from('sessions').update({ phase: to, updated_at: new Date().toISOString() }).eq('id', sessionId.value).eq('phase', from);
  }

  /** Driver-only: 5→1 countdown (broadcast), run onComplete, then advance phase. */
  async function startCountdown(from: SessionPhase, to: SessionPhase, onComplete?: () => Promise<void>): Promise<void> {
    if (transitioning) return;
    transitioning = true;
    try {
      for (let n = 5; n >= 1; n--) {
        countdown.value = { to, n };
        channel.value?.send({ type: 'broadcast', event: 'countdown', payload: { to, n } });
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (onComplete) await onComplete();
      await setPhase(from, to);
      channel.value?.send({ type: 'broadcast', event: 'countdown', payload: { to, n: 0 } });
      countdown.value = null;
    } finally {
      transitioning = false;
    }
  }

  /** A user voluntarily enters Problem Jostle (flips session phase once). */
  async function enterJostle(): Promise<void> {
    if (phase.value === 'lobby') await setPhase('lobby', 'jostle');
  }

  function shapeForExact(count: number) {
    return ENCODED_SIZES.find((e) => e.size === count) ?? null;
  }

  // ── session-level Meet space ──────────────────────────────────────────────
  /** Create the persistent coordination Meet space for this session.
   *  Fire-and-forget from driverTick; realtime delivers meet_space_uri back. */
  async function createSessionSpace(): Promise<void> {
    if (sessionSpaceCreating || session.value?.meet_space_uri) return;
    sessionSpaceCreating = true;
    try {
      await supabase.functions.invoke('meet-create-session-space', {
        body: { sessionId: sessionId.value },
      });
      // Realtime subscription on 'sessions' delivers the updated row (including
      // meet_space_uri) back to session.value — no local mutation needed here.
    } finally {
      sessionSpaceCreating = false;
    }
  }

  /**
   * Flag/unflag this client as in the session coordination call. Re-tracks
   * presence so every other client's `callParticipantIds` (and the count on the
   * Join Live Call button) updates via the presence sync event.
   */
  async function setInCall(value: boolean): Promise<void> {
    inCallSelf.value = value;
    await channel.value?.track({ participantId: myParticipantId.value, at: Date.now(), inCall: value });
  }

  // ── driver tick ─────────────────────────────────────────────────────────
  async function driverTick(): Promise<void> {
    // Re-entrancy guard: the interval fires every 1.5s but a tick is async and
    // may still be running. Without this, overlapping ticks double-fire
    // reconciliation/bot-spawn and runaway.
    if (ticking || transitioning) return;
    if (!isDriver.value || !session.value) return;
    ticking = true;
    try {
      // Ensure the session-level coordination space exists. Fire-and-forget;
      // does not block the tick. Realtime delivers the update to session.value.
      if (!session.value.meet_space_uri && !sessionSpaceCreating) void createSessionSpace();

      const s = session.value;
      const participants = useParticipantsStore();
      const voting = useVotingStore();
      const preference = usePreferenceStore();
      const bots = useBotStore();
      const graph = useGraphStore();
      const dq = s.driving_question;

      // Resolve any expired merge / reconciliation requests.
      await resolveExpiredRequests();

      if (s.phase === 'jostle') {
        // Lock roster at >50% jostle-ready.
        if (!s.roster_locked && participants.over50Ready('jostle')) {
          await lockRoster();
          return;
        }
        // Bot jostle statements are now triggered MANUALLY (the "Add bot statements"
        // button) so no LLM calls fire automatically during testing.
        // Advance only once locked + shape resolved + everyone ready.
        const reconOpen = voting.openMerges.some((m) => m.kind === 'reconciliation');
        if (s.roster_locked && s.locked_shape && !reconOpen && participants.allReady('jostle')) {
          await startCountdown('jostle', 'voting', async () => {
            await voting.seedCards(sessionId.value, useJostleStore().clusterList);
          });
        }
      } else if (s.phase === 'voting') {
        if (voting.visibleCards.length === 0) await voting.seedCards(sessionId.value, useJostleStore().clusterList);
        await bots.driveForPhase(sessionId.value, 'voting', dq);
        const allVoted = participants.active.length > 0 && participants.active.every((p) => voting.votesCast(p.id) >= voting.VOTES_PER_PARTICIPANT);
        if (allVoted) await startCountdown('voting', 'preference');
      } else if (s.phase === 'preference') {
        await bots.driveForPhase(sessionId.value, 'preference', dq);
        if (preference.allSaved(participants.active.map((p) => p.id))) await startCountdown('preference', 'graph');
      } else if (s.phase === 'graph') {
        void graph.compute('algorithm');
        void graph.compute('llm');
        // Outcome Resolve kickoff: host has chosen a format AND every active
        // participant has marked resolve-ready. Driver mints slot-0 rooms,
        // then flips phase + stamps the timer.
        if (s.session_format_id && participants.allReady('resolve')) {
          await startResolve(s);
        }
      } else if (s.phase === 'resolve') {
        await advanceResolveIfDue(s);
      }
    } finally {
      ticking = false;
    }
  }

  /** Read slot duration (minutes) from the chosen format's outcome-resolve stage. */
  function getSlotMinutes(formatId: string | null): number {
    if (!formatId) return 15;
    try {
      const fmt = getFormat(formatId as SessionFormatId);
      const stage = fmt.stages.find((st) => st.kind === 'outcome-resolve');
      // Narrow via kind discriminator; both fields live on OutcomeResolveStage.
      if (stage && stage.kind === 'outcome-resolve') return stage.slotMinutes;
    } catch { /* fall through to default */ }
    return 15;
  }

  /** graph → resolve transition. Idempotent: re-entry is guarded by eq('phase','graph'). */
  async function startResolve(s: SessionRow): Promise<void> {
    // 1. Mint rooms for slot 0 (idempotent server-side: returns existing rooms
    //    if any already exist for that slot). Do this BEFORE flipping phase so
    //    non-driver clients don't briefly see resolve-phase with no rooms.
    try {
      await createMeetRooms(s.id, 0);
    } catch (e) {
      console.error('[resolve] meet-create-rooms slot 0 failed:', (e as Error).message);
      return; // don't flip phase if room creation failed — try again next tick
    }
    // 2. Flip phase + stamp slot timer. Conditional on phase=graph so a race
    //    can't double-advance.
    await supabase
      .from('sessions')
      .update({
        phase: 'resolve',
        resolve_current_slot_index: 0,
        resolve_slot_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', s.id)
      .eq('phase', 'graph');
  }

  /**
   * Resolve-phase tick: end the current slot's rooms when the timer expires,
   * then move on to the next slot (or to 'done' if no slots remain). The 5s
   * visible warning countdown is computed CLIENT-SIDE from resolve_slot_started_at
   * + format.slotMinutes — the driver only does the actual end-rooms call.
   */
  async function advanceResolveIfDue(s: SessionRow): Promise<void> {
    if (s.resolve_current_slot_index == null || !s.resolve_slot_started_at) return;
    const slotMinutes = getSlotMinutes(s.session_format_id);
    const slotEndsAt = new Date(s.resolve_slot_started_at).getTime() + slotMinutes * 60_000;
    if (Date.now() < slotEndsAt) return; // not yet due

    const currentIdx = s.resolve_current_slot_index;

    // 1. End rooms for current slot (idempotent server-side).
    try {
      await endMeetRooms(s.id, currentIdx);
    } catch (e) {
      console.error('[resolve] meet-end-rooms failed:', (e as Error).message);
      // Don't return — still try to advance. Transcripts may still arrive.
    }

    // 2. Fire-and-forget transcript fetch (may not be ready yet; the function
    //    returns notReady in that case and we can re-poll later if we want).
    void fetchMeetTranscripts({ sessionId: s.id, slotIndex: currentIdx }).catch((e) => {
      console.warn('[resolve] meet-fetch-transcript failed (will retry on next tick):', (e as Error).message);
    });

    // 3. Figure out the next slot from the schedule.
    const graph = useGraphStore();
    const schedule = graph.activeSchedule;
    const totalSlots = schedule?.slots.length ?? 0;
    const nextIdx = currentIdx + 1;

    if (!schedule || nextIdx >= totalSlots) {
      // All slots done. Clear timer state + close session.
      await supabase
        .from('sessions')
        .update({
          phase: 'done',
          resolve_current_slot_index: null,
          resolve_slot_started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', s.id)
        .eq('phase', 'resolve');
      return;
    }

    // 4. Create next-slot rooms BEFORE updating the index, so non-driver clients
    //    don't see a slot pointer with no rooms.
    try {
      await createMeetRooms(s.id, nextIdx);
    } catch (e) {
      console.error(`[resolve] meet-create-rooms slot ${nextIdx} failed:`, (e as Error).message);
      return; // retry next tick — leave index pointing at the old slot
    }
    await supabase
      .from('sessions')
      .update({
        resolve_current_slot_index: nextIdx,
        resolve_slot_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', s.id)
      .eq('phase', 'resolve');
  }

  async function lockRoster(): Promise<void> {
    if (!session.value || session.value.roster_locked) return;
    const participants = useParticipantsStore();
    const voting = useVotingStore();
    // Optimistically set the local flag so a re-entrant tick (before the realtime
    // echo arrives) doesn't lock/open a reconciliation twice.
    session.value = { ...session.value, roster_locked: true };

    const headcount = participants.active.length;
    const exact = shapeForExact(headcount);
    if (exact) {
      await supabase.from('sessions').update({ roster_locked: true, locked_shape: exact.shape, headcount_target: exact.size }).eq('id', sessionId.value);
      return;
    }
    await supabase.from('sessions').update({ roster_locked: true }).eq('id', sessionId.value);
    // Never open a second reconciliation if one already exists.
    if (voting.openMerges.some((m) => m.kind === 'reconciliation')) return;
    const plan = reconciliationPlan(headcount);
    const expires = new Date(Date.now() + 30000).toISOString();
    await supabase.from('merge_requests').insert({
      session_id: sessionId.value, kind: 'reconciliation', expires_at: expires, up: [], down: [],
      payload: { headcount, trim: plan.trim, pad: plan.pad },
    });
  }

  async function resolveExpiredRequests(): Promise<void> {
    const voting = useVotingStore();
    const now = Date.now();
    for (const m of voting.openMerges) {
      if (new Date(m.expires_at).getTime() > now) continue;
      // Resolve each request at most once on this client, regardless of how long
      // the status update takes to echo back over realtime. Prevents re-resolving
      // (and re-spawning bots) on subsequent ticks.
      if (resolvedRequests.has(m.id)) continue;
      resolvedRequests.add(m.id);
      if (m.kind === 'merge') {
        await voting.resolveMerge(sessionId.value, drivingQuestion.value, m);
      } else {
        await resolveReconciliation(m);
      }
    }
  }

  async function resolveReconciliation(m: MergeRequestRow): Promise<void> {
    const participants = useParticipantsStore();
    const bots = useBotStore();
    const payload = m.payload as { trim?: { toShape: string; toCount: number; removeCount: number }; pad?: { toShape: string; toCount: number; addCount: number } };
    const padWins = m.up.length >= m.down.length ? !!payload.pad : false;
    const chosen = padWins ? payload.pad : (payload.trim ?? payload.pad);
    if (!chosen) { await supabase.from('merge_requests').update({ status: 'rejected' }).eq('id', m.id); return; }

    if (payload.pad && chosen === payload.pad) {
      await bots.spawnBots(sessionId.value, payload.pad.addCount);
    } else if (payload.trim) {
      // Trim the LAST-joined participants (bots and humans alike), oldest kept.
      // Using all active — not just humans — so the earliest joiners (e.g. the
      // creator) are never removed before later-joined bots.
      const order = [...participants.active].sort((a, b) => a.joined_at.localeCompare(b.joined_at)).map((p) => p.id);
      await participants.markRemoved(participantsToTrim(order, payload.trim.removeCount));
    }
    await supabase.from('sessions').update({ locked_shape: chosen.toShape, headcount_target: chosen.toCount }).eq('id', sessionId.value);
    await supabase.from('merge_requests').update({ status: 'approved' }).eq('id', m.id);
  }

  /**
   * Swap the session's format. Used at the graph-reveal step when reconciliation
   * has changed `locked_shape` and the original format no longer matches — the
   * host picks a compatible format from the sidebar dropdown.
   */
  async function updateSessionFormat(formatId: string): Promise<void> {
    if (!sessionId.value) return;
    const { data, error } = await supabase
      .from('sessions')
      .update({ session_format_id: formatId })
      .eq('id', sessionId.value)
      .select()
      .single();
    if (error) throw new Error(error.message);
    if (data) session.value = data as SessionRow;
  }

  return {
    session, myParticipantId, channel, countdown, sessionId, phase, drivingQuestion, isCreator,
    driverId, isDriver, callParticipantIds,
    ensureIdentity, createSession, resolveCode, connect, disconnect,
    setPhase, startCountdown, enterJostle, updateSessionFormat, createSessionSpace, setInCall,
  };
});
