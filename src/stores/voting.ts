/**
 * Step 5 (Voting) store: topic cards (seeded from clusters), 5-vote-per-person
 * sticker voting, and drag-to-merge requests with a timed group decision.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { AnyChange } from './realtime';
import type { ClusterRow, MergeRequestRow, TopicCardRow, VoteRow } from '@/services/db-types';
import { clusterToCardSeed, createOpenRouterComplete, mergeTopicCards } from '@/util';

const VOTES_PER_PARTICIPANT = 5;
const MERGE_SECONDS = 30;

export const useVotingStore = defineStore('voting', () => {
  const cards = ref<Map<string, TopicCardRow>>(new Map());
  const votes = ref<Map<string, VoteRow>>(new Map());
  const merges = ref<Map<string, MergeRequestRow>>(new Map());

  const visibleCards = computed(() => [...cards.value.values()].filter((c) => !c.removed));
  const voteList = computed(() => [...votes.value.values()]);
  const voteCountByCard = computed(() => {
    const m = new Map<string, number>();
    for (const v of voteList.value) m.set(v.topic_card_id, (m.get(v.topic_card_id) ?? 0) + 1);
    return m;
  });
  function votesCast(pid: string): number {
    return voteList.value.filter((v) => v.participant_id === pid).length;
  }
  function votesRemaining(pid: string): number {
    return VOTES_PER_PARTICIPANT - votesCast(pid);
  }
  function voterAvatars(cardId: string): string[] {
    return voteList.value.filter((v) => v.topic_card_id === cardId).map((v) => v.participant_id);
  }
  function topNCards(n: number): TopicCardRow[] {
    return [...visibleCards.value]
      .sort((a, b) => (voteCountByCard.value.get(b.id) ?? 0) - (voteCountByCard.value.get(a.id) ?? 0))
      .slice(0, n);
  }
  const openMerges = computed(() => [...merges.value.values()].filter((m) => m.status === 'open'));

  // ── realtime ──────────────────────────────────────────────────────────
  function load(c: TopicCardRow[], v: VoteRow[], m: MergeRequestRow[]): void {
    cards.value = new Map(c.map((r) => [r.id, r]));
    votes.value = new Map(v.map((r) => [r.id, r]));
    merges.value = new Map(m.map((r) => [r.id, r]));
  }
  function applyCard(p: AnyChange): void {
    if (p.eventType === 'DELETE') cards.value.delete((p.old as TopicCardRow).id);
    else cards.value.set((p.new as TopicCardRow).id, p.new as TopicCardRow);
    cards.value = new Map(cards.value);
  }
  function applyVote(p: AnyChange): void {
    if (p.eventType === 'DELETE') votes.value.delete((p.old as VoteRow).id);
    else votes.value.set((p.new as VoteRow).id, p.new as VoteRow);
    votes.value = new Map(votes.value);
  }
  function applyMerge(p: AnyChange): void {
    if (p.eventType === 'DELETE') merges.value.delete((p.old as MergeRequestRow).id);
    else merges.value.set((p.new as MergeRequestRow).id, p.new as MergeRequestRow);
    merges.value = new Map(merges.value);
  }

  // ── writes ──────────────────────────────────────────────────────────────
  /** Seed cards from clusters once (driver-only, idempotent on empty). */
  async function seedCards(sessionId: string, clusters: ClusterRow[]): Promise<void> {
    if (cards.value.size > 0) return;
    const rows = clusters.map((c) => {
      const seed = clusterToCardSeed({ name: c.name, summary: c.summary });
      return { session_id: sessionId, title: seed.title, rationale: seed.rationale, source_cluster_ids: [c.id] };
    });
    if (rows.length) await supabase.from('topic_cards').insert(rows);
  }

  async function castVote(sessionId: string, pid: string, cardId: string): Promise<void> {
    if (votesRemaining(pid) <= 0) return;
    await supabase.from('votes').insert({ session_id: sessionId, participant_id: pid, topic_card_id: cardId });
  }
  async function removeVote(pid: string, cardId: string): Promise<void> {
    const mine = voteList.value.filter((v) => v.participant_id === pid && v.topic_card_id === cardId);
    if (mine.length) await supabase.from('votes').delete().eq('id', mine[mine.length - 1].id);
  }

  async function proposeMerge(sessionId: string, proposerId: string, cardA: string, cardB: string): Promise<void> {
    const expires = new Date(Date.now() + MERGE_SECONDS * 1000).toISOString();
    await supabase.from('merge_requests').insert({ session_id: sessionId, kind: 'merge', proposer_id: proposerId, card_a: cardA, card_b: cardB, expires_at: expires, up: [], down: [] });
  }
  async function voteMerge(mergeId: string, pid: string, dir: 'up' | 'down'): Promise<void> {
    const m = merges.value.get(mergeId);
    if (!m) return;
    const up = new Set(m.up); const down = new Set(m.down);
    up.delete(pid); down.delete(pid);
    (dir === 'up' ? up : down).add(pid);
    await supabase.from('merge_requests').update({ up: [...up], down: [...down] }).eq('id', mergeId);
  }
  async function extendTimer(mergeId: string): Promise<void> {
    const m = merges.value.get(mergeId);
    if (!m) return;
    const expires = new Date(new Date(m.expires_at).getTime() + MERGE_SECONDS * 1000).toISOString();
    await supabase.from('merge_requests').update({ expires_at: expires }).eq('id', mergeId);
  }

  /** Resolve an expired merge (driver-only). Approve => LLM-merged card; else reject. */
  async function resolveMerge(sessionId: string, drivingQuestion: string, m: MergeRequestRow): Promise<void> {
    if (m.status !== 'open' || m.kind !== 'merge') return;
    const approved = m.up.length >= m.down.length && m.up.length > 0;
    if (!approved) {
      await supabase.from('merge_requests').update({ status: 'rejected' }).eq('id', m.id);
      return;
    }
    const a = m.card_a ? cards.value.get(m.card_a) : undefined;
    const b = m.card_b ? cards.value.get(m.card_b) : undefined;
    if (!a || !b) {
      await supabase.from('merge_requests').update({ status: 'rejected' }).eq('id', m.id);
      return;
    }
    const merged = await mergeTopicCards({
      a: { title: a.title, rationale: a.rationale },
      b: { title: b.title, rationale: b.rationale },
      drivingQuestion,
      complete: createOpenRouterComplete(),
    });
    const { data } = await supabase
      .from('topic_cards')
      .insert({ session_id: sessionId, title: merged.title, rationale: merged.rationale, source_cluster_ids: [...a.source_cluster_ids, ...b.source_cluster_ids], merged_from: [a.id, b.id] })
      .select()
      .single();
    await supabase.from('topic_cards').update({ removed: true }).in('id', [a.id, b.id]);
    // Re-point existing votes from the parents onto the merged card.
    if (data) await supabase.from('votes').update({ topic_card_id: (data as TopicCardRow).id }).in('topic_card_id', [a.id, b.id]);
    await supabase.from('merge_requests').update({ status: 'approved', result_card_id: data ? (data as TopicCardRow).id : null }).eq('id', m.id);
  }

  return {
    cards, votes, merges, visibleCards, voteList, voteCountByCard, openMerges,
    votesCast, votesRemaining, voterAvatars, topNCards,
    load, applyCard, applyVote, applyMerge,
    seedCards, castVote, removeVote, proposeMerge, voteMerge, extendTimer, resolveMerge,
    VOTES_PER_PARTICIPANT,
  };
});
