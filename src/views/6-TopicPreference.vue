<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useVotingStore } from '@/stores/voting';
import { usePreferenceStore } from '@/stores/preference';
import { encodedShapeForHeadcount, getShape, type ShapeName } from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import draggable from 'vuedraggable';
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
/**
 * Mirrors 5-Voting.vue's meetingTopicCount: formats may schedule meetings for
 * only the top `topicsCovered` topics (e.g. "Top 4 of 6"). The voting step
 * shows all 6 with the bottom 2 visibly marked as dropped; the ranking step
 * should rank only the topics that will actually be scheduled, so we slice
 * the winners list to topicsCovered here.
 */
const meetingTopicCount = computed(() => {
  const id = session.session?.session_format_id;
  if (!id) return N.value;
  const f = getFormat(id as SessionFormatId);
  const or = f?.stages.find((s) => s.kind === 'outcome-resolve');
  if (!or || or.kind !== 'outcome-resolve') return N.value;
  return or.topicsCovered ?? N.value;
});
const droppedCount = computed(() => Math.max(0, N.value - meetingTopicCount.value));
const winners = computed(() => voting.topNCards(meetingTopicCount.value));
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

const dragging = ref(false);
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
        <h2>Rank the {{ meetingTopicCount }} topics by your preference</h2>
        <p>
          Drag to reorder — top is most preferred, bottom least. Save when you're happy.
          <span v-if="droppedCount > 0" class="note"> (bottom {{ droppedCount }} dropped by format)</span>
        </p>
      </header>
      <draggable
        v-model="order"
        tag="ol"
        class="list"
        :class="{ 'is-dragging': dragging }"
        :item-key="(el: string) => el"
        :animation="180"
        ghost-class="ghost"
        chosen-class="chosen"
        drag-class="drag"
        @start="dragging = true"
        @end="dragging = false; autosave()"
      >
        <template #item="{ element: id, index: i }">
          <li class="row">
            <span class="rank">{{ i + 1 }}</span>
            <div class="body">
              <h4>{{ cardById.get(id)?.title }}</h4>
              <p>{{ cardById.get(id)?.rationale }}</p>
            </div>
            <span class="grip">⠿</span>
          </li>
        </template>
      </draggable>
    </main>
  </div>
</template>

<style scoped>
.pref { display: grid; grid-template-columns: 240px 1fr; height: 100vh; background: #0b0e16; color: #e6ecff; }
.main { overflow-y: auto; padding: 1.5rem; }
header h2 { margin: 0; }
header p { opacity: 0.65; margin: 0.3rem 0 1.2rem; }
header p .note { color: #f5c66c; }
.list { list-style: none; padding: 0; margin: 0 auto; max-width: 640px; display: flex; flex-direction: column; gap: 0.5rem; }
.row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.75rem; background: #11141f; border: 1px solid #232b44; border-radius: 12px; padding: 0.7rem 0.9rem; cursor: grab; transition: box-shadow 0.15s, border-color 0.15s; }
.row:hover { border-color: #2f3a5e; }
.rank { font-size: 1.1rem; font-weight: 700; opacity: 0.5; width: 1.5rem; text-align: center; }
.body h4 { margin: 0; }
.body p { margin: 0.2rem 0 0; font-size: 0.82rem; opacity: 0.7; }
.grip { opacity: 0.4; cursor: grab; }

/* The gap left where the held card will drop. */
.ghost { opacity: 0.35; border: 1px dashed #4f7cff; background: #161c2e; }
.ghost * { visibility: hidden; }
/* The card the pointer picked up. */
.chosen { border-color: #4f7cff; }
/* The floating card following the cursor. */
.drag { cursor: grabbing; box-shadow: 0 12px 30px rgba(0,0,0,0.55); border-color: #4f7cff; transform: scale(1.02); opacity: 0.95; }
.list.is-dragging .row { cursor: grabbing; }
.save-btn { background: #4f7cff; border: none; color: #fff; border-radius: 8px; padding: 0.3rem 0.5rem; font-size: 0.72rem; cursor: pointer; }
.save-btn.ready { background: #2a7a44; }
.status { opacity: 0.6; }
</style>
