<script setup lang="ts">
const props = defineProps<{ targetPositions: number | null; removedCount: number | null }>();
const people = (n: number) => (n === 1 ? 'person' : 'people');
</script>

<template>
  <main class="screen">
    <div class="card">
      <h1>You've been removed from this session</h1>
      <p class="body">
        <template v-if="targetPositions">
          The group voted to <strong>trim</strong> the roster down to a Syntegrity geometry with
          <strong>{{ targetPositions }}</strong> participant positions<template v-if="removedCount">, so
          <strong>{{ removedCount }}</strong> {{ people(removedCount) }} had to leave</template>.
          You were one of the last to join, so you were one of those removed. Apologies.
        </template>
        <template v-else>
          The group reconciled the roster to fit a valid Syntegrity geometry, and you were one of the
          last to join. Apologies.
        </template>
      </p>
    </div>
  </main>
</template>

<style scoped>
.screen { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 50% 30%, #1a2138, #0b0e16); color: #e6ecff; }
.card { width: min(460px, 90vw); background: #11141f; border: 1px solid #232b44; border-radius: 16px; padding: 1.75rem; text-align: center; }
h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 0.9rem; }
.body { opacity: 0.8; line-height: 1.55; margin: 0; }
.body strong { color: #e6ecff; }
</style>
