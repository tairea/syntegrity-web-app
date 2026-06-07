<script setup lang="ts">
import { useSessionStore } from '@/stores/session';

const props = defineProps<{ meetSpaceUri: string | null }>();

const session = useSessionStore();

function onClick(): void {
  if (props.meetSpaceUri) {
    window.open(props.meetSpaceUri, 'syntegrity-meet');
  } else {
    void session.createSessionSpace();
  }
}
</script>

<template>
  <button
    class="call-btn"
    :class="{ live: !!meetSpaceUri }"
    :title="meetSpaceUri ? 'Join the session coordination call' : 'Setting up session call…'"
    @click="onClick"
  >
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14"/>
      <rect x="2" y="7" width="13" height="10" rx="2"/>
    </svg>
    <span v-if="meetSpaceUri" class="label">Join Live Call</span>
  </button>
</template>

<style scoped>
@keyframes callPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(79, 124, 255, 0.4); }
  50%       { box-shadow: 0 0 0 8px rgba(79, 124, 255, 0); }
}

.call-btn {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: #11141f;
  border: 1px solid #2a3350;
  border-radius: 999px;
  color: #6b7a9e;
  cursor: pointer;
  font: inherit;
  font-size: 0.82rem;
  padding: 0.55rem 0.75rem;
  transition: border-color 0.15s, color 0.15s;
}

.call-btn.live {
  border-color: #4f7cff;
  color: #cdd6f4;
  animation: callPulse 2s ease-in-out infinite;
}

.call-btn:hover {
  border-color: #4f7cff;
  color: #e6ecff;
}

.icon {
  width: 1.1rem;
  height: 1.1rem;
  flex-shrink: 0;
}

.label {
  white-space: nowrap;
}
</style>
