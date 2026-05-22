<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

/**
 * Right-edge popout decision card. Used for both topic merges and roster
 * reconciliation. Two options (up/down) with live counts and a countdown timer
 * that anyone can click to add 30s. Parent owns persistence; this just emits.
 */
const props = defineProps<{
  title: string;
  upLabel: string;
  downLabel: string;
  upCount: number;
  downCount: number;
  expiresAt: string;
  myVote?: 'up' | 'down' | null;
}>();

const emit = defineEmits<{
  (e: 'up'): void;
  (e: 'down'): void;
  (e: 'extend'): void;
}>();

const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 250);
onUnmounted(() => clearInterval(timer));

const secondsLeft = computed(() => Math.max(0, Math.ceil((new Date(props.expiresAt).getTime() - now.value) / 1000)));
</script>

<template>
  <div class="popout">
    <p class="title">{{ title }}</p>
    <button class="timer" :title="'Click to add 30s'" @click="emit('extend')">⏱ {{ secondsLeft }}s</button>
    <div class="options">
      <button class="opt up" :class="{ mine: myVote === 'up' }" @click="emit('up')">
        <span class="thumb">👍</span>
        <span class="lbl">{{ upLabel }}</span>
        <span class="count">{{ upCount }}</span>
      </button>
      <button class="opt down" :class="{ mine: myVote === 'down' }" @click="emit('down')">
        <span class="thumb">👎</span>
        <span class="lbl">{{ downLabel }}</span>
        <span class="count">{{ downCount }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.popout {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  width: 300px; background: #161a28; color: #fff; padding: 1rem;
  border-radius: 14px 0 0 14px; box-shadow: -10px 0 40px rgba(0,0,0,.45); z-index: 900;
  animation: slidein 0.35s ease;
}
@keyframes slidein { from { transform: translate(100%, -50%); } to { transform: translate(0, -50%); } }
.title { margin: 0 0 0.75rem; font-size: 0.95rem; line-height: 1.3; }
.timer { width: 100%; background: #222a40; color: #cdd6f4; border: none; padding: 0.4rem; border-radius: 8px; cursor: pointer; margin-bottom: 0.75rem; }
.options { display: grid; gap: 0.5rem; }
.opt { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; padding: 0.6rem 0.8rem; border: 1px solid #2a3350; background: #1b2236; color: #fff; border-radius: 10px; cursor: pointer; text-align: left; }
.opt.mine { outline: 2px solid #5ad17a; }
.opt .count { font-weight: 700; }
.opt.up:hover { border-color: #5ad17a; }
.opt.down:hover { border-color: #e06c75; }
</style>
