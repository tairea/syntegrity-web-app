/**
 * Bot subsystem. Only the elected driver client (see useSessionStore) calls
 * these. Bots are real participant rows (is_bot=true) spawned by PAD
 * reconciliation; they contribute at each phase via the LLM and mark themselves
 * ready. Idempotency: a per-(bot,phase) marker in participants.ready_flags.bot_acted.
 */
import { defineStore } from 'pinia';
import { supabase } from '@/services/supabase';
import {
  BOT_NAMES,
  botPreferenceBatch,
  botStatements,
  botStatementsBatch,
  botVotesBatch,
  createOpenRouterComplete,
  type AssignmentMethod,
} from '@/util';
import type { ParticipantRow, SessionPhase } from '@/services/db-types';
import { useParticipantsStore } from './participants';
import { useJostleStore } from './jostle';
import { useVotingStore } from './voting';
import { usePreferenceStore } from './preference';
import { useGraphStore } from './graph';

export const useBotStore = defineStore('bots', () => {
  /** Pick `count` names not in `taken` (then fall back to numbered). */
  function pickUnique(count: number, taken: Set<string>): string[] {
    const used = new Set(taken);
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      let name = BOT_NAMES.map((n) => `${n}·bot`).find((n) => !used.has(n));
      if (!name) name = `${BOT_NAMES[i % BOT_NAMES.length]}·bot ${Math.floor(i / BOT_NAMES.length) + 2}`;
      used.add(name);
      out.push(name);
    }
    return out;
  }

  /** Create `n` bot participant rows with unique names. */
  async function spawnBots(sessionId: string, n: number): Promise<void> {
    // Defensive clamp: the largest legitimate batch is filling an icosahedron (30).
    const count = Math.min(Math.max(0, Math.floor(n)), 30);
    if (count <= 0) return;
    // Read existing names from the DB (authoritative) so rapid single-bot clicks
    // can't collide before the previous insert echoes back over realtime.
    const { data } = await supabase.from('participants').select('name').eq('session_id', sessionId);
    const taken = new Set((data ?? []).map((r) => (r as { name: string }).name));
    const names = pickUnique(count, taken);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: crypto.randomUUID(),
      session_id: sessionId,
      name: names[i],
      is_bot: true,
    }));
    await supabase.from('participants').insert(rows);
  }

  /** Remove a single bot from the session (used by the lobby card's X). */
  async function removeBot(id: string): Promise<void> {
    await supabase.from('participants').delete().eq('id', id);
  }

  /**
   * Manual (testing): post one driving-question statement per active bot, using a
   * SINGLE batched LLM call (one response with N statements) rather than N calls.
   * Repeatable. Also marks each bot ready for the jostle so the flow can advance.
   */
  async function addBotStatementsOnce(sessionId: string, drivingQuestion: string): Promise<void> {
    const participants = useParticipantsStore();
    const jostle = useJostleStore();
    const botList = participants.bots;
    if (!botList.length) return;

    const existing = jostle.visibleStatements.map((s) => s.text);
    console.log(`[bots] generating ${botList.length} statements in one call…`);
    let stmts: string[] = [];
    try {
      stmts = await botStatementsBatch({ drivingQuestion, existing, count: botList.length, complete: createOpenRouterComplete() });
    } catch (e) {
      console.error('[bots] batch statement call failed', e);
      return;
    }
    console.log(`[bots] → received ${stmts.length} statements:`, stmts);

    for (let i = 0; i < botList.length; i++) {
      const bot = botList[i];
      try {
        if (stmts[i]) await jostle.addStatement(sessionId, bot.id, stmts[i]);
        if (!bot.ready_flags?.jostle) {
          await supabase.from('participants').update({ ready_flags: { ...(bot.ready_flags ?? {}), jostle: true } }).eq('id', bot.id);
        }
      } catch (e) { console.error(`[${bot.name}] post failed`, e); }
    }
    console.log('[bots] done adding statements');
  }

  function acted(row: ParticipantRow, phase: SessionPhase): boolean {
    return Boolean(row.ready_flags?.bot_acted?.[phase]);
  }
  async function markActed(row: ParticipantRow, phase: SessionPhase, extra: Record<string, unknown> = {}): Promise<void> {
    const flags = { ...(row.ready_flags ?? {}), ...extra, bot_acted: { ...(row.ready_flags?.bot_acted ?? {}), [phase]: true } };
    await supabase.from('participants').update({ ready_flags: flags }).eq('id', row.id);
  }

  /** Driver-only: have all not-yet-acted bots contribute for the given phase. */
  async function driveForPhase(sessionId: string, phase: SessionPhase, drivingQuestion: string): Promise<void> {
    const participants = useParticipantsStore();
    const complete = createOpenRouterComplete();
    const bots = participants.bots.filter((b) => !acted(b, phase));
    if (!bots.length && phase !== 'graph') return;

    if (phase === 'jostle') {
      const jostle = useJostleStore();
      for (const bot of bots) {
        try {
          const existing = jostle.visibleStatements.map((s) => s.text);
          const stmts = await botStatements({ drivingQuestion, existing, complete });
          for (const text of stmts) await jostle.addStatement(sessionId, bot.id, text);
          await markActed(bot, phase, { jostle: true });
        } catch (e) { console.error('[bots] jostle', bot.id, e); }
      }
    } else if (phase === 'voting') {
      const voting = useVotingStore();
      const cards = voting.visibleCards.map((c) => ({ id: c.id, title: c.title, rationale: c.rationale }));
      if (!cards.length) return;
      // One batched call → a ballot for every bot.
      console.log(`[bots] casting ${bots.length} ballots in one call…`);
      let ballots = new Map<string, string[]>();
      try {
        ballots = await botVotesBatch({ drivingQuestion, cards, voters: bots.map((b) => ({ id: b.id, name: b.name })), complete });
      } catch (e) { console.error('[bots] batch vote call failed', e); return; }
      console.log(`[bots] → received ${ballots.size} ballots`);
      for (const bot of bots) {
        try {
          for (const cardId of ballots.get(bot.id) ?? []) await voting.castVote(sessionId, bot.id, cardId);
          await markActed(bot, phase);
        } catch (e) { console.error(`[${bot.name}] vote post failed`, e); }
      }
    } else if (phase === 'preference') {
      const graph = useGraphStore();
      const pref = usePreferenceStore();
      const topics = graph.finalizedTopics.map((t) => ({ id: t.id, title: t.title }));
      if (!topics.length) return;
      // One batched call → a ranking for every bot.
      console.log(`[bots] ranking topics for ${bots.length} bots in one call…`);
      let rankings = new Map<string, string[]>();
      try {
        rankings = await botPreferenceBatch({ drivingQuestion, topics, voters: bots.map((b) => ({ id: b.id, name: b.name })), complete });
      } catch (e) { console.error('[bots] batch preference call failed', e); return; }
      console.log(`[bots] → received ${rankings.size} rankings`);
      for (const bot of bots) {
        try {
          await pref.savePreferences(sessionId, bot.id, rankings.get(bot.id) ?? topics.map((t) => t.id));
          await markActed(bot, phase);
        } catch (e) { console.error(`[${bot.name}] preference save failed`, e); }
      }
    }
    // graph: bots need no action — they already occupy struts and the schedule.
  }

  return { spawnBots, removeBot, addBotStatementsOnce, driveForPhase };
});

export type { AssignmentMethod };
