<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MeetingSession, SessionSchedule, ShapeName } from '@/util';
import { getShape } from '@/util';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import {
  getFormat, listFormatsForShape, type SessionFormatId,
} from '@/util/session-formats';

const props = defineProps<{
  schedule: SessionSchedule | null;
  myId: string | null;
  topicTitle: Map<string, string>;
}>();

const session = useSessionStore();
const participants = useParticipantsStore();

const open = ref(true);
const tab = ref<'mine' | 'full'>('mine');

const title = (id: string) => props.topicTitle.get(id) ?? id.slice(0, 6);
const mine = computed(() => props.schedule?.perParticipant.find((p) => p.participantId === props.myId) ?? null);

// ── Vacancy detection (sub-shape: fewer participants than the shape's positions)
const teamSize = computed<number | null>(() => {
  const sn = session.session?.locked_shape;
  if (!sn) return null;
  try { return getShape(sn).teamSize; } catch { return null; }
});
function shortMembers(s: MeetingSession): number {
  return Math.max(0, (teamSize.value ?? s.attendeeMemberIds.length) - s.attendeeMemberIds.length);
}
function shortCritics(s: MeetingSession): number {
  return Math.max(0, (teamSize.value ?? s.attendeeCriticIds.length) - s.attendeeCriticIds.length);
}
function shortLabel(s: MeetingSession): string {
  const m = shortMembers(s); const c = shortCritics(s);
  if (m && c) return `short ${m}m · ${c}c`;
  if (m) return `short ${m}m`;
  if (c) return `short ${c}c`;
  return '';
}

// ── Format swap ─────────────────────────────────────────────────────
// The session's locked_shape may have changed via lobby trim/pad reconciliation
// after the host picked the format at schedule time. If the current format's
// shape no longer matches, surface a picker so the host can swap to a
// compatible format. We always render the dropdown (useful even when matched),
// but show a banner only on mismatch.
const lockedShape = computed<ShapeName | null>(() => session.session?.locked_shape ?? null);
const currentFormatId = computed<string | null>(() => session.session?.session_format_id ?? null);
const currentFormat = computed(() => {
  const id = currentFormatId.value;
  if (!id) return null;
  try { return getFormat(id as SessionFormatId); } catch { return null; }
});
const shapeMismatch = computed(() =>
  !!currentFormat.value && !!lockedShape.value && currentFormat.value.shape !== lockedShape.value,
);
const formatOptions = computed(() => (lockedShape.value ? listFormatsForShape(lockedShape.value) : []));

const swapBusy = ref(false);
const swapError = ref('');

async function onFormatChange(e: Event): Promise<void> {
  const id = (e.target as HTMLSelectElement).value;
  if (!id || id === currentFormatId.value) return;
  swapBusy.value = true; swapError.value = '';
  try {
    await session.updateSessionFormat(id);
  } catch (err) {
    swapError.value = (err as Error).message;
  } finally {
    swapBusy.value = false;
  }
}

// ── Ready to Begin (gates the graph → resolve transition) ───────────────────
// Visible once the host has picked a format. Everyone clicks Ready to Begin;
// when allReady('resolve'), the driver tick mints slot-0 Meet rooms and flips
// phase to 'resolve'. After that, the button locks into an informational
// "session in progress" state.
const phase = computed(() => session.session?.phase ?? null);
const resolveStarted = computed(() => phase.value === 'resolve' || phase.value === 'done');
const showReadyPanel = computed(() => !!currentFormatId.value && (phase.value === 'graph' || resolveStarted.value));
const myReady = computed(() => {
  if (!props.myId) return false;
  return !!participants.byId(props.myId)?.ready_flags?.resolve;
});
const readyCount = computed(() => participants.readyCount('resolve'));
const totalActive = computed(() => participants.active.length);
const readyBusy = ref(false);

async function toggleReady(): Promise<void> {
  if (!props.myId || resolveStarted.value) return;
  readyBusy.value = true;
  try {
    await participants.setReady(props.myId, 'resolve', !myReady.value);
  } finally {
    readyBusy.value = false;
  }
}
</script>

<template>
  <aside class="sched" :class="{ collapsed: !open }">
    <button class="toggle" @click="open = !open">{{ open ? '◀ Schedule' : '▶' }}</button>
    <div v-if="open" class="content">
      <!-- Mismatch-only fallback: the primary format picker now lives in the
           lobby (3-LobbyFormatPanel.vue). This sidebar surface only reappears
           when POST-lobby reconciliation (trim/pad vote) changes the shape
           after a format was already committed, leaving the chosen format
           incompatible with the new shape. Same updateSessionFormat action,
           same banner copy — just no longer the always-visible primary entry. -->
      <section v-if="shapeMismatch && formatOptions.length" class="fmt-swap">
        <p class="fmt-warn">
          Shape changed to <strong>{{ lockedShape }}</strong> — pick a matching format.
        </p>
        <label class="fmt-lbl">Session format</label>
        <select :value="currentFormatId ?? ''" :disabled="swapBusy" @change="onFormatChange">
          <option v-if="!currentFormatId" value="" disabled>Choose a format…</option>
          <option v-for="f in formatOptions" :key="f.id" :value="f.id">{{ f.name }}</option>
        </select>
        <p v-if="swapError" class="fmt-err">{{ swapError }}</p>
      </section>

      <template v-if="schedule">
      <div class="tabs">
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">My schedule</button>
        <button :class="{ on: tab === 'full' }" @click="tab = 'full'">Full schedule</button>
      </div>
      <p class="meta">{{ schedule.slots.length }} slots · {{ schedule.concurrency }} concurrent · {{ schedule.iterations }} iterations</p>

      <div v-if="tab === 'mine'" class="list">
        <p v-if="!mine">You have no sessions.</p>
        <div v-for="it in mine?.items ?? []" :key="it.slotIndex + it.teamTopicId" class="row">
          <span class="slot">#{{ it.slotIndex + 1 }}</span>
          <span class="topic">{{ title(it.teamTopicId) }}</span>
          <span class="role" :class="it.role">{{ it.role }}</span>
          <span class="it">it{{ it.iteration }}</span>
        </div>
        <p v-if="mine?.offSlots.length" class="off">Off during slots: {{ mine.offSlots.map((s) => s + 1).join(', ') }}</p>
      </div>

      <div v-else class="list">
        <div v-for="slot in schedule.slots" :key="slot.index" class="slotblock">
          <p class="slothd">Slot {{ slot.index + 1 }}</p>
          <div v-for="s in slot.sessions" :key="s.teamTopicId" class="row">
            <span class="topic">{{ title(s.teamTopicId) }}</span>
            <span class="it">it{{ s.iteration }}</span>
            <span class="cnt">{{ s.attendeeMemberIds.length }}m / {{ s.attendeeCriticIds.length }}c</span>
            <span v-if="shortLabel(s)" class="short" :title="'This team has vacant positions because fewer participants joined than the chosen shape calls for.'">{{ shortLabel(s) }}</span>
          </div>
        </div>
      </div>
      </template>

      <!-- Ready to Begin: gates the graph → resolve transition. Renders once
           the host has picked a format; locks once resolve has started. -->
      <section v-if="showReadyPanel" class="ready">
        <p class="ready-count">{{ readyCount }} of {{ totalActive }} ready</p>
        <button
          v-if="!resolveStarted"
          class="ready-btn"
          :class="{ on: myReady }"
          :disabled="readyBusy || !myId"
          @click="toggleReady"
        >
          {{ myReady ? '✓ You\'re ready — click to undo' : 'Ready to Begin' }}
        </button>
        <p v-else class="ready-in-progress">Session in progress…</p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
/* Floats over the graph stage (absolute) so toggling its width animates on top of
 * the canvas without resizing it — keeps the 3D graph from redrawing per toggle. */
.sched { position: absolute; left: 0; top: 0; bottom: 0; z-index: 20; width: auto; max-width: 320px; background: #11141f; color: #e6ecff; overflow-y: auto; overflow-x: hidden; transition: max-width 0.2s; border-right: 1px solid #232b44; }
/* width:auto sizes to content (no inner x-scroll); the collapse animates via
 * max-width since `auto` itself can't be transitioned. */
.sched.collapsed { max-width: 40px; }
.toggle { width: 100%; background: #1b2236; border: none; color: #cdd6f4; padding: 0.6rem; cursor: pointer; text-align: left; }
.content { padding: 0.75rem; }
.tabs { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }
.tabs button { flex: 1; background: #0c0f18; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 8px; padding: 0.35rem; cursor: pointer; font-size: 0.78rem; }
.tabs button.on { background: #4f7cff; color: #fff; }
.meta { font-size: 0.72rem; opacity: 0.55; margin: 0 0 0.5rem; }
.list { display: grid; gap: 0.25rem; }
.row { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; background: #0c0f18; padding: 0.3rem 0.5rem; border-radius: 8px; }
.slot { opacity: 0.5; }
.topic { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role { font-size: 0.68rem; padding: 0 0.3rem; border-radius: 6px; }
.role.member { background: #2a4d7a; }
.role.critic { background: #6a2a4d; }
.it { opacity: 0.6; font-size: 0.7rem; }
.cnt { opacity: 0.6; font-size: 0.7rem; }
.short { font-size: 0.65rem; color: #f5c66c; background: rgba(245, 198, 108, 0.1); border: 1px solid rgba(245, 198, 108, 0.3); border-radius: 6px; padding: 0.05rem 0.35rem; line-height: 1.4; }
.slotblock { margin-bottom: 0.4rem; }
.slothd { font-size: 0.72rem; opacity: 0.6; margin: 0.4rem 0 0.2rem; }
.off { font-size: 0.72rem; opacity: 0.55; margin-top: 0.5rem; }

/* Format swap section */
.fmt-swap { display: grid; gap: 0.35rem; margin-bottom: 0.6rem; padding-bottom: 0.6rem; border-bottom: 1px solid #232b44; }
.fmt-lbl { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #9fb0d8; margin: 0; }
.fmt-swap select { background: #0c0f18; border: 1px solid #2a3350; color: #e6ecff; border-radius: 8px; padding: 0.4rem 0.5rem; font: inherit; font-size: 0.82rem; width: 100%; }
.fmt-swap select:disabled { opacity: 0.5; }
.fmt-warn { margin: 0; font-size: 0.78rem; color: #f5c66c; background: rgba(245, 198, 108, 0.08); border: 1px solid rgba(245, 198, 108, 0.3); border-radius: 8px; padding: 0.4rem 0.55rem; line-height: 1.35; }
.fmt-warn strong { text-transform: capitalize; color: #ffe2a8; }
.fmt-err { margin: 0; font-size: 0.75rem; color: #e06c75; }

/* Ready to Begin block — pinned to the bottom of the sidebar's natural flow */
.ready { margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid #232b44; display: grid; gap: 0.45rem; }
.ready-count { margin: 0; font-size: 0.72rem; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.05em; }
.ready-btn { background: linear-gradient(180deg, #4f7cff, #3a5fdc); border: none; color: #fff; border-radius: 10px; padding: 0.6rem 0.8rem; cursor: pointer; font: inherit; font-weight: 600; font-size: 0.88rem; box-shadow: 0 4px 14px rgba(79, 124, 255, 0.25); transition: transform 0.08s, box-shadow 0.15s, background 0.15s; }
.ready-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79, 124, 255, 0.35); }
.ready-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.ready-btn.on { background: linear-gradient(180deg, #2c8a4e, #1e6a3a); box-shadow: 0 4px 14px rgba(44, 138, 78, 0.3); }
.ready-in-progress { margin: 0; font-size: 0.82rem; color: #9fb0d8; text-align: center; font-style: italic; padding: 0.4rem; }
</style>
