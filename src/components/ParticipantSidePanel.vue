<script setup lang="ts">
import { computed } from 'vue';
import type { ParticipantRow } from '@/services/db-types';
import ParticipantAvatar from './ParticipantAvatar.vue';

const props = defineProps<{
  participants: ParticipantRow[];
  activeId: string | null;
  /** Ids rendered greyed/disabled (e.g. finished voting). */
  doneIds?: string[];
}>();

// Active user floats to the top.
const ordered = computed(() => {
  const rows = [...props.participants];
  rows.sort((a, b) => (a.id === props.activeId ? -1 : b.id === props.activeId ? 1 : 0));
  return rows;
});
const isDone = (id: string) => props.doneIds?.includes(id) ?? false;
</script>

<template>
  <aside class="side">
    <h3 class="hd">Participants ({{ participants.length }})</h3>
    <ul>
      <li v-for="p in ordered" :key="p.id" :class="{ me: p.id === activeId, done: isDone(p.id) }">
        <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="32" />
        <span class="nm">{{ p.name || 'Anon' }}<span v-if="p.id === activeId" class="you"> (you)</span></span>
        <span class="trail"><slot name="trailing" :participant="p" /></span>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.side { width: 240px; background: #11141f; color: #e6ecff; height: 100%; overflow-y: auto; padding: 0.75rem; box-sizing: border-box; }
.hd { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; margin: 0 0 0.5rem; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; padding: 0.35rem; border-radius: 8px; }
li.me { background: #1b2236; }
li.done { opacity: 0.45; }
.nm { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.you { opacity: 0.5; }
</style>
