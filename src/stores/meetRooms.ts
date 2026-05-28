/**
 * Realtime mirror of the meet_rooms table for the current session. One row per
 * (slot, team) Meet room minted by the meet-create-rooms edge function. Mirrors
 * the participants store's pattern: a Map keyed by id + a `load`/`applyChange`
 * pair the session orchestrator drives.
 *
 * UI surfaces (the bottom-middle Join CTA on the stage) look up the current
 * room via `byCurrentSlotAndTopic(slotIndex, topicId)` and open `meet_uri` in
 * a new window.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AnyChange } from './realtime';
import type { MeetRoomRow } from '@/services/db-types';

export const useMeetRoomsStore = defineStore('meetRooms', () => {
  const rows = ref<Map<string, MeetRoomRow>>(new Map());

  const all = computed(() => [...rows.value.values()]);

  function bySlot(slotIndex: number): MeetRoomRow[] {
    return all.value.filter((r) => r.slot_index === slotIndex);
  }

  function byCurrentSlotAndTopic(slotIndex: number, teamTopicId: string): MeetRoomRow | undefined {
    return all.value.find((r) => r.slot_index === slotIndex && r.team_topic_id === teamTopicId);
  }

  function load(initial: MeetRoomRow[]): void {
    rows.value = new Map(initial.map((r) => [r.id, r]));
  }

  function applyChange(payload: AnyChange): void {
    if (payload.eventType === 'DELETE') {
      const oldId = (payload.old as Partial<MeetRoomRow>)?.id;
      if (oldId) rows.value.delete(oldId);
    } else {
      const row = payload.new as MeetRoomRow;
      rows.value.set(row.id, row);
    }
    rows.value = new Map(rows.value); // trigger reactivity
  }

  return { rows, all, bySlot, byCurrentSlotAndTopic, load, applyChange };
});
