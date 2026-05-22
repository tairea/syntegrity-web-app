<script setup lang="ts">
import { computed } from 'vue';
import type { SessionPhase } from '@/services/db-types';

const props = defineProps<{ to: SessionPhase | null; n: number }>();

const LABELS: Record<SessionPhase, string> = {
  lobby: 'Lobby',
  reconciliation: 'Reconciliation',
  jostle: 'Problem Jostle',
  voting: 'Voting',
  preference: 'Topic Preference',
  graph: 'Syntegrity Graph',
  done: 'Close',
};
const label = computed(() => (props.to ? LABELS[props.to] : ''));
</script>

<template>
  <Transition name="fade">
    <div v-if="to && n > 0" class="overlay">
      <div class="card">
        <p class="title">Moving to {{ label }} in</p>
        <p class="count">{{ n }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(10, 12, 20, 0.7); display: grid; place-items: center; z-index: 1000; }
.card { background: #11141f; color: #fff; padding: 2rem 3rem; border-radius: 16px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.title { opacity: 0.8; margin: 0 0 0.5rem; }
.count { font-size: 4rem; font-weight: 700; margin: 0; line-height: 1; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
