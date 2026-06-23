<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '@/stores/session';

const props = defineProps<{ meetSpaceUri: string | null }>();

const session = useSessionStore();

/** How many people are currently in the coordination call (presence-based). */
const callCount = computed(() => session.callParticipantIds.length);

function onClick(): void {
  if (props.meetSpaceUri) {
    // Flag ourselves as in the call, then open Meet in its own tab.
    void session.setInCall(true);
    window.open(props.meetSpaceUri, 'syntegrity-meet');
  } else {
    void session.createSessionSpace();
  }
}

// When the user comes back to the app tab, treat that as having left the call.
// Heuristic (we can't observe the Meet tab directly), but it keeps the count
// honest for the common "join → talk → return here" flow.
function onVisibility(): void {
  if (document.visibilityState === 'visible') void session.setInCall(false);
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility));
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
    <span
      v-if="meetSpaceUri && callCount > 0"
      class="count"
      :title="`${callCount} ${callCount === 1 ? 'person' : 'people'} in the call`"
    >{{ callCount }}</span>
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

/* Live headcount badge — how many people are currently in the call. */
.count {
  display: inline-grid;
  place-items: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: #4f7cff;
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1;
}
</style>
