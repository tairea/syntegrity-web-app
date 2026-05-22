<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { forceSimulation, type Simulation, type SimulationNodeDatum } from 'd3-force';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import { useJostleStore } from '@/stores/jostle';
import { useBotStore } from '@/stores/bots';
import { useReconciliationStore } from '@/stores/reconciliation';
import { encodedShapeForHeadcount, getShape, type ShapeName } from '@/util';
import ParticipantAvatar from '@/components/ParticipantAvatar.vue';
import ClusterChatPanel from '@/components/4-ClusterChatPanel.vue';
import RightPopoutVote from '@/components/RightPopoutVote.vue';

const session = useSessionStore();
const participants = useParticipantsStore();
const jostle = useJostleStore();
const bots = useBotStore();
const reconciliation = useReconciliationStore();
const { sessionId, drivingQuestion, myParticipantId } = storeToRefs(session);

const stage = ref<HTMLDivElement | null>(null);
const dims = reactive({ w: 1000, h: 700 });
const draft = ref('');
const addingBotStmts = ref(false);

const CARD_W = 180, CARD_H = 58, GAP = 10, PAD = 10, HEADER = 26;
const DOT = 18, DOT_R = 9, DOT_GAP = 6;
const DOT_T = 0.58; // size below which a card collapses to a dot
const MIN_SIZE = 0.3, REVEAL = 0.95;
const TOP = 120, BOTTOM = 90; // clear of DQ/toolbar and input bar

const shapeName = computed<ShapeName>(
  () => session.session?.locked_shape ?? encodedShapeForHeadcount(participants.active.length),
);
const minClusters = computed(() => getShape(shapeName.value).topicCount);

const revealed = ref<Set<string>>(new Set());
function toggleReveal(id: string) {
  const next = new Set(revealed.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  revealed.value = next;
}

// ── LOOSE statements: pressure-driven per-card compression ─────────────────
// Each card carries a `size` (1=full). Crowded cards (high collision push) shrink;
// once a card drops below DOT_T it renders as a dot, freeing room so its neighbours
// can stay cards. Roomy cards grow back. Dots/cards thus emerge one at a time.
interface SNode extends SimulationNodeDatum { id: string; size: number; push: number; dot: boolean }
let snodes: SNode[] = [];
let ssim: Simulation<SNode, undefined> | null = null;
const loosePos = ref<Record<string, { x: number; y: number }>>({});
const looseSize = ref<Record<string, number>>({});
const looseDot = ref<Record<string, boolean>>({});

const cardR = (s: number) => (CARD_W * s) / 2 + 9;
const radiusOf = (n: SNode) => (revealed.value.has(n.id) ? cardR(REVEAL) : (n.dot ? DOT_R + 5 : cardR(n.size)));

function looseCollide() {
  for (const n of snodes) n.push = 0;
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < snodes.length; i++) {
      for (let j = i + 1; j < snodes.length; j++) {
        const a = snodes[i], b = snodes[j];
        let dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
        let dist = Math.hypot(dx, dy);
        if (dist === 0) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 0.01; }
        const overlap = radiusOf(a) + radiusOf(b) - dist;
        if (overlap > 0) {
          const ux = dx / dist, uy = dy / dist, push = overlap / 2;
          a.x = (a.x ?? 0) - ux * push; a.y = (a.y ?? 0) - uy * push;
          b.x = (b.x ?? 0) + ux * push; b.y = (b.y ?? 0) + uy * push;
          a.push += push; b.push += push;
        }
      }
    }
  }
}

function syncLoose() {
  const loose = jostle.visibleStatements.filter((s) => !s.cluster_id);
  const ids = new Set(loose.map((s) => s.id));
  snodes = snodes.filter((n) => ids.has(n.id));
  const have = new Set(snodes.map((n) => n.id));
  for (const s of loose) if (!have.has(s.id)) snodes.push({ id: s.id, size: 1, push: 0, dot: false, x: dims.w / 2 + (Math.random() - 0.5) * 300, y: dims.h / 2 + (Math.random() - 0.5) * 200 });
  ssim?.nodes(snodes);
  ssim?.alpha(0.6).restart();
}
watch(() => jostle.visibleStatements.map((s) => s.id + (s.cluster_id ?? '')).join(','), syncLoose);
watch(() => revealed.value.size, () => ssim?.alpha(0.5).restart());

// ── CLUSTER boxes: physics-positioned, sized from card/dot contents ────────
interface CNode extends SimulationNodeDatum { id: string; w: number; h: number }
let cnodes: CNode[] = [];
let csim: Simulation<CNode, undefined> | null = null;
const clusterPos = ref<Record<string, { x: number; y: number }>>({});

/** Lay a cluster out as some cards + (overflow) dots so its box fits a fair share. */
function clusterLayout(cid: string) {
  const n = jostle.statementsOf(cid).length;
  const focus = jostle.activeClusterId === cid;
  if (focus) {
    // Focus: every statement expands to a full, readable card (taller, full text).
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));
    const rows = Math.ceil(Math.max(1, n) / cols);
    const cardW = Math.max(150, Math.min(CARD_W, ((dims.w - 120) - (cols - 1) * GAP - PAD * 2) / cols));
    const cardH = 100;
    return { cards: n, dots: 0, cols, rows, dotCols: 1, cardW, cardH, font: 0.82, w: cols * cardW + (cols - 1) * GAP + PAD * 2, h: HEADER + rows * cardH + (rows - 1) * GAP + PAD * 2 };
  }
  const clusters = jostle.clusterList.length;
  const fair = ((dims.w - 60) * (dims.h - TOP - BOTTOM)) / Math.max(1, clusters) * 0.7;
  const s = 0.8;
  const cardW = CARD_W * s, cardH = CARD_H * s, font = 0.8 * s;
  for (let k = n; k >= 0; k--) {
    const d = boxFor(k, n - k, cardW, cardH);
    if (d.w * d.h <= fair || k === 0) return { cards: k, dots: n - k, cardW, cardH, font, ...d };
  }
  const d = boxFor(0, n, cardW, cardH);
  return { cards: 0, dots: n, cardW, cardH, font, ...d };
}
function boxFor(cards: number, dots: number, cardW: number, cardH: number) {
  const cols = cards ? Math.min(3, Math.max(1, Math.ceil(Math.sqrt(cards)))) : 0;
  const rows = cards ? Math.ceil(cards / cols) : 0;
  const cardsW = cols ? cols * cardW + (cols - 1) * GAP : 0;
  const cardsH = rows ? rows * cardH + (rows - 1) * GAP : 0;
  const innerW = Math.max(cardsW, 120);
  const dotCols = Math.max(1, Math.floor(innerW / (DOT + DOT_GAP)));
  const dotRows = dots ? Math.ceil(dots / dotCols) : 0;
  const dotsH = dotRows ? dotRows * (DOT + DOT_GAP) : 0;
  return { cols, rows, dotCols, w: innerW + PAD * 2, h: HEADER + cardsH + (cardsH && dotsH ? GAP : 0) + dotsH + PAD * 2 };
}

function syncClusters() {
  const list = jostle.clusterList;
  const ids = new Set(list.map((c) => c.id));
  cnodes = cnodes.filter((n) => ids.has(n.id));
  for (const c of list) {
    const d = clusterLayout(c.id);
    const ex = cnodes.find((n) => n.id === c.id);
    if (ex) { ex.w = d.w; ex.h = d.h; }
    else {
      // Spread new boxes across a grid (NOT stacked at centre) so rect-collision
      // has well-separated starting points to refine — stacking them confuses
      // the separation and leaves them overlapping.
      const idx = cnodes.length;
      const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
      const rows = Math.max(1, Math.ceil(list.length / cols));
      const x = ((idx % cols) + 0.5) / cols * dims.w;
      const y = TOP + ((Math.floor(idx / cols) + 0.5) / rows) * (dims.h - TOP - BOTTOM);
      cnodes.push({ id: c.id, w: d.w, h: d.h, x, y });
    }
  }
  csim?.nodes(cnodes);
  csim?.alpha(0.9).restart();
}
function rectCollide() {
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i < cnodes.length; i++) {
      for (let j = i + 1; j < cnodes.length; j++) {
        const a = cnodes[i], b = cnodes[j];
        const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
        const ox = (a.w + b.w) / 2 + 20 - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + 20 - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const p = (ox / 2) * (dx < 0 ? -1 : 1); a.x = (a.x ?? 0) - p; b.x = (b.x ?? 0) + p; }
          else { const p = (oy / 2) * (dy < 0 ? -1 : 1); a.y = (a.y ?? 0) - p; b.y = (b.y ?? 0) + p; }
        }
      }
    }
  }
}

onMounted(() => {
  if (stage.value) {
    const ro = new ResizeObserver(() => { dims.w = stage.value!.clientWidth; dims.h = stage.value!.clientHeight; });
    ro.observe(stage.value);
    onBeforeUnmount(() => ro.disconnect());
  }
  // No centering force — it just piled boxes up faster than collision could
  // separate them. Pure rectangular repulsion + viewport clamp lets the boxes
  // settle wherever they fit without overlapping.
  csim = forceSimulation<CNode>(cnodes)
    .force('rect', rectCollide)
    .on('tick', () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const n of cnodes) {
        n.x = Math.max(n.w / 2 + 8, Math.min(dims.w - n.w / 2 - 8, n.x ?? dims.w / 2));
        n.y = Math.max(TOP + n.h / 2, Math.min(dims.h - BOTTOM + 30 - n.h / 2, n.y ?? dims.h / 2));
        next[n.id] = { x: n.x, y: n.y };
      }
      clusterPos.value = next;
    });

  // No centering — pure collision repulsion + clamp lets statements push each
  // other around organically and fill the space.
  ssim = forceSimulation<SNode>(snodes)
    .force('collide', looseCollide)
    .on('tick', () => {
      const pos: Record<string, { x: number; y: number }> = {};
      const sz: Record<string, number> = {};
      const dt: Record<string, boolean> = {};
      for (const n of snodes) {
        const r = radiusOf(n);
        n.x = Math.max(r + 6, Math.min(dims.w - r - 6, n.x ?? dims.w / 2));
        n.y = Math.max(TOP + r, Math.min(dims.h - BOTTOM - r, n.y ?? dims.h / 2));
        // Pressure → size with a dead-zone. Crowded cards (high collision push)
        // shrink; once one drops below DOT_T it becomes a dot and frees room, so
        // its neighbours relax. The sim cools normally (no reheat) so it settles.
        if (n.push > 3) n.size = Math.max(MIN_SIZE, n.size - 0.04);
        else if (n.push < 0.8) n.size = Math.min(1, n.size + 0.02);
        // Hysteresis on the card↔dot switch so it doesn't flicker at the boundary.
        if (n.dot) { if (n.size > DOT_T + 0.14) n.dot = false; }
        else if (n.size < DOT_T) n.dot = true;
        pos[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
        sz[n.id] = n.size;
        dt[n.id] = n.dot;
      }
      loosePos.value = pos;
      looseSize.value = sz;
      looseDot.value = dt;
    });

  syncClusters();
  syncLoose();
});
onBeforeUnmount(() => { csim?.stop(); ssim?.stop(); });

watch([() => jostle.clusterList.map((c) => c.id + ':' + jostle.statementsOf(c.id).length).join(','), () => jostle.activeClusterId, () => dims.w + dims.h], syncClusters);

// ── render helpers ──────────────────────────────────────────────────────────
const activeCluster = computed(() => (jostle.activeClusterId ? jostle.clusters.get(jostle.activeClusterId) : null) ?? null);
const visibleClusters = computed(() => (jostle.activeClusterId ? jostle.clusterList.filter((c) => c.id === jostle.activeClusterId) : jostle.clusterList));
const idxOf = (id: string) => jostle.clusterList.findIndex((c) => c.id === id);

function clusterColor(i: number) {
  const hue = (i * 61) % 360;
  return { bg: `hsla(${hue}, 45%, 55%, 0.10)`, border: `hsla(${hue}, 45%, 62%, 0.45)` };
}
function clusterCenter(cid: string) {
  if (jostle.activeClusterId === cid) return { x: dims.w / 2, y: dims.h / 2 };
  return clusterPos.value[cid] ?? { x: dims.w / 2, y: dims.h / 2 };
}
function boxStyle(cid: string) {
  const c = clusterCenter(cid);
  const d = clusterLayout(cid);
  const col = clusterColor(idxOf(cid));
  return { left: c.x - d.w / 2 + 'px', top: c.y - d.h / 2 + 'px', width: d.w + 'px', height: d.h + 'px', background: col.bg, border: `1px solid ${col.border}` };
}

/** A clustered statement is a card (within its grid) or a dot (overflow). */
interface ClusterItem { s: { id: string; participant_id: string; text: string }; isDot: boolean; left: number; top: number; cardW: number; cardH: number; font: number }
function clusterItems(cid: string): ClusterItem[] {
  const list = jostle.statementsOf(cid) as { id: string; participant_id: string; text: string }[];
  const d = clusterLayout(cid);
  const c = clusterCenter(cid);
  const x0 = c.x - d.w / 2 + PAD, y0 = c.y - d.h / 2 + HEADER + PAD;
  const cw = d.cardW, ch = d.cardH;
  const out: ClusterItem[] = [];
  list.forEach((s, i) => {
    if (i < d.cards) {
      const col = i % d.cols, row = Math.floor(i / d.cols);
      out.push({ s, isDot: false, cardW: cw, cardH: ch, font: d.font, left: x0 + cw / 2 + col * (cw + GAP), top: y0 + ch / 2 + row * (ch + GAP) });
    } else {
      const di = i - d.cards;
      const rows = d.cards ? Math.ceil(d.cards / d.cols) : 0;
      const cardsH = rows ? rows * ch + (rows - 1) * GAP : 0;
      const dotsTop = y0 + cardsH + (cardsH ? GAP : 0);
      const col = di % d.dotCols, row = Math.floor(di / d.dotCols);
      out.push({ s, isDot: true, cardW: cw, cardH: ch, font: d.font, left: x0 + DOT / 2 + col * (DOT + DOT_GAP), top: dotsTop + DOT / 2 + row * (DOT + DOT_GAP) });
    }
  });
  return out;
}

const looseStatements = computed(() => jostle.visibleStatements.filter((s) => !s.cluster_id));
function looseChip(s: { id: string }) {
  const p = loosePos.value[s.id] ?? { x: dims.w / 2, y: dims.h / 2 };
  const sc = revealed.value.has(s.id) ? REVEAL : (looseSize.value[s.id] ?? 1);
  const dot = !revealed.value.has(s.id) && (looseDot.value[s.id] ?? false);
  return { dot, scale: sc, left: p.x, top: p.y };
}
function avatarSize(scale: number) { return Math.max(13, Math.round(20 * scale)); }
function author(participantId: string) { return participants.byId(participantId); }

// ── actions ────────────────────────────────────────────────────────────────
function submit() {
  if (!draft.value.trim() || !myParticipantId.value) return;
  jostle.addStatement(sessionId.value, myParticipantId.value, draft.value, jostle.activeClusterId ?? undefined);
  draft.value = '';
}
function deleteChip(id: string) { jostle.deleteStatement(id); }
const myReady = computed(() => !!(myParticipantId.value && participants.byId(myParticipantId.value)?.ready_flags?.jostle));
function toggleReady() { if (myParticipantId.value) participants.setReady(myParticipantId.value, 'jostle', !myReady.value); }
async function addBotStatements() {
  if (!participants.bots.length) return;
  addingBotStmts.value = true;
  try { await bots.addBotStatementsOnce(sessionId.value, drivingQuestion.value); } finally { addingBotStmts.value = false; }
}
function clusterNow() { jostle.runClustering(sessionId.value, drivingQuestion.value, minClusters.value); }
function openCluster(id: string) { jostle.activeClusterId = id; }
function closeCluster() { jostle.activeClusterId = null; }

// ── reconciliation popout ──────────────────────────────────────────────────
const recon = computed(() => reconciliation.active);
const reconPayload = computed(() => recon.value?.payload as { pad?: { toCount: number }; trim?: { toCount: number } } | undefined);
const myReconVote = computed<'up' | 'down' | null>(() => {
  const m = recon.value; const id = myParticipantId.value;
  if (!m || !id) return null;
  return m.up.includes(id) ? 'up' : m.down.includes(id) ? 'down' : null;
});
</script>

<template>
  <div class="jostle">
    <div class="layout" :class="{ 'panel-open': !!activeCluster }">
      <ClusterChatPanel
        v-if="activeCluster"
        :cluster="activeCluster"
        :messages="jostle.messagesByCluster.get(activeCluster.id) ?? []"
        :participants="participants.rows"
        :my-id="myParticipantId ?? ''"
        @close="closeCluster"
        @send="(t) => jostle.sendMessage(sessionId, activeCluster!.id, myParticipantId!, t)"
      />

      <div ref="stage" class="stage">
        <header class="dq">
          <span class="dq-label">Driving Question</span>
          <p>{{ drivingQuestion }}</p>
        </header>

        <div v-if="!activeCluster" class="actions">
          <button class="act" :disabled="addingBotStmts || !participants.bots.length" @click="addBotStatements">
            <img src="https://api.iconify.design/mdi/robot-outline.svg?color=%23cdd6f4" width="16" height="16" alt="" />
            {{ addingBotStmts ? 'Adding…' : 'Add bot statements' }}
          </button>
          <button class="act" :disabled="jostle.clustering || jostle.visibleStatements.length === 0" @click="clusterNow">
            {{ jostle.clustering ? 'Clustering…' : 'Cluster statements' }}
          </button>
          <button class="act ready" :class="{ on: myReady }" @click="toggleReady">{{ myReady ? '✓ Ready to Proceed' : 'Ready to Proceed' }}</button>
        </div>

        <!-- cluster boxes -->
        <template v-for="c in visibleClusters" :key="c.id">
          <div class="cluster-box" :style="boxStyle(c.id)">
            <div class="cluster-head">
              <span class="cluster-name">{{ c.name }}</span>
              <button class="cluster-chat" :title="'Open ' + c.name" @click="openCluster(c.id)">
                <img src="https://api.iconify.design/mdi/message-outline.svg?color=%23cdd6f4" width="14" height="14" alt="chat" />
                <span v-if="(jostle.messagesByCluster.get(c.id)?.length ?? 0) > 0" class="badge">{{ jostle.messagesByCluster.get(c.id)?.length }}</span>
              </button>
            </div>
          </div>
          <!-- clustered statement cards / dots -->
          <template v-for="it in clusterItems(c.id)" :key="it.s.id">
            <button v-if="it.isDot" class="stmt-dot" :style="{ left: it.left + 'px', top: it.top + 'px' }" :title="it.s.text" @click="openCluster(c.id)" />
            <div v-else class="chip" :style="{ left: it.left + 'px', top: it.top + 'px', width: it.cardW + 'px', height: it.cardH + 'px', fontSize: it.font + 'rem', zIndex: 3 }">
              <p class="chip-text">{{ it.s.text }}</p>
              <ParticipantAvatar class="chip-author" :id="it.s.participant_id" :name="author(it.s.participant_id)?.name ?? '?'" :avatar-url="author(it.s.participant_id)?.avatar_url" :is-bot="author(it.s.participant_id)?.is_bot" :size="avatarSize(it.cardW / CARD_W)" />
            </div>
          </template>
        </template>

        <!-- loose statement cards / dots (pressure-driven) -->
        <template v-for="s in looseStatements" :key="s.id">
          <template v-if="looseChip(s).dot">
            <button class="stmt-dot" :style="{ left: looseChip(s).left + 'px', top: looseChip(s).top + 'px' }" :title="s.text" @click="toggleReveal(s.id)" />
          </template>
          <div
            v-else
            class="chip"
            :class="{ revealed: revealed.has(s.id) }"
            :style="{ left: looseChip(s).left + 'px', top: looseChip(s).top + 'px', width: CARD_W * looseChip(s).scale + 'px', fontSize: 0.8 * looseChip(s).scale + 'rem', zIndex: revealed.has(s.id) ? 6 : 2 }"
            @click="revealed.has(s.id) && toggleReveal(s.id)"
          >
            <p class="chip-text">{{ s.text }}</p>
            <ParticipantAvatar class="chip-author" :id="s.participant_id" :name="author(s.participant_id)?.name ?? '?'" :avatar-url="author(s.participant_id)?.avatar_url" :is-bot="author(s.participant_id)?.is_bot" :size="avatarSize(looseChip(s).scale)" />
            <button v-if="s.participant_id === myParticipantId" class="trash" @click.stop="deleteChip(s.id)">🗑</button>
          </div>
        </template>

        <div class="input-bar">
          <input v-model="draft" :placeholder="activeCluster ? `Add a statement to “${activeCluster.name}”…` : 'Write a statement someone might disagree with…'" @keyup.enter="submit" />
          <button @click="submit">Post</button>
        </div>
      </div>
    </div>

    <RightPopoutVote
      v-if="recon"
      title="The headcount doesn't fit a Syntegrity shape. Choose how to reconcile:"
      :up-label="`Add bots → ${reconPayload?.pad?.toCount ?? '?'}`"
      :down-label="`Trim last joined → ${reconPayload?.trim?.toCount ?? '?'}`"
      :up-count="recon.up.length"
      :down-count="recon.down.length"
      :expires-at="recon.expires_at"
      :my-vote="myReconVote"
      @up="myParticipantId && reconciliation.vote(myParticipantId, 'up')"
      @down="myParticipantId && reconciliation.vote(myParticipantId, 'down')"
      @extend="reconciliation.extend()"
    />
  </div>
</template>

<style scoped>
.jostle { position: relative; height: 100vh; background: radial-gradient(circle at 50% 50%, #141a2c, #0b0e16); color: #e6ecff; overflow: hidden; }
.layout { display: grid; grid-template-columns: 1fr; height: 100%; }
.layout.panel-open { grid-template-columns: 340px 1fr; }
.stage { position: relative; overflow: hidden; }

.dq { position: absolute; top: 0.9rem; left: 50%; transform: translateX(-50%); text-align: center; z-index: 40; pointer-events: none; }
.dq-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; color: #7aa2ff; }
.dq p { margin: 0.25rem 0 0; font-size: 1.25rem; font-weight: 600; max-width: 50vw; }

.actions { position: absolute; bottom: 1rem; right: 1rem; z-index: 40; display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem; }
.act { display: inline-flex; align-items: center; gap: 0.4rem; background: #1b2236; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 9px; padding: 0.45rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer; }
.act:hover:not(:disabled) { border-color: #4f7cff; }
.act:disabled { opacity: 0.45; cursor: default; }
.act.ready { background: #2a7a44; border-color: #2a7a44; color: #fff; }
.act.ready:hover:not(:disabled) { background: #2f8a4d; border-color: #2f8a4d; }
.act.ready.on { background: #1f5e34; border-color: #1f5e34; }

.cluster-box { position: absolute; border-radius: 14px; z-index: 1; }
.cluster-head { display: flex; align-items: center; gap: 0.4rem; height: 26px; padding: 0 0.55rem; }
.cluster-name { font-size: 0.8rem; font-weight: 600; color: #e6ecff; opacity: 0.92; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cluster-chat { position: relative; display: inline-flex; align-items: center; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; padding: 0.15rem 0.3rem; cursor: pointer; flex: none; }
.cluster-chat:hover { border-color: #4f7cff; }
.badge { position: absolute; top: -7px; right: -8px; background: #e06c75; color: #fff; border-radius: 999px; font-size: 0.55rem; padding: 0 4px; }

.chip { position: absolute; transform: translate(-50%, -50%); background: #1b2236; border: 1px solid #2a3350; padding: 0.4rem 0.5rem; border-radius: 10px; box-sizing: border-box; font-size: 0.8rem; display: flex; flex-direction: column; gap: 2px; overflow: hidden; transition: width 0.18s ease, height 0.18s ease, font-size 0.18s ease; }
.chip-text { margin: 0; line-height: 1.25; overflow: hidden; }
.chip-author { align-self: flex-end; }
.chip.revealed { z-index: 6; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,.55); overflow: visible; }
.trash { position: absolute; top: -9px; right: -9px; background: #e06c75; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 0.7rem; cursor: pointer; display: none; }
.chip:hover .trash { display: block; }

.stmt-dot { position: absolute; transform: translate(-50%, -50%); z-index: 4; width: 18px; height: 18px; border-radius: 50%; background: #1b2236; border: 1px solid #3a4768; cursor: pointer; padding: 0; transition: background 0.12s, border-color 0.12s; }
.stmt-dot:hover { background: #28324d; border-color: #7aa2ff; }

.input-bar { position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%); display: flex; gap: 0.5rem; width: min(560px, 80%); z-index: 50; }
.input-bar input { flex: 1; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
.input-bar button { background: #4f7cff; border: none; color: #fff; border-radius: 10px; padding: 0 1.2rem; cursor: pointer; }
</style>
