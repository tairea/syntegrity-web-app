/**
 * Step 4 (Problem Jostle) store: statements, LLM clusters, per-cluster chat.
 * The bot/cluster driver calls runClustering on a debounce; everyone else just
 * renders the realtime rows.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { AnyChange } from './realtime';
import type { ClusterMessageRow, ClusterRow, StatementRow } from '@/services/db-types';
import { clusterStatements, createOpenRouterComplete } from '@/util';

export const useJostleStore = defineStore('jostle', () => {
  const statements = ref<Map<string, StatementRow>>(new Map());
  const clusters = ref<Map<string, ClusterRow>>(new Map());
  const messages = ref<Map<string, ClusterMessageRow>>(new Map());
  const activeClusterId = ref<string | null>(null);
  const clustering = ref(false);

  const visibleStatements = computed(() => [...statements.value.values()].filter((s) => !s.deleted));
  const clusterList = computed(() => [...clusters.value.values()]);
  const messagesByCluster = computed(() => {
    const m = new Map<string, ClusterMessageRow[]>();
    for (const msg of messages.value.values()) {
      const arr = m.get(msg.cluster_id) ?? [];
      arr.push(msg);
      m.set(msg.cluster_id, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return m;
  });
  function statementsOf(clusterId: string): StatementRow[] {
    return visibleStatements.value.filter((s) => s.cluster_id === clusterId);
  }

  // ── realtime ──────────────────────────────────────────────────────────
  function load(s: StatementRow[], c: ClusterRow[], m: ClusterMessageRow[]): void {
    statements.value = new Map(s.map((r) => [r.id, r]));
    clusters.value = new Map(c.map((r) => [r.id, r]));
    messages.value = new Map(m.map((r) => [r.id, r]));
  }
  function applyStatement(p: AnyChange): void {
    if (p.eventType === 'DELETE') statements.value.delete((p.old as StatementRow).id);
    else statements.value.set((p.new as StatementRow).id, p.new as StatementRow);
    statements.value = new Map(statements.value);
  }
  function applyCluster(p: AnyChange): void {
    if (p.eventType === 'DELETE') clusters.value.delete((p.old as ClusterRow).id);
    else clusters.value.set((p.new as ClusterRow).id, p.new as ClusterRow);
    clusters.value = new Map(clusters.value);
  }
  function applyMessage(p: AnyChange): void {
    if (p.eventType === 'DELETE') messages.value.delete((p.old as ClusterMessageRow).id);
    else messages.value.set((p.new as ClusterMessageRow).id, p.new as ClusterMessageRow);
    messages.value = new Map(messages.value);
  }

  // ── writes ──────────────────────────────────────────────────────────────
  async function addStatement(sessionId: string, participantId: string, text: string, clusterId?: string): Promise<void> {
    if (!text.trim()) return;
    await supabase.from('statements').insert({ session_id: sessionId, participant_id: participantId, text: text.trim(), cluster_id: clusterId ?? null });
  }
  async function deleteStatement(id: string): Promise<void> {
    await supabase.from('statements').update({ deleted: true }).eq('id', id);
  }
  async function sendMessage(sessionId: string, clusterId: string, participantId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await supabase.from('cluster_messages').insert({ session_id: sessionId, cluster_id: clusterId, participant_id: participantId, text: text.trim() });
  }
  async function renameCluster(id: string, name: string): Promise<void> {
    await supabase.from('clusters').update({ name }).eq('id', id);
  }

  /**
   * Recompute clusters via the LLM and reconcile rows: match by name to keep
   * chat stable, insert new, drop empties, re-tag statements. Driver-only.
   */
  async function runClustering(sessionId: string, drivingQuestion: string, minClusters: number): Promise<void> {
    const live = visibleStatements.value;
    if (live.length === 0) return;
    clustering.value = true;
    console.log(`[clustering] clustering ${live.length} statements (min ${minClusters})…`);
    try {
      const result = await clusterStatements({
        statements: live.map((s) => ({ id: s.id, text: s.text })),
        drivingQuestion,
        minClusters,
        complete: createOpenRouterComplete(),
      });
      console.log(`[clustering] → ${result.clusters.length} clusters:`, result.clusters.map((c) => c.name).join(', '));

      const existingByName = new Map([...clusters.value.values()].map((c) => [c.name.toLowerCase(), c]));
      const keptIds = new Set<string>();
      for (const c of result.clusters) {
        let row = existingByName.get(c.name.toLowerCase());
        if (!row) {
          const { data } = await supabase
            .from('clusters')
            .insert({ session_id: sessionId, name: c.name, summary: c.summary })
            .select()
            .single();
          row = data as ClusterRow;
        } else {
          await supabase.from('clusters').update({ summary: c.summary }).eq('id', row.id);
        }
        if (!row) continue;
        keptIds.add(row.id);
        if (c.statementIds.length) await supabase.from('statements').update({ cluster_id: row.id }).in('id', c.statementIds);
      }
      // Drop clusters that no longer exist in the new result.
      const stale = [...clusters.value.values()].filter((c) => !keptIds.has(c.id)).map((c) => c.id);
      if (stale.length) await supabase.from('clusters').delete().in('id', stale);
    } catch (e) {
      console.error('[jostle] clustering failed', e);
    } finally {
      clustering.value = false;
    }
  }

  return {
    statements, clusters, messages, activeClusterId, clustering,
    visibleStatements, clusterList, messagesByCluster, statementsOf,
    load, applyStatement, applyCluster, applyMessage,
    addStatement, deleteStatement, sendMessage, renameCluster, runClustering,
  };
});
