<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useBotStore } from '@/stores/bots';
import { encodedShapeForHeadcount, getShape, SHAPE_META, MAX_PARTICIPANTS, type ShapeName } from '@/util';
import PolyhedronScene, { type SceneNode } from '@/components/PolyhedronScene.vue';
import ParticipantAvatar from '@/components/ParticipantAvatar.vue';
import ProfileForm from '@/components/ProfileForm.vue';
import type { ParticipantRow } from '@/services/db-types';

defineEmits<{ (e: 'enter-jostle'): void }>();

const session = useSessionStore();
const participants = useParticipantsStore();
const bots = useBotStore();
const { drivingQuestion, sessionId, myParticipantId } = storeToRefs(session);

const showRoster = ref(false);
const showEdit = ref(false);
const addingBot = ref(false);

const botCount = computed(() => participants.bots.length);
async function addBot() {
  if (full.value) return; // icosahedron is the ceiling (30)
  addingBot.value = true;
  try {
    await bots.spawnBots(sessionId.value, 1);
  } finally {
    addingBot.value = false;
  }
}

const roster = computed(() =>
  [...participants.active].sort((a, b) => a.joined_at.localeCompare(b.joined_at)),
);
const headcount = computed(() => roster.value.length);

/** Smallest encoded shape that fits everyone; rolls up as positions fill (6 → 12 → 30). */
const shapeName = computed<ShapeName>(() => encodedShapeForHeadcount(headcount.value));
const full = computed(() => headcount.value >= MAX_PARTICIPANTS);

const edgeNodes = computed<(SceneNode | null)[]>(() => {
  const count = getShape(shapeName.value).participantCount;
  return Array.from({ length: count }, (_, i) => {
    const p = roster.value[i];
    return p ? { id: p.id, name: p.name || 'Anon', avatarUrl: p.avatar_url, isBot: p.is_bot } : null;
  });
});

const leftCards = computed(() => roster.value.filter((_, i) => i % 2 === 0));
const rightCards = computed(() => roster.value.filter((_, i) => i % 2 === 1));

const meta = computed(() => SHAPE_META[shapeName.value]);
const capShape = computed(() => shapeName.value.charAt(0).toUpperCase() + shapeName.value.slice(1));

function onCardClick(p: ParticipantRow) {
  if (p.id === myParticipantId.value) showEdit.value = true;
}
function removeBot(id: string) {
  bots.removeBot(id);
}

</script>

<template>
  <div class="lobby">
    <header class="dq">
      <p class="dq-label">Driving Question</p>
      <p class="dq-text">{{ drivingQuestion }}</p>
    </header>

    <!-- desktop side cards -->
    <aside class="cards left">
      <div v-for="p in leftCards" :key="p.id" class="card" :class="{ me: p.id === myParticipantId }" @click="onCardClick(p)">
        <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="34" />
        <span class="cn">{{ p.name || 'Anon' }}</span>
        <button v-if="p.is_bot" class="card-x" title="Remove bot" @click.stop="removeBot(p.id)">✕</button>
      </div>
    </aside>

    <section class="stage">
      <PolyhedronScene :shape-name="shapeName" :edge-nodes="edgeNodes" :vertex-labels="[]" :rotate="true" />
    </section>

    <aside class="cards right">
      <div v-for="p in rightCards" :key="p.id" class="card" :class="{ me: p.id === myParticipantId }" @click="onCardClick(p)">
        <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="34" />
        <span class="cn">{{ p.name || 'Anon' }}</span>
        <button v-if="p.is_bot" class="card-x" title="Remove bot" @click.stop="removeBot(p.id)">✕</button>
      </div>
    </aside>

    <!-- mobile count chip -->
    <button class="chip" @click="showRoster = true">{{ headcount }} 👥</button>
    <div v-if="showRoster" class="modal" @click.self="showRoster = false">
      <div class="modal-inner">
        <h3>In the lobby ({{ headcount }})</h3>
        <ul>
          <li v-for="p in roster" :key="p.id">
            <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="30" />
            {{ p.name || 'Anon' }}
          </li>
        </ul>
        <button class="ghost" @click="showRoster = false">Close</button>
      </div>
    </div>

    <footer class="enter">
      <div class="foot-side foot-left">
        <strong>{{ capShape }}</strong>
        <span>{{ meta.participantCount }} positions · {{ meta.topicCount }} topics</span>
        <span class="note">{{ full ? 'Full (30 max)' : 'Grows as people join' }}</span>
      </div>
      <button class="primary" @click="$emit('enter-jostle')">Enter Problem Jostle →</button>
      <div class="foot-side foot-right">
        <strong>{{ headcount }} in lobby</strong>
        <span>{{ botCount }} bot{{ botCount === 1 ? '' : 's' }}</span>
      </div>
    </footer>

    <!-- add a bot participant (fills a vacant position; auto-contributes at every step) -->
    <button class="bot-add" :disabled="addingBot || full" :title="full ? 'Session full (30 max)' : 'Add a bot participant (auto-contributes at each step)'" @click="addBot">
      <img src="https://api.iconify.design/mdi/robot-outline.svg?color=%238a94b0" width="18" height="18" alt="" />
      <span v-if="botCount" class="bot-count">{{ botCount }}</span>
    </button>

    <!-- edit profile (modal overlay over the lobby) -->
    <div v-if="showEdit" class="modal" @click.self="showEdit = false">
      <div class="modal-inner edit">
        <header class="edit-hd">
          <h3>Edit your profile</h3>
          <button class="x" @click="showEdit = false" aria-label="Close">✕</button>
        </header>
        <ProfileForm :session-id="sessionId" submit-label="Save" @saved="showEdit = false" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lobby { position: relative; min-height: 100vh; background: radial-gradient(circle at 50% 40%, #141a2c, #0b0e16); color: #e6ecff; overflow: hidden; }
/* Stage fills the viewport; the side rails float over it so the 3D shape is
   visible behind them. */
.stage { position: absolute; inset: 0; z-index: 0; }
.dq { position: absolute; top: 1.2rem; left: 0; right: 0; text-align: center; z-index: 5; pointer-events: none; }
.dq-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7aa2ff; margin: 0 0 0.35rem; }
.dq-text { display: inline-block; background: rgba(17,20,31,0.82); padding: 0.7rem 1.4rem; border-radius: 14px; max-width: 80vw; margin: 0; font-size: 1.5rem; font-weight: 600; line-height: 1.25; }
.cards { position: absolute; top: 0; bottom: 0; width: 190px; padding: 4rem 0.5rem 6rem; display: flex; flex-direction: column; gap: 0.4rem; overflow-y: auto; z-index: 5; background: transparent; pointer-events: none; }
.cards.left { left: 0; }
.cards.right { right: 0; }
/* container ignores pointers (so dragging the shape works through the gaps);
   the cards themselves stay interactive. */
.card { position: relative; display: flex; align-items: center; gap: 0.5rem; background: rgba(17,20,31,0.55); backdrop-filter: blur(6px); border: 1px solid rgba(35,43,68,0.7); color: #e6ecff; border-radius: 10px; padding: 0.35rem 0.5rem; font: inherit; text-align: left; pointer-events: auto; }
.card.me { border-color: #4f7cff; cursor: pointer; }
.card .cn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-x { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: #e06c75; color: #fff; font-size: 0.6rem; line-height: 1; cursor: pointer; opacity: 0; transition: opacity 0.12s; }
.card:hover .card-x { opacity: 1; }
.chip { display: none; position: absolute; top: 1rem; right: 1rem; z-index: 6; background: #11141f; border: 1px solid #2a3350; color: #fff; border-radius: 999px; padding: 0.5rem 0.9rem; cursor: pointer; }
/* Centered cluster: geometry · button · counts all sit in the middle, between
   the side rails (not pushed out over them). */
.enter { position: absolute; bottom: 1.2rem; left: 0; right: 0; z-index: 6; display: flex; align-items: center; justify-content: center; gap: 1.75rem; pointer-events: none; }
.foot-side { display: flex; flex-direction: column; font-size: 0.8rem; line-height: 1.3; }
.foot-side.foot-left { text-align: right; align-items: flex-end; }
.foot-side.foot-right { text-align: left; align-items: flex-start; }
.foot-side strong { color: #e6ecff; }
.foot-side span { opacity: 0.6; }
.note { opacity: 0.5; }
.primary { background: #4f7cff; color: #fff; border: none; border-radius: 12px; padding: 0.8rem 1.6rem; font: inherit; cursor: pointer; pointer-events: auto; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; z-index: 20; }
.modal-inner { background: #11141f; padding: 1.2rem; border-radius: 14px; width: min(360px, 90vw); }
.modal-inner ul { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.4rem; max-height: 50vh; overflow-y: auto; }
.modal-inner li { display: flex; align-items: center; gap: 0.5rem; }
.ghost { background: transparent; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 10px; padding: 0.5rem 1rem; cursor: pointer; }
.modal-inner.edit { border: 1px solid #232b44; }
.edit-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.edit-hd h3 { margin: 0; }
.x { background: none; border: none; color: #cdd6f4; font-size: 1.1rem; cursor: pointer; }
.bot-add { position: absolute; bottom: 1.2rem; right: 1.2rem; z-index: 7; width: 36px; height: 36px; border-radius: 50%; background: transparent; border: 1px solid #8a94b0; cursor: pointer; display: grid; place-items: center; opacity: 0.65; transition: opacity 0.15s; }
.bot-add:hover { opacity: 1; }
.bot-add:active { transform: scale(0.94); }
.bot-add:disabled { opacity: 0.35; cursor: default; }
.bot-count { position: absolute; top: -5px; right: -5px; background: #2a7a44; color: #fff; font-size: 0.6rem; min-width: 15px; height: 15px; border-radius: 999px; display: grid; place-items: center; padding: 0 3px; }
@media (max-width: 800px) {
  .lobby { grid-template-columns: 1fr; }
  .cards { display: none; }
  .chip { display: block; }
}
</style>
