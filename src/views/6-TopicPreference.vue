<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useVotingStore } from '@/stores/voting';
import { usePreferenceStore } from '@/stores/preference';
import { encodedShapeForHeadcount, getShape, type ShapeName } from '@/util';
import ParticipantSidePanel from '@/components/ParticipantSidePanel.vue';

const session = useSessionStore();
const participants = useParticipantsStore();
const voting = useVotingStore();
const preference = usePreferenceStore();
const { sessionId, myParticipantId } = storeToRefs(session);

const shapeName = computed<ShapeName>(
  () => session.session?.locked_shape ?? encodedShapeForHeadcount(participants.active.length),
);
const N = computed(() => getShape(shapeName.value).topicCount);
const winners = computed(() => voting.topNCards(N.value));
const cardById = computed(() => new Map(winners.value.map((c) => [c.id, c])));

const order = ref<string[]>([]);
watch(
  [winners, myParticipantId],
  () => {
    const saved = myParticipantId.value ? preference.rankingOf(myParticipantId.value) : [];
    const ids = winners.value.map((c) => c.id);
    const base = saved.length && saved.every((id) => ids.includes(id)) ? saved : ids;
    if (order.value.length === 0 || order.value.some((id) => !ids.includes(id)) || order.value.length !== ids.length) {
      order.value = [...base];
    }
  },
  { immediate: true },
);

const savedForMe = computed(() => (myParticipantId.value ? preference.isSaved(myParticipantId.value) : false));
const doneIds = computed(() => participants.active.filter((p) => preference.isSaved(p.id)).map((p) => p.id));

// drag reorder
const dragIdx = ref<number | null>(null);
function onDrop(i: number) {
  if (dragIdx.value === null || dragIdx.value === i) return;
  const arr = [...order.value];
  const [moved] = arr.splice(dragIdx.value, 1);
  arr.splice(i, 0, moved);
  order.value = arr;
  dragIdx.value = null;
  autosave();
}
function autosave() {
  // keep an unsaved working copy synced so reloads/late reads see progress
  if (myParticipantId.value) preference.setRanking(sessionId.value, myParticipantId.value, order.value, savedForMe.value);
}
function save() { if (myParticipantId.value) preference.savePreferences(sessionId.value, myParticipantId.value, order.value); }
function undo() { if (myParticipantId.value) preference.undoSave(sessionId.value, myParticipantId.value); }
</script>

<template>
  <div class="pref">
    <ParticipantSidePanel :participants="participants.active" :active-id="myParticipantId" :done-ids="doneIds">
      <template #trailing="{ participant }">
        <button
          v-if="participant.id === myParticipantId"
          class="save-btn"
          :class="{ ready: savedForMe }"
          @click="savedForMe ? undo() : save()"
        >{{ savedForMe ? 'Ready to proceed ✓' : 'Save Preferences' }}</button>
        <span v-else class="status">{{ preference.isSaved(participant.id) ? '✓' : '…' }}</span>
      </template>
    </ParticipantSidePanel>

    <main class="main">
      <header>
        <h2>Rank the {{ N }} topics by your preference</h2>
        <p>Drag to reorder — top is most preferred, bottom least. Save when you're happy.</p>
      </header>
      <ol class="list">
        <li
          v-for="(id, i) in order"
          :key="id"
          draggable="true"
          @dragstart="dragIdx = i"
          @dragover.prevent
          @drop="onDrop(i)"
        >
          <span class="rank">{{ i + 1 }}</span>
          <div class="body">
            <h4>{{ cardById.get(id)?.title }}</h4>
            <p>{{ cardById.get(id)?.rationale }}</p>
          </div>
          <span class="grip">⠿</span>
        </li>
      </ol>
    </main>
  </div>
</template>

<style scoped>
.pref { display: grid; grid-template-columns: 240px 1fr; height: 100vh; background: #0b0e16; color: #e6ecff; }
.main { overflow-y: auto; padding: 1.5rem; }
header h2 { margin: 0; }
header p { opacity: 0.65; margin: 0.3rem 0 1.2rem; }
.list { list-style: none; padding: 0; margin: 0 auto; max-width: 640px; display: grid; gap: 0.5rem; }
.list li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.75rem; background: #11141f; border: 1px solid #232b44; border-radius: 12px; padding: 0.7rem 0.9rem; cursor: grab; }
.rank { font-size: 1.1rem; font-weight: 700; opacity: 0.5; width: 1.5rem; text-align: center; }
.body h4 { margin: 0; }
.body p { margin: 0.2rem 0 0; font-size: 0.82rem; opacity: 0.7; }
.grip { opacity: 0.4; }
.save-btn { background: #4f7cff; border: none; color: #fff; border-radius: 8px; padding: 0.3rem 0.5rem; font-size: 0.72rem; cursor: pointer; }
.save-btn.ready { background: #2a7a44; }
.status { opacity: 0.6; }
</style>
