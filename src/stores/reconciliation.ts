/**
 * Roster reconciliation store (lobby→jostle boundary). Holds the active
 * reconciliation merge_request (kind='reconciliation') and the group's vote.
 * The decision is binary: PAD with bots (👍/up) vs TRIM last-joined (👎/down).
 * Resolution (applying the decision + locking the shape) is driven by the
 * session store's authoritative writer — see useSessionStore.driverTick.
 */
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { supabase } from '@/services/supabase';
import { reconciliationPlan, type ReconciliationPlan } from '@/util';
import { useVotingStore } from './voting';

const RECON_SECONDS = 30;

export const useReconciliationStore = defineStore('reconciliation', () => {
  const voting = useVotingStore();

  /** The open reconciliation request, if any (reuses the merge_requests table). */
  const active = computed(() => [...voting.merges.values()].find((m) => m.kind === 'reconciliation' && m.status === 'open') ?? null);

  function planFor(headcount: number): ReconciliationPlan {
    return reconciliationPlan(headcount);
  }

  /** Driver-only: open a reconciliation vote for a non-exact headcount. */
  async function propose(sessionId: string, headcount: number): Promise<void> {
    if (active.value) return;
    const plan = reconciliationPlan(headcount);
    if (plan.exact) return;
    const expires = new Date(Date.now() + RECON_SECONDS * 1000).toISOString();
    await supabase.from('merge_requests').insert({
      session_id: sessionId,
      kind: 'reconciliation',
      expires_at: expires,
      up: [],
      down: [],
      payload: { headcount, trim: plan.trim, pad: plan.pad },
    });
  }

  async function vote(pid: string, dir: 'up' | 'down'): Promise<void> {
    const m = active.value;
    if (!m) return;
    // Only offer a direction that actually has an option.
    await voting.voteMerge(m.id, pid, dir);
  }
  async function extend(): Promise<void> {
    const m = active.value;
    if (m) await voting.extendTimer(m.id);
  }

  return { active, planFor, propose, vote, extend };
});
