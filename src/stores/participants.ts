/**
 * Roster + readiness store. Source of truth = the `participants` table (realtime).
 * Presence is used for live "online" liveness and driver election; headcount for
 * shape snapping is driven off non-removed roster rows so it survives reloads.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { AnyChange } from './realtime';
import type { ParticipantRow, ReadyFlags, SessionPhase } from '@/services/db-types';
import { participantRowToDomain } from '@/services/db-types';
import type { Participant } from '@/util';

type ReadyPhase = 'jostle' | 'vote' | 'pref' | 'resolve';

export const useParticipantsStore = defineStore('participants', () => {
  const rows = ref<Map<string, ParticipantRow>>(new Map());
  /** participantId -> online (from presence). */
  const online = ref<Set<string>>(new Set());

  const all = computed(() => [...rows.value.values()]);
  const active = computed(() => all.value.filter((p) => !p.removed));
  const humans = computed(() => active.value.filter((p) => !p.is_bot));
  const bots = computed(() => active.value.filter((p) => p.is_bot));
  const headcount = computed(() => active.value.length);
  const asDomain = computed<Participant[]>(() => active.value.map(participantRowToDomain));

  const readyKey: Record<ReadyPhase, keyof ReadyFlags> = { jostle: 'jostle', vote: 'vote', pref: 'pref', resolve: 'resolve' };

  function readyCount(phase: ReadyPhase): number {
    return active.value.filter((p) => p.ready_flags?.[readyKey[phase]]).length;
  }
  function allReady(phase: ReadyPhase): boolean {
    return active.value.length > 0 && readyCount(phase) === active.value.length;
  }
  function over50Ready(phase: ReadyPhase): boolean {
    return active.value.length > 0 && readyCount(phase) > active.value.length / 2;
  }

  function byId(id: string): ParticipantRow | undefined {
    return rows.value.get(id);
  }

  // ── realtime application ────────────────────────────────────────────────
  function load(initial: ParticipantRow[]): void {
    rows.value = new Map(initial.map((r) => [r.id, r]));
  }
  function applyChange(payload: AnyChange): void {
    if (payload.eventType === 'DELETE') {
      const oldId = (payload.old as Partial<ParticipantRow>)?.id;
      if (oldId) rows.value.delete(oldId);
    } else {
      const row = payload.new as ParticipantRow;
      rows.value.set(row.id, row);
    }
    rows.value = new Map(rows.value); // trigger reactivity
  }
  function setOnline(ids: string[]): void {
    online.value = new Set(ids);
  }

  // ── writes ──────────────────────────────────────────────────────────────
  async function upsertProfile(
    sessionId: string,
    id: string,
    fields: { name: string; avatarUrl?: string | null; discordHandle?: string | null; isBot?: boolean },
  ): Promise<void> {
    await supabase.from('participants').upsert({
      id,
      session_id: sessionId,
      name: fields.name,
      avatar_url: fields.avatarUrl ?? null,
      discord_handle: fields.discordHandle ?? null,
      is_bot: fields.isBot ?? false,
    });
  }

  async function setReady(id: string, phase: ReadyPhase, value: boolean): Promise<void> {
    const row = rows.value.get(id);
    const flags: ReadyFlags = { ...(row?.ready_flags ?? {}), [readyKey[phase]]: value };
    await supabase.from('participants').update({ ready_flags: flags }).eq('id', id);
  }

  async function markRemoved(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await supabase.from('participants').update({ removed: true }).in('id', ids);
  }

  return {
    rows, online, all, active, humans, bots, headcount, asDomain,
    readyCount, allReady, over50Ready, byId,
    load, applyChange, setOnline,
    upsertProfile, setReady, markRemoved,
  };
});

export type { ReadyPhase, SessionPhase };
