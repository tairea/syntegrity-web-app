<script setup lang="ts">
/**
 * Shared "format info" card — provenance pill + standardised bullets.
 * Rendered both on /schedule (host picks the format) and on /scheduled/:code
 * (invitees see what they're committing to). The freeform `description` field
 * on each SessionFormat is intentionally NOT shown — structural facts are
 * derived in buildFormatBullets so every recipe reads in the same shape.
 */
import { computed } from 'vue';
import { SHAPE_META } from '@/util';
import type { SessionFormat } from '@/util/session-formats';
import { buildFormatBullets } from '@/util/format-bullets';

const props = defineProps<{ format: SessionFormat }>();

const shapeMeta = computed(() => SHAPE_META[props.format.shape]);
const bullets = computed(() => buildFormatBullets(props.format, shapeMeta.value));
</script>

<template>
  <div class="format-info" :class="`prov-${format.provenance}`">
    <div class="format-meta">
      <span class="format-name">{{ format.name }}</span>
      <span class="provenance">{{ format.provenance }}</span>
    </div>
    <ul class="bullets">
      <li v-for="(b, i) in bullets" :key="i" :class="{ caveat: b.emoji === '⚠️' }">
        <span class="emoji" aria-hidden="true">{{ b.emoji }}</span>
        <span class="text">{{ b.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.format-info { background: #11162a; border: 1px solid #2a3350; border-radius: 10px; padding: 0.9rem 1rem; }
.format-meta { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.65rem; flex-wrap: wrap; }
.format-name { font-weight: 600; color: #e6ecff; font-size: 0.95rem; }
.provenance { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
.prov-canonical-beer .provenance { background: #1a3a2a; color: #8be8a8; }
.prov-canonical-truss .provenance { background: #1a2f3a; color: #8bc4e8; }
.prov-experimental .provenance { background: #3a2f1a; color: #e8c48b; }

.bullets { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.bullets li { display: grid; grid-template-columns: 1.6em 1fr; align-items: start; gap: 0.5rem; color: #cdd6f4; font-size: 0.88rem; line-height: 1.45; }
.bullets li.caveat { color: #9fb0d8; font-size: 0.82rem; }
.emoji { font-size: 1rem; line-height: 1.45; text-align: center; }
.text { min-width: 0; }
</style>
