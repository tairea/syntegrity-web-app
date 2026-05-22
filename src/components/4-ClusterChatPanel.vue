<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ClusterRow, ClusterMessageRow, ParticipantRow } from '@/services/db-types';
import ParticipantAvatar from './ParticipantAvatar.vue';

const props = defineProps<{
  cluster: ClusterRow;
  messages: ClusterMessageRow[];
  participants: Map<string, ParticipantRow>;
  myId: string;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'close'): void;
}>();

const draft = ref('');
const nameOf = (id: string) => props.participants.get(id)?.name ?? 'Anon';
const sorted = computed(() => [...props.messages].sort((a, b) => a.created_at.localeCompare(b.created_at)));
// Ensure the description reads as "This cluster ..." even if the model didn't.
const description = computed(() => {
  const s = props.cluster.summary?.trim();
  if (!s) return 'This cluster groups related statements.';
  return /^this cluster/i.test(s) ? s : `This cluster covers: ${s}`;
});

function send() { if (draft.value.trim()) { emit('send', draft.value.trim()); draft.value = ''; } }
</script>

<template>
  <div class="panel">
    <header>
      <h3 class="name">{{ cluster.name }}</h3>
      <button class="x" @click="emit('close')">✕</button>
    </header>
    <p class="description">{{ description }}</p>

    <div class="chat">
      <div class="messages">
        <div v-for="m in sorted" :key="m.id" class="msg" :class="{ mine: m.participant_id === myId }">
          <ParticipantAvatar :id="m.participant_id" :name="nameOf(m.participant_id)" :size="22" />
          <div><span class="who">{{ nameOf(m.participant_id) }}</span><p>{{ m.text }}</p></div>
        </div>
        <p v-if="sorted.length === 0" class="empty">No messages yet. Start the discussion.</p>
      </div>
      <div class="add">
        <input v-model="draft" placeholder="Message…" @keyup.enter="send" />
        <button @click="send">Send</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { width: 340px; height: 100%; background: #11141f; color: #e6ecff; display: flex; flex-direction: column; border-right: 1px solid #232b44; }
header { display: flex; align-items: center; gap: 0.5rem; padding: 0.85rem; border-bottom: 1px solid #232b44; }
.name { flex: 1; margin: 0; font-size: 1.05rem; }
.x { background: none; border: none; color: #cdd6f4; cursor: pointer; font-size: 1rem; }
.description { padding: 0.85rem; margin: 0; opacity: 0.75; font-size: 0.88rem; line-height: 1.4; border-bottom: 1px solid #232b44; }
.chat { flex: 1; display: flex; flex-direction: column; padding: 0.75rem; min-height: 0; }
.messages { flex: 1; overflow-y: auto; display: grid; gap: 0.5rem; align-content: start; }
.msg { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem; }
.msg .who { font-size: 0.7rem; opacity: 0.6; }
.msg p { margin: 0; font-size: 0.88rem; }
.msg.mine .who { color: #7aa2ff; }
.empty { opacity: 0.45; font-size: 0.85rem; text-align: center; margin-top: 1rem; }
.add { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
.add input { flex: 1; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 8px; padding: 0.45rem; font: inherit; }
.add button { background: #4f7cff; border: none; color: #fff; border-radius: 8px; padding: 0 0.8rem; cursor: pointer; }
</style>
