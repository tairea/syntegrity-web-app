/**
 * Step 6 (Topic Preference) store: each participant's drag-ordered topic ranking
 * and saved/ready state. asTopicPreferences() feeds the step-7 role assignment.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { AnyChange } from './realtime';
import type { PreferenceRow } from '@/services/db-types';
import { preferenceRowToDomain } from '@/services/db-types';
import type { TopicPreference } from '@/util';

export const usePreferenceStore = defineStore('preference', () => {
  const prefs = ref<Map<string, PreferenceRow>>(new Map()); // keyed by participant_id

  function rankingOf(pid: string): string[] {
    return prefs.value.get(pid)?.ranked_topic_ids ?? [];
  }
  function isSaved(pid: string): boolean {
    return prefs.value.get(pid)?.saved ?? false;
  }
  const asTopicPreferences = computed<TopicPreference[]>(() => [...prefs.value.values()].map(preferenceRowToDomain));

  function allSaved(activeParticipantIds: string[]): boolean {
    return activeParticipantIds.length > 0 && activeParticipantIds.every((id) => isSaved(id));
  }

  // ── realtime ──────────────────────────────────────────────────────────
  function load(rows: PreferenceRow[]): void {
    prefs.value = new Map(rows.map((r) => [r.participant_id, r]));
  }
  function applyChange(p: AnyChange): void {
    if (p.eventType === 'DELETE') prefs.value.delete((p.old as PreferenceRow).participant_id);
    else {
      const row = p.new as PreferenceRow;
      prefs.value.set(row.participant_id, row);
    }
    prefs.value = new Map(prefs.value);
  }

  // ── writes ──────────────────────────────────────────────────────────────
  async function setRanking(sessionId: string, pid: string, ranked: string[], saved = false): Promise<void> {
    await supabase
      .from('preferences')
      .upsert({ session_id: sessionId, participant_id: pid, ranked_topic_ids: ranked, saved }, { onConflict: 'session_id,participant_id' });
  }
  async function savePreferences(sessionId: string, pid: string, ranked: string[]): Promise<void> {
    await setRanking(sessionId, pid, ranked, true);
  }
  async function undoSave(sessionId: string, pid: string): Promise<void> {
    await setRanking(sessionId, pid, rankingOf(pid), false);
  }

  return { prefs, rankingOf, isSaved, asTopicPreferences, allSaved, load, applyChange, setRanking, savePreferences, undoSave };
});
