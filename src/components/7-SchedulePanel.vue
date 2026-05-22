<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionSchedule } from '@/util';

const props = defineProps<{
  schedule: SessionSchedule | null;
  myId: string | null;
  topicTitle: Map<string, string>;
}>();

const open = ref(true);
const tab = ref<'mine' | 'full'>('mine');

const title = (id: string) => props.topicTitle.get(id) ?? id.slice(0, 6);
const mine = computed(() => props.schedule?.perParticipant.find((p) => p.participantId === props.myId) ?? null);
</script>

<template>
  <aside class="sched" :class="{ collapsed: !open }">
    <button class="toggle" @click="open = !open">{{ open ? '◀ Schedule' : '▶' }}</button>
    <div v-if="open && schedule" class="content">
      <div class="tabs">
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">My schedule</button>
        <button :class="{ on: tab === 'full' }" @click="tab = 'full'">Full schedule</button>
      </div>
      <p class="meta">{{ schedule.slots.length }} slots · {{ schedule.concurrency }} concurrent · {{ schedule.iterations }} iterations</p>

      <div v-if="tab === 'mine'" class="list">
        <p v-if="!mine">You have no sessions.</p>
        <div v-for="it in mine?.items ?? []" :key="it.slotIndex + it.teamTopicId" class="row">
          <span class="slot">#{{ it.slotIndex + 1 }}</span>
          <span class="topic">{{ title(it.teamTopicId) }}</span>
          <span class="role" :class="it.role">{{ it.role }}</span>
          <span class="it">it{{ it.iteration }}</span>
        </div>
        <p v-if="mine?.offSlots.length" class="off">Off during slots: {{ mine.offSlots.map((s) => s + 1).join(', ') }}</p>
      </div>

      <div v-else class="list">
        <div v-for="slot in schedule.slots" :key="slot.index" class="slotblock">
          <p class="slothd">Slot {{ slot.index + 1 }}</p>
          <div v-for="s in slot.sessions" :key="s.teamTopicId" class="row">
            <span class="topic">{{ title(s.teamTopicId) }}</span>
            <span class="it">it{{ s.iteration }}</span>
            <span class="cnt">{{ s.attendeeMemberIds.length }}m / {{ s.attendeeCriticIds.length }}c</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sched { width: 280px; background: #11141f; color: #e6ecff; height: 100%; overflow-y: auto; transition: width 0.2s; border-right: 1px solid #232b44; }
.sched.collapsed { width: 40px; }
.toggle { width: 100%; background: #1b2236; border: none; color: #cdd6f4; padding: 0.6rem; cursor: pointer; text-align: left; }
.content { padding: 0.75rem; }
.tabs { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
.tabs button { flex: 1; background: #0c0f18; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 8px; padding: 0.35rem; cursor: pointer; font-size: 0.78rem; }
.tabs button.on { background: #4f7cff; color: #fff; }
.meta { font-size: 0.72rem; opacity: 0.55; margin: 0 0 0.5rem; }
.list { display: grid; gap: 0.25rem; }
.row { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; background: #0c0f18; padding: 0.3rem 0.5rem; border-radius: 8px; }
.slot { opacity: 0.5; }
.topic { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role { font-size: 0.68rem; padding: 0 0.3rem; border-radius: 6px; }
.role.member { background: #2a4d7a; }
.role.critic { background: #6a2a4d; }
.it { opacity: 0.6; font-size: 0.7rem; }
.cnt { opacity: 0.6; font-size: 0.7rem; }
.slotblock { margin-bottom: 0.4rem; }
.slothd { font-size: 0.72rem; opacity: 0.6; margin: 0.4rem 0 0.2rem; }
.off { font-size: 0.72rem; opacity: 0.55; margin-top: 0.5rem; }
</style>
