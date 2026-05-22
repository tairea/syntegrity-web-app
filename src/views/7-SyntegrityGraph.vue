<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useGraphStore } from '@/stores/graph';
import { getShape, type AssignmentMethod } from '@/util';
import PolyhedronScene, { type SceneNode, type FocusTarget } from '@/components/PolyhedronScene.vue';
import MethodToggle from '@/components/7-MethodToggle.vue';
import SchedulePanel from '@/components/7-SchedulePanel.vue';

const session = useSessionStore();
const participants = useParticipantsStore();
const graph = useGraphStore();
const { myParticipantId } = storeToRefs(session);
const { activeMethod, activeResult, activeSchedule, critiqueMode, focus, computing } = storeToRefs(graph);

const shapeName = computed(() => session.session?.locked_shape ?? null);

const topics = computed(() => graph.finalizedTopics);
const topicTitleMap = computed(() => new Map(topics.value.map((t) => [t.id, t.title])));
const vertexLabels = computed(() => {
  const labels: string[] = [];
  for (const t of topics.value) labels[t.vertexIndex] = t.title;
  return labels;
});

const edgeNodes = computed<(SceneNode | null)[]>(() => {
  if (!shapeName.value) return [];
  const count = getShape(shapeName.value).participantCount;
  const arr: (SceneNode | null)[] = Array.from({ length: count }, () => null);
  for (const a of activeResult.value?.assignments ?? []) {
    const p = participants.byId(a.participantId);
    if (p) arr[a.strutId] = { id: p.id, name: p.name || 'Anon', avatarUrl: p.avatar_url, isBot: p.is_bot };
  }
  return arr;
});

function ensureComputed(method: AssignmentMethod) {
  if (!graph.results[method] && !graph.computing[method]) graph.compute(method).catch(() => {});
}
onMounted(() => ensureComputed(activeMethod.value));
watch(activeMethod, (m) => ensureComputed(m));

function onMethod(m: AssignmentMethod) { graph.setMethod(m); }
function onPerson(id: string) { graph.setFocus({ type: 'person', id }); }
function onTopic(vertexIndex: number) { graph.setFocus({ type: 'topic', id: String(vertexIndex) }); }

const focusLabel = computed(() => {
  const f = focus.value as FocusTarget;
  if (!f) return '';
  if (f.type === 'topic') return vertexLabels.value[Number(f.id)] ?? `Topic ${Number(f.id) + 1}`;
  return participants.byId(f.id)?.name ?? 'Participant';
});
</script>

<template>
  <div class="graph">
    <SchedulePanel :schedule="activeSchedule ?? null" :my-id="myParticipantId" :topic-title="topicTitleMap" />

    <main class="stage">
      <div class="topbar">
        <MethodToggle :model-value="activeMethod" :computing="computing[activeMethod]" @update:model-value="onMethod" />
        <span v-if="activeResult" class="sat">avg satisfaction: {{ activeResult.satisfaction.average.toFixed(2) }}</span>
      </div>

      <PolyhedronScene
        v-if="shapeName"
        :shape-name="shapeName"
        :edge-nodes="edgeNodes"
        :vertex-labels="vertexLabels"
        :rotate="!focus"
        :focus="focus as FocusTarget"
        :critique="critiqueMode"
        @select-person="onPerson"
        @select-topic="onTopic"
      />
      <div v-if="!activeResult" class="computing">Computing {{ activeMethod }} assignment…</div>

      <div v-if="focus" class="focus-card">
        <p class="ft">{{ focus.type === 'topic' ? 'Topic' : 'Participant' }}</p>
        <h3>{{ focusLabel }}</h3>
        <p class="mode" :class="{ on: critiqueMode }">{{ critiqueMode ? 'Showing critique relationships' : 'Showing participant relationships' }}</p>
        <div class="row">
          <button @click="graph.toggleCritique()">⟲ {{ critiqueMode ? 'Show normal' : 'Show critique' }}</button>
          <button class="ghost" @click="graph.setFocus(null)">Clear</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.graph { display: grid; grid-template-columns: auto 1fr; height: 100vh; background: radial-gradient(circle at 60% 40%, #141a2c, #0b0e16); color: #e6ecff; }
.stage { position: relative; height: 100vh; }
.topbar { position: absolute; top: 1rem; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; align-items: center; gap: 0.75rem; }
.sat { font-size: 0.78rem; opacity: 0.6; }
.computing { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0.6; }
.focus-card { position: absolute; bottom: 1.2rem; left: 50%; transform: translateX(-50%); background: #11141f; border: 1px solid #232b44; border-radius: 14px; padding: 0.9rem 1.2rem; text-align: center; min-width: 240px; z-index: 10; }
.ft { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; margin: 0; }
.focus-card h3 { margin: 0.2rem 0 0.4rem; }
.mode { font-size: 0.78rem; opacity: 0.7; margin: 0 0 0.6rem; }
.mode.on { color: #e06c75; opacity: 1; }
.row { display: flex; gap: 0.5rem; justify-content: center; }
.row button { background: #4f7cff; border: none; color: #fff; border-radius: 8px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; }
.row .ghost { background: transparent; border: 1px solid #2a3350; color: #cdd6f4; }
</style>
