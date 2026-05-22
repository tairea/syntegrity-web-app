<script setup lang="ts">
import type { AssignmentMethod } from '@/util';

defineProps<{ modelValue: AssignmentMethod; computing?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', m: AssignmentMethod): void }>();
</script>

<template>
  <div class="toggle">
    <span class="caption">Assignment method (prototype):</span>
    <button :class="{ on: modelValue === 'algorithm' }" @click="emit('update:modelValue', 'algorithm')">Algorithm</button>
    <button :class="{ on: modelValue === 'llm' }" @click="emit('update:modelValue', 'llm')">LLM</button>
    <span v-if="computing" class="busy">⟳</span>
  </div>
</template>

<style scoped>
.toggle { display: inline-flex; align-items: center; gap: 0.4rem; background: #11141f; border: 1px solid #232b44; border-radius: 999px; padding: 0.3rem 0.5rem; }
.caption { font-size: 0.75rem; opacity: 0.6; margin-right: 0.2rem; }
button { background: transparent; border: none; color: #cdd6f4; border-radius: 999px; padding: 0.3rem 0.8rem; cursor: pointer; font: inherit; }
button.on { background: #4f7cff; color: #fff; }
.busy { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
