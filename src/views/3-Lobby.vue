<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useBotStore } from '@/stores/bots';
import { supabase } from '@/services/supabase';
import { encodedShapeForHeadcount, getShape, SHAPE_META, MAX_PARTICIPANTS, type ShapeName } from '@/util';
import PolyhedronScene, { type SceneNode } from '@/components/PolyhedronScene.vue';
import ParticipantAvatar from '@/components/ParticipantAvatar.vue';
import ProfileForm from '@/components/ProfileForm.vue';
import LobbyFormatPanel from '@/components/3-LobbyFormatPanel.vue';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import type { ParticipantRow } from '@/services/db-types';

defineEmits<{ (e: 'enter-jostle'): void }>();

const session = useSessionStore();
const participants = useParticipantsStore();
const bots = useBotStore();
const { drivingQuestion, sessionId, myParticipantId } = storeToRefs(session);
const { online } = storeToRefs(participants);

/**
 * Is this participant actually in the browser right now?
 *
 * For scheduled sessions, promoteToLive pre-creates a participants row for
 * every committed person whether or not they've opened the link. The
 * Supabase Realtime presence channel only marks an id "online" once their
 * tab has connected, so this is the single source of truth for "is this
 * person actually here vs. a no-show ghost?".
 *
 * Bots don't have presence tracks (no browser); they're always considered
 * present since the driver tick speaks for them. The robot icon in the
 * avatar already distinguishes them visually.
 */
function isOnline(id: string): boolean {
  return online.value.has(id);
}

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

/** "N of M connected" footer counter (humans only — bots are always here). */
const humansCount = computed(() => participants.humans.length);
const humansOnlineCount = computed(() => participants.humans.filter((p) => isOnline(p.id)).length);

// ── Format picker (slide-up drawer from the footer chip) ─────────────────
const formatPaneOpen = ref(false);
const currentFormatName = computed<string>(() => {
  const id = session.session?.session_format_id;
  if (!id) return 'Choose a format';
  try { return getFormat(id as SessionFormatId).name; } catch { return 'Choose a format'; }
});
/**
 * The committed format's shape no longer fits the lobby's live shape — e.g.
 * the host picked a tetra format at schedule time and the lobby has grown to
 * octa-sized. We decorate the chip with a warning glyph so users notice the
 * drawer is offering them a swap.
 */
const formatShapeMismatch = computed<boolean>(() => {
  const id = session.session?.session_format_id;
  if (!id || !shapeName.value) return false;
  try {
    return getFormat(id as SessionFormatId).shape !== shapeName.value;
  } catch { return false; }
});

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

/**
 * Show the no-show remove X on cards where it actually makes sense:
 *  - not me, not a bot (bots have their own X)
 *  - currently offline (Realtime presence says they're not connected)
 * The participant must also be a ghost (presence-detection has had a chance
 * to register them as online — we don't show the X on freshly-joined people
 * who haven't been observed yet).
 */
function canKick(p: ParticipantRow): boolean {
  return !p.is_bot && p.id !== myParticipantId.value && !isOnline(p.id);
}

/**
 * Remove a committed-but-not-here ghost from the session.
 *
 * Two steps so they can rejoin via their original invite link later:
 *   1. Soft-remove the participants row (removed=true). active list updates
 *      via realtime; headcount and shape derive from the new total.
 *   2. Null out scheduled_commitments.participant_id where it pointed at the
 *      removed row. Without this, the next visit would land on RemovedScreen
 *      (SessionShell reads myParticipantId → fetches the row → removed=true
 *      → renders RemovedScreen). Clearing the pointer routes them through
 *      the normal /profile create-fresh-participant path instead.
 */
async function removeNoShow(p: ParticipantRow): Promise<void> {
  if (!canKick(p)) return;
  const who = p.name?.trim() || 'this participant';
  if (!confirm(`Remove ${who} from the session?\n\nThey haven't connected. If they show up later via their invite link, they'll be able to rejoin.`)) return;
  await participants.markRemoved([p.id]);
  await supabase.from('scheduled_commitments').update({ participant_id: null }).eq('participant_id', p.id);
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
      <div
        v-for="p in leftCards"
        :key="p.id"
        class="card"
        :class="{ me: p.id === myParticipantId, offline: !p.is_bot && !isOnline(p.id) }"
        @click="onCardClick(p)"
      >
        <span
          v-if="!p.is_bot"
          class="dot"
          :class="{ on: isOnline(p.id) }"
          :title="isOnline(p.id) ? 'Connected' : 'Committed but not yet here'"
        />
        <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="34" />
        <span class="cn">{{ p.name || 'Anon' }}</span>
        <button v-if="p.is_bot" class="card-x" title="Remove bot" @click.stop="removeBot(p.id)">✕</button>
        <button v-else-if="canKick(p)" class="card-x" title="Remove no-show (they can rejoin via their invite link)" @click.stop="removeNoShow(p)">✕</button>
      </div>
    </aside>

    <section class="stage">
      <PolyhedronScene :shape-name="shapeName" :edge-nodes="edgeNodes" :vertex-labels="[]" :rotate="true" />
    </section>

    <aside class="cards right">
      <div
        v-for="p in rightCards"
        :key="p.id"
        class="card"
        :class="{ me: p.id === myParticipantId, offline: !p.is_bot && !isOnline(p.id) }"
        @click="onCardClick(p)"
      >
        <span
          v-if="!p.is_bot"
          class="dot"
          :class="{ on: isOnline(p.id) }"
          :title="isOnline(p.id) ? 'Connected' : 'Committed but not yet here'"
        />
        <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="34" />
        <span class="cn">{{ p.name || 'Anon' }}</span>
        <button v-if="p.is_bot" class="card-x" title="Remove bot" @click.stop="removeBot(p.id)">✕</button>
        <button v-else-if="canKick(p)" class="card-x" title="Remove no-show (they can rejoin via their invite link)" @click.stop="removeNoShow(p)">✕</button>
      </div>
    </aside>

    <!-- mobile count chip -->
    <button class="chip" @click="showRoster = true">{{ headcount }} 👥</button>
    <div v-if="showRoster" class="modal" @click.self="showRoster = false">
      <div class="modal-inner">
        <h3>In the lobby ({{ headcount }})</h3>
        <ul>
          <li v-for="p in roster" :key="p.id" :class="{ offline: !p.is_bot && !isOnline(p.id) }">
            <span
              v-if="!p.is_bot"
              class="dot"
              :class="{ on: isOnline(p.id) }"
              :title="isOnline(p.id) ? 'Connected' : 'Committed but not yet here'"
            />
            <ParticipantAvatar :id="p.id" :name="p.name" :avatar-url="p.avatar_url" :is-bot="p.is_bot" :size="30" />
            <span class="li-name">{{ p.name || 'Anon' }}</span>
            <button v-if="canKick(p)" class="li-x" title="Remove no-show (they can rejoin via their invite link)" @click="removeNoShow(p)">✕</button>
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
      <button
        class="format-chip"
        :class="{ warn: formatShapeMismatch }"
        :title="formatShapeMismatch ? 'The chosen format no longer fits the current shape — click to swap' : 'Choose how this session will run'"
        @click="formatPaneOpen = true"
      >
        <span v-if="formatShapeMismatch" class="format-chip-warn" aria-hidden="true">⚠</span>
        <span class="format-chip-label">{{ currentFormatName }}</span>
        <span class="format-chip-caret" aria-hidden="true">⋯</span>
      </button>
      <button class="primary" @click="$emit('enter-jostle')">Enter Problem Jostle →</button>
      <div class="foot-side foot-right">
        <strong>{{ headcount }} in lobby</strong>
        <span>{{ botCount }} bot{{ botCount === 1 ? '' : 's' }}</span>
        <span
          v-if="humansCount > 0"
          class="presence"
          :class="{ partial: humansOnlineCount < humansCount }"
          :title="humansOnlineCount < humansCount ? 'Some committed humans have not connected yet (greyed cards)' : 'All committed humans are here'"
        >
          {{ humansOnlineCount }} of {{ humansCount }} connected
        </span>
      </div>
    </footer>

    <!-- Slide-up format picker pane. Lives at the root so it can overlay the
         whole lobby (polyhedron, rails, footer) when open. -->
    <LobbyFormatPanel v-model:open="formatPaneOpen" :shape="shapeName" />

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
.cards { position: absolute; top: 0; bottom: 0; width: 190px; padding: 3.25rem 0.5rem 4.5rem; display: flex; flex-direction: column; gap: 0.3rem; overflow-y: auto; z-index: 5; background: transparent; pointer-events: none; }
.cards.left { left: 0; }
.cards.right { right: 0; }
/* container ignores pointers (so dragging the shape works through the gaps);
   the cards themselves stay interactive. */
.card { position: relative; flex: none; display: flex; align-items: center; gap: 0.5rem; background: rgba(17,20,31,0.55); backdrop-filter: blur(6px); border: 1px solid rgba(35,43,68,0.7); color: #e6ecff; border-radius: 10px; padding: 0.28rem 0.5rem; font: inherit; text-align: left; pointer-events: auto; }
.card.me { border-color: #4f7cff; cursor: pointer; }
/* Committed but not yet here — pre-populated from a scheduled commitment whose
   browser hasn't connected. Dim the card so it's distinguishable from real
   attendees at a glance. */
.card.offline { opacity: 0.5; }
.card.offline .cn { font-style: italic; }
.card .cn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Presence dot. Green = connected via realtime presence; grey = not here yet. */
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #4a5168; box-shadow: 0 0 0 1px rgba(0,0,0,0.25); }
.dot.on { background: #8be8a8; box-shadow: 0 0 0 1px rgba(0,0,0,0.25), 0 0 4px rgba(139, 232, 168, 0.4); }
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
/* Connection counter: green when full, amber when some are no-shows. */
.presence { color: #8be8a8; opacity: 0.9; }
.presence.partial { color: #f5c66c; opacity: 1; }
.primary { background: #4f7cff; color: #fff; border: none; border-radius: 12px; padding: 0.8rem 1.6rem; font: inherit; cursor: pointer; pointer-events: auto; }
/* Footer format chip — sits left of the primary Enter Jostle button. Opens
 * the slide-up format drawer; mirrors the chip pattern (.chip on mobile) but
 * with a label + caret + optional warn glyph for shape mismatch. */
.format-chip {
  pointer-events: auto;
  display: inline-flex; align-items: center; gap: 0.4rem;
  background: rgba(17, 20, 31, 0.7); backdrop-filter: blur(6px);
  border: 1px solid #2a3350; color: #cdd6f4;
  border-radius: 999px; padding: 0.55rem 0.95rem;
  font: inherit; font-size: 0.82rem; cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  max-width: 220px;
}
.format-chip:hover { background: rgba(17, 20, 31, 0.95); border-color: #4f7cff; color: #e6ecff; }
.format-chip.warn { border-color: rgba(245, 198, 108, 0.5); color: #f5c66c; }
.format-chip.warn:hover { background: rgba(245, 198, 108, 0.1); }
.format-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.format-chip-caret { opacity: 0.65; font-size: 0.7rem; }
.format-chip-warn { font-size: 0.85rem; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; z-index: 20; }
.modal-inner { background: #11141f; padding: 1.2rem; border-radius: 14px; width: min(360px, 90vw); }
.modal-inner ul { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.4rem; max-height: 50vh; overflow-y: auto; }
.modal-inner li { display: flex; align-items: center; gap: 0.5rem; }
.modal-inner li.offline { opacity: 0.55; }
.modal-inner li.offline { font-style: italic; }
.modal-inner li .li-name { flex: 1; }
/* Mobile roster remove — always visible on touch; subtle on desktop too. */
.modal-inner li .li-x { background: transparent; border: 1px solid #6c2a30; color: #e06c75; border-radius: 6px; padding: 0.1rem 0.4rem; cursor: pointer; font-size: 0.7rem; line-height: 1; opacity: 0.85; }
.modal-inner li .li-x:hover { background: rgba(224, 108, 117, 0.12); opacity: 1; }
.ghost { background: transparent; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 10px; padding: 0.5rem 1rem; cursor: pointer; }
.modal-inner.edit { border: 1px solid #232b44; }
.edit-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.edit-hd h3 { margin: 0; }
.x { background: none; border: none; color: #cdd6f4; font-size: 1.1rem; cursor: pointer; }
/* Stacked just above the fixed Join Live Call button (SessionCallButton:
   bottom 1.5rem, right 1.5rem, ~36px tall) so the two no longer overlap. Right
   edges align; this sits with a small gap above it. */
.bot-add { position: fixed; bottom: 4.75rem; right: 1.5rem; z-index: 51; width: 36px; height: 36px; border-radius: 50%; background: #11141f; border: 1px solid #8a94b0; cursor: pointer; display: grid; place-items: center; opacity: 0.65; transition: opacity 0.15s; }
.bot-add:hover { opacity: 1; }
.bot-add:active { transform: scale(0.94); }
.bot-add:disabled { opacity: 0.35; cursor: default; }
.bot-count { position: absolute; top: -5px; right: -5px; background: #8a94b0; color: #fff; font-size: 0.6rem; min-width: 15px; height: 15px; border-radius: 999px; display: grid; place-items: center; padding: 0 3px; }
@media (max-width: 800px) {
  .lobby { grid-template-columns: 1fr; }
  .cards { display: none; }
  .chip { display: block; }
}
</style>
