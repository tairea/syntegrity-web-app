<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useVotingStore } from '@/stores/voting';
import { getShape, isShapeEncoded } from '@/util';
import type { SessionPhase } from '@/services/db-types';
import CountdownModal from '@/components/CountdownModal.vue';
import RemovedScreen from './RemovedScreen.vue';
import Lobby from './3-Lobby.vue';
import ProblemJostle from './4-ProblemJostle.vue';
import Voting from './5-Voting.vue';
import TopicPreference from './6-TopicPreference.vue';
import SyntegrityGraph from './7-SyntegrityGraph.vue';

const props = defineProps<{ sessionId: string }>();
const router = useRouter();
const route = useRoute();
const session = useSessionStore();
const participants = useParticipantsStore();
const { phase, countdown, myParticipantId } = storeToRefs(session);

const hydrated = ref(false);
/** Voluntary lobby→jostle: a lobby user only moves once they click Enter. */
const enteredJostle = ref(false);

onMounted(async () => {
  await session.connect(props.sessionId);
  hydrated.value = true;
});
onBeforeUnmount(() => session.disconnect());

const myRow = computed(() => (myParticipantId.value ? participants.byId(myParticipantId.value) : undefined));
const removed = computed(() => myRow.value?.removed === true);

const voting = useVotingStore();
const reconReason = computed(() => {
  const s = session.session;
  const targetPositions = s?.headcount_target
    ?? (s?.locked_shape && isShapeEncoded(s.locked_shape) ? getShape(s.locked_shape).participantCount : null);
  const m = [...voting.merges.values()].find((x) => x.kind === 'reconciliation' && x.status === 'approved');
  const removedCount = (m?.payload as { trim?: { removeCount?: number } } | undefined)?.trim?.removeCount ?? null;
  return { targetPositions, removedCount };
});

// Guards: a missing session (e.g. deleted) goes home; a missing profile goes to
// the profile step.
watch(
  () => [hydrated.value, myRow.value, session.session] as const,
  () => {
    if (!hydrated.value) return;
    if (!session.session) {
      router.replace({ name: 'initiate' });
      return;
    }
    if (!myRow.value || !myRow.value.name) {
      router.replace({ name: 'profile', params: { sessionId: props.sessionId } });
    }
  },
);

const viewFor: Record<SessionPhase, unknown> = {
  lobby: Lobby,
  reconciliation: Lobby,
  jostle: ProblemJostle,
  voting: Voting,
  preference: TopicPreference,
  graph: SyntegrityGraph,
  resolve: SyntegrityGraph,
  done: SyntegrityGraph,
};

/** Dev convenience: `/s/<id>?phase=graph` jumps straight to a step's view
 *  without mutating the session. Read-only — does not advance the real phase. */
const phaseOverride = computed<SessionPhase | null>(() => {
  const q = route.query.phase;
  const val = Array.isArray(q) ? q[0] : q;
  return val && val in viewFor ? (val as SessionPhase) : null;
});

const displayPhase = computed<SessionPhase>(() => {
  if (phaseOverride.value) return phaseOverride.value;
  const p = phase.value;
  if (p === 'jostle') return enteredJostle.value ? 'jostle' : 'lobby';
  if (p === 'reconciliation') return 'lobby';
  return p;
});
const currentView = computed(() => viewFor[displayPhase.value]);

async function onEnterJostle() {
  enteredJostle.value = true;
  await session.enterJostle();
}
</script>

<template>
  <div class="shell">
    <div v-if="!hydrated" class="center">Connecting…</div>
    <RemovedScreen v-else-if="removed" :target-positions="reconReason.targetPositions" :removed-count="reconReason.removedCount" />
    <component v-else :is="currentView" @enter-jostle="onEnterJostle" />
    <CountdownModal :to="countdown?.to ?? null" :n="countdown?.n ?? 0" />
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; background: #0b0e16; }
.center { display: grid; place-items: center; min-height: 100vh; color: #e6ecff; text-align: center; gap: 0.5rem; }
.removed h1 { color: #e06c75; }
</style>
