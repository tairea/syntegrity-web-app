<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    id: string;
    name: string;
    avatarUrl?: string | null;
    isBot?: boolean;
    size?: number;
  }>(),
  { size: 40, isBot: false, avatarUrl: null },
);

const initial = computed(() => (props.name?.trim()?.[0] ?? '?').toUpperCase());
</script>

<template>
  <span class="avatar" :style="{ width: size + 'px', height: size + 'px' }" :title="name">
    <img v-if="avatarUrl" :src="avatarUrl" :alt="name" />
    <span v-else class="initial" :style="{ fontSize: size * 0.42 + 'px' }">{{ initial }}</span>
  </span>
</template>

<style scoped>
/* Minimal: no colour fill — just a border ring and the initial. */
.avatar { display: inline-block; border-radius: 50%; overflow: hidden; flex: none; }
.avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.initial {
  width: 100%; height: 100%; display: grid; place-items: center; box-sizing: border-box;
  background: transparent; border: 1px solid rgba(138, 148, 176, 0.5); border-radius: 50%;
  color: #e6ecff; font-weight: 600;
}
</style>
