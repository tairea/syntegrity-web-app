<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useGraphStore } from '@/stores/graph';
import { useMeetRoomsStore } from '@/stores/meetRooms';
import { getShape, type AssignmentMethod } from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import { ordinal } from '@/util/timetable';
import PolyhedronScene, { type SceneNode, type FocusTarget } from '@/components/PolyhedronScene.vue';
import MethodToggle from '@/components/7-MethodToggle.vue';
import SchedulePanel from '@/components/7-SchedulePanel.vue';

const session = useSessionStore();
const participants = useParticipantsStore();
const graph = useGraphStore();
const meetRooms = useMeetRoomsStore();
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

// ── Format-change toast ────────────────────────────────────────────────
// Fires when session_format_id transitions to a different non-null value.
// Both the host who initiated the swap and every other connected client see
// the toast (the host via the optimistic local set in updateSessionFormat,
// others via the existing realtime subscription on the sessions row).
const formatToast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => session.session?.session_format_id ?? null,
  (next, prev) => {
    if (!next || !prev || next === prev) return;
    let name = next;
    try { name = getFormat(next as SessionFormatId).name; } catch { /* fall back to id */ }
    formatToast.value = `Session format changed to ${name}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { formatToast.value = null; }, 4000);
  },
);
onUnmounted(() => { if (toastTimer) clearTimeout(toastTimer); });

// ── Outcome Resolve: bottom-middle Join CTA ────────────────────────────────
// During phase='resolve' the driver mints one Meet room per team-meeting in
// the current slot. Each participant sees a button to join THEIR room for
// THIS slot (members + critics both); off-round participants see a passive
// "back in slot N" notice instead. Once the slot timer enters its last 5s,
// the card flips to a "wrapping up in N…" warning. The actual end-rooms
// call is made by the driver tick — clients just compute their own countdown
// from `resolve_slot_started_at` + format.slotMinutes (both replicated via
// realtime so every client lands on the same number).

// Local 1s ticker so the countdown re-renders without spamming the driver.
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { nowTimer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (nowTimer) clearInterval(nowTimer); });

const inResolve = computed(() => session.session?.phase === 'resolve');
const currentSlotIndex = computed(() => session.session?.resolve_current_slot_index ?? null);

const slotMinutes = computed(() => {
  const id = session.session?.session_format_id;
  if (!id) return 15;
  try {
    const fmt = getFormat(id as SessionFormatId);
    const stage = fmt.stages.find((st) => st.kind === 'outcome-resolve');
    if (stage && stage.kind === 'outcome-resolve') return stage.slotMinutes;
  } catch { /* default */ }
  return 15;
});

/** Milliseconds remaining in the current slot, or null when not in resolve. */
const msRemaining = computed<number | null>(() => {
  if (!inResolve.value) return null;
  const startedAt = session.session?.resolve_slot_started_at;
  if (!startedAt) return null;
  const endsAt = new Date(startedAt).getTime() + slotMinutes.value * 60_000;
  return endsAt - now.value;
});

/** This participant's PersonalScheduleItem for the live slot, if any. */
const myCurrentItem = computed(() => {
  const sched = activeSchedule.value;
  const myId = myParticipantId.value;
  const slot = currentSlotIndex.value;
  if (!sched || !myId || slot == null) return null;
  const mine = sched.perParticipant.find((p) => p.participantId === myId);
  return mine?.items.find((it) => it.slotIndex === slot) ?? null;
});

const myCurrentRoom = computed(() => {
  const item = myCurrentItem.value;
  const slot = currentSlotIndex.value;
  if (!item || slot == null) return undefined;
  return meetRooms.byCurrentSlotAndTopic(slot, item.teamTopicId);
});

const myCurrentTopicTitle = computed(() => {
  const item = myCurrentItem.value;
  if (!item) return '';
  return topicTitleMap.value.get(item.teamTopicId) ?? '(untitled)';
});

const myName = computed(() => {
  const id = myParticipantId.value;
  return (id && participants.byId(id)?.name) || 'You';
});

const joinLabel = computed(() => {
  const slot = currentSlotIndex.value;
  const item = myCurrentItem.value;
  if (slot == null || !item) return '';
  return `Join your ${ordinal(slot + 1)} session — "${myCurrentTopicTitle.value}" (as ${item.role})`;
});

/** Next slot index (after the live one) where this participant has a meeting; null if none. */
const myNextSlotIndex = computed<number | null>(() => {
  const sched = activeSchedule.value;
  const myId = myParticipantId.value;
  const slot = currentSlotIndex.value;
  if (!sched || !myId || slot == null) return null;
  const mine = sched.perParticipant.find((p) => p.participantId === myId);
  const next = mine?.items.find((it) => it.slotIndex > slot);
  return next?.slotIndex ?? null;
});

/** Seconds left when in the last-5s warning window; null otherwise. */
const warningSecondsLeft = computed<number | null>(() => {
  const ms = msRemaining.value;
  if (ms == null) return null;
  if (ms > 5_000 || ms < 0) return null;
  return Math.max(0, Math.ceil(ms / 1000));
});

function joinMyRoom(): void {
  const room = myCurrentRoom.value;
  if (!room) return;
  window.open(room.meet_uri, '_blank', 'noopener,noreferrer');
}
</script>

<template>
  <div class="graph">
    <SchedulePanel :schedule="activeSchedule ?? null" :my-id="myParticipantId" :topic-title="topicTitleMap" />

    <transition name="toast">
      <div v-if="formatToast" class="format-toast" role="status" aria-live="polite">
        {{ formatToast }}
      </div>
    </transition>


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
          <button @click="graph.toggleCritique()">
            <img :src="`https://api.iconify.design/mdi/${critiqueMode ? 'account-group-outline' : 'comment-search-outline'}.svg?color=%23ffffff`" width="15" height="15" alt="" />
            {{ critiqueMode ? 'Show normal' : 'Show critique' }}
          </button>
          <button class="ghost" @click="graph.setFocus(null)">Clear</button>
        </div>
      </div>

      <!-- Outcome Resolve: bottom-middle Join CTA. Only visible during the
           resolve phase; sits below where focus-card would render. -->
      <div v-if="inResolve" class="join-card" :class="{ warning: warningSecondsLeft !== null }">
        <template v-if="warningSecondsLeft !== null">
          <p class="ft">Wrapping up</p>
          <h3 class="warning-n">{{ warningSecondsLeft }}</h3>
          <p class="hint">Meet room closing — return here for your next session.</p>
        </template>
        <template v-else-if="myCurrentItem && myCurrentRoom">
          <button class="join-btn" @click="joinMyRoom">{{ joinLabel }}</button>
          <p class="hint">When Meet asks your name, enter: <strong>{{ myName }} ({{ myCurrentItem.role }})</strong></p>
        </template>
        <template v-else-if="myCurrentItem && !myCurrentRoom">
          <p class="ft">Preparing room…</p>
          <p class="hint">Your Meet room for "{{ myCurrentTopicTitle }}" is being created.</p>
        </template>
        <template v-else>
          <p class="ft">You're off this round</p>
          <p class="hint">
            <template v-if="myNextSlotIndex !== null">Back in slot {{ myNextSlotIndex + 1 }}.</template>
            <template v-else>No more sessions for you.</template>
          </p>
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* The schedule panel floats over the stage (see SchedulePanel) rather than taking
 * a grid column, so collapsing/expanding it never resizes the WebGL canvas — the
 * graph stays put instead of redrawing on every toggle. */
.graph { position: relative; height: 100vh; overflow: hidden; background: radial-gradient(circle at 60% 40%, #141a2c, #0b0e16); color: #e6ecff; }
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
.row button { display: inline-flex; align-items: center; gap: 0.35rem; background: #4f7cff; border: none; color: #fff; border-radius: 8px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; }
.row button img { display: block; }
.row .ghost { background: transparent; border: 1px solid #2a3350; color: #cdd6f4; }

/* Floating toast for realtime format swaps */
.format-toast {
  position: absolute; top: 1rem; right: 1rem; z-index: 30;
  background: #11141f; border: 1px solid #4f7cff;
  color: #e6ecff; padding: 0.55rem 0.9rem; border-radius: 10px;
  font-size: 0.85rem; box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(79,124,255,0.25);
  max-width: 320px;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-6px); }

/* Outcome Resolve bottom-middle join card. Same position as .focus-card so
 * the two never overlap (focus is selection-driven; join only renders during
 * resolve phase — design treats them as alternates rather than stacked). */
.join-card {
  position: absolute; bottom: 1.2rem; left: 50%; transform: translateX(-50%);
  background: #11141f; border: 1px solid #232b44; border-radius: 14px;
  padding: 1rem 1.4rem; text-align: center; min-width: 320px; max-width: 520px;
  z-index: 10;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.join-card.warning { border-color: #f5c66c; background: linear-gradient(180deg, #1d1812, #11141f); }
.join-card .ft { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.55; margin: 0 0 0.4rem; }
.join-card .hint { margin: 0.5rem 0 0; font-size: 0.8rem; opacity: 0.7; line-height: 1.4; }
.join-card .hint strong { color: #cdd6f4; opacity: 1; }
.join-btn {
  background: linear-gradient(180deg, #4f7cff, #3a5fdc); border: none; color: #fff;
  border-radius: 10px; padding: 0.75rem 1.2rem; cursor: pointer; font: inherit;
  font-weight: 600; font-size: 0.95rem;
  box-shadow: 0 4px 14px rgba(79, 124, 255, 0.3);
  transition: transform 0.08s, box-shadow 0.15s;
}
.join-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79, 124, 255, 0.4); }
.warning-n {
  font-size: 2.4rem; font-weight: 700; color: #f5c66c; margin: 0.1rem 0 0.2rem;
  font-variant-numeric: tabular-nums;
}
</style>
