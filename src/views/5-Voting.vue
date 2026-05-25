<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useVotingStore } from '@/stores/voting';
import { encodedShapeForHeadcount, getShape, type ShapeName } from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import ParticipantAvatar from '@/components/ParticipantAvatar.vue';
import ParticipantSidePanel from '@/components/ParticipantSidePanel.vue';
import RightPopoutVote from '@/components/RightPopoutVote.vue';

const session = useSessionStore();
const participants = useParticipantsStore();
const voting = useVotingStore();
const { sessionId, drivingQuestion, myParticipantId } = storeToRefs(session);

const shapeName = computed<ShapeName>(
  () => session.session?.locked_shape ?? encodedShapeForHeadcount(participants.active.length),
);
const N = computed(() => getShape(shapeName.value).topicCount);
/**
 * Some formats schedule meetings for only the top `topicsCovered` topics
 * (e.g. "Top four 60" drops the bottom 2 of 6 by vote). We still vote all
 * topicCount topics into existence so the polyhedron has its vertices, but
 * slots beyond `meetingTopicCount` are visually marked as "will be dropped".
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
const topSlots = computed(() => {
  const top = voting.topNCards(N.value);
  return Array.from({ length: N.value }, (_, i) => top[i] ?? null);
});

const myRemaining = computed(() => (myParticipantId.value ? voting.votesRemaining(myParticipantId.value) : 0));
const doneIds = computed(() => participants.active.filter((p) => voting.votesCast(p.id) >= voting.VOTES_PER_PARTICIPANT).map((p) => p.id));

function pName(id: string) { return participants.byId(id)?.name ?? 'Anon'; }
function pRow(id: string) { return participants.byId(id); }
function myVotesOn(cardId: string) {
  return myParticipantId.value ? voting.voteList.filter((v) => v.participant_id === myParticipantId.value && v.topic_card_id === cardId).length : 0;
}

function vote(cardId: string) {
  if (myParticipantId.value) voting.castVote(sessionId.value, myParticipantId.value, cardId);
}
function unvote(cardId: string) {
  if (myParticipantId.value) voting.removeVote(myParticipantId.value, cardId);
}

// drag-to-merge
const dragId = ref<string | null>(null);
function onDrop(targetId: string) {
  if (dragId.value && dragId.value !== targetId && myParticipantId.value) {
    voting.proposeMerge(sessionId.value, myParticipantId.value, dragId.value, targetId);
  }
  dragId.value = null;
}

const openMerge = computed(() => voting.openMerges.find((m) => m.kind === 'merge') ?? null);
const myMergeVote = computed<'up' | 'down' | null>(() => {
  const m = openMerge.value; const id = myParticipantId.value;
  if (!m || !id) return null;
  return m.up.includes(id) ? 'up' : m.down.includes(id) ? 'down' : null;
});
function mergeTitle(m: { card_a: string | null; card_b: string | null }) {
  const a = m.card_a ? voting.cards.get(m.card_a)?.title : '?';
  const b = m.card_b ? voting.cards.get(m.card_b)?.title : '?';
  return `Merge “${a}” with “${b}”?`;
}
</script>

<template>
  <div class="voting">
    <ParticipantSidePanel :participants="participants.active" :active-id="myParticipantId" :done-ids="doneIds">
      <template #trailing="{ participant }">
        <span class="dots">
          <span v-for="i in voting.VOTES_PER_PARTICIPANT" :key="i" class="dot" :class="{ used: i > voting.votesRemaining(participant.id) }" />
        </span>
      </template>
    </ParticipantSidePanel>

    <main class="main">
      <header class="dq">{{ drivingQuestion }}</header>

      <section class="top">
        <div v-for="(c, i) in topSlots" :key="i" class="slot" :class="{ dropped: i >= meetingTopicCount }">
          <span class="rank">{{ i + 1 }}</span>
          <span v-if="i >= meetingTopicCount" class="drop-badge" title="This topic will not get a team meeting in this format">drops</span>
          <div v-if="c" class="slot-card">{{ c.title }}<span class="vc">{{ voting.voteCountByCard.get(c.id) ?? 0 }}</span></div>
          <div v-else class="slot-empty">—</div>
        </div>
      </section>
      <p v-if="droppedCount > 0" class="drop-note">
        This format only gives team meetings to the top {{ meetingTopicCount }} topics — the bottom {{ droppedCount }} by vote will be skipped.
      </p>

      <p class="hint">You have <strong>{{ myRemaining }}</strong> votes left · click a card to vote · drag one card onto another to propose a merge</p>

      <section class="cards">
        <article
          v-for="c in voting.visibleCards"
          :key="c.id"
          class="card"
          draggable="true"
          @dragstart="dragId = c.id"
          @dragover.prevent
          @drop="onDrop(c.id)"
          @click="vote(c.id)"
        >
          <h4>{{ c.title }}</h4>
          <p class="rat">{{ c.rationale }}</p>
          <div class="foot">
            <span class="count">{{ voting.voteCountByCard.get(c.id) ?? 0 }} votes</span>
            <button v-if="myVotesOn(c.id) > 0" class="x" @click.stop="unvote(c.id)">✕ remove ({{ myVotesOn(c.id) }})</button>
          </div>
          <div class="voters">
            <ParticipantAvatar v-for="(vid, i) in voting.voterAvatars(c.id)" :key="i" :id="vid" :name="pName(vid)" :avatar-url="pRow(vid)?.avatar_url" :is-bot="pRow(vid)?.is_bot" :size="20" />
          </div>
        </article>
      </section>
    </main>

    <RightPopoutVote
      v-if="openMerge"
      :title="mergeTitle(openMerge)"
      up-label="Merge"
      down-label="Keep separate"
      :up-count="openMerge.up.length"
      :down-count="openMerge.down.length"
      :expires-at="openMerge.expires_at"
      :my-vote="myMergeVote"
      @up="myParticipantId && voting.voteMerge(openMerge!.id, myParticipantId, 'up')"
      @down="myParticipantId && voting.voteMerge(openMerge!.id, myParticipantId, 'down')"
      @extend="voting.extendTimer(openMerge!.id)"
    />
  </div>
</template>

<style scoped>
.voting { display: grid; grid-template-columns: 240px 1fr; height: 100vh; background: #0b0e16; color: #e6ecff; }
.main { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.dq { text-align: center; padding: 0.6rem; opacity: 0.7; border-bottom: 1px solid #1b2236; }
.top { height: 20vh; display: flex; gap: 0.5rem; padding: 0.5rem; overflow-x: auto; align-items: stretch; }
.slot { flex: 1 0 110px; border: 1px dashed #2a3350; border-radius: 10px; padding: 0.4rem; position: relative; display: grid; transition: opacity 0.15s, border-color 0.15s; }
.slot.dropped { opacity: 0.5; border-style: solid; border-color: #3a2a2a; background: rgba(96, 32, 32, 0.08); }
.slot.dropped .slot-card .vc { color: #9fb0d8; }
.drop-badge { position: absolute; top: 4px; right: 6px; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: #e8a48b; background: rgba(96, 32, 32, 0.3); padding: 0.1rem 0.4rem; border-radius: 999px; }
.drop-note { text-align: center; opacity: 0.7; font-size: 0.78rem; color: #e8a48b; margin: 0.2rem 0 0; padding: 0 0.5rem; }
.rank { position: absolute; top: 4px; left: 6px; opacity: 0.5; font-size: 0.8rem; }
.slot-card { align-self: center; text-align: center; font-size: 0.85rem; }
.slot-card .vc { display: block; color: #5ad17a; font-weight: 700; }
.slot-empty { align-self: center; text-align: center; opacity: 0.3; }
.hint { text-align: center; opacity: 0.6; font-size: 0.82rem; margin: 0.4rem 0; }
.cards { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; padding: 0.75rem; align-content: start; }
.card { background: #11141f; border: 1px solid #232b44; border-radius: 12px; padding: 0.75rem; cursor: pointer; transition: border-color 0.15s; }
.card:hover { border-color: #4f7cff; }
.card h4 { margin: 0 0 0.4rem; }
.rat { margin: 0; font-size: 0.82rem; opacity: 0.75; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; }
.count { color: #5ad17a; font-size: 0.8rem; }
.x { background: none; border: none; color: #e06c75; cursor: pointer; font-size: 0.78rem; }
.voters { display: flex; flex-wrap: wrap; gap: 2px; margin-top: 0.4rem; }
.dots { display: inline-flex; gap: 3px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #4f7cff; }
.dot.used { background: #2a3350; }
</style>
