<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { forceCollide, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';
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

// base (unscaled) sizes — tight padding to waste less space
const CARD_W = 180;
const CARD_H = 58;
const GAP = 10;
const PAD = 10;
const HEADER = 26;
const TOP = 120; // clear of DQ/toolbar
const BOTTOM = 90; // clear of input bar

const shapeName = computed<ShapeName>(
  () => session.session?.locked_shape ?? encodedShapeForHeadcount(participants.active.length),
);
const minClusters = computed(() => getShape(shapeName.value).topicCount);

function colsRows(n: number) {
  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n)))));
  return { cols, rows: Math.ceil(Math.max(1, n) / cols) };
}
function naturalBox(n: number) {
  const { cols, rows } = colsRows(n);
  return { w: cols * CARD_W + (cols - 1) * GAP + PAD * 2, h: HEADER + rows * CARD_H + (rows - 1) * GAP + PAD * 2 };
}

/** Shrink everything uniformly when the boxes can't fit the viewport. */
const layoutScale = computed(() => {
  if (jostle.activeClusterId) return 1;
  const list = jostle.clusterList;
  if (!list.length) return 1;
  const avail = Math.max(1, (dims.w - 40) * (dims.h - TOP - BOTTOM));
  let need = 0;
  for (const c of list) { const d = naturalBox(jostle.statementsOf(c.id).length); need += d.w * d.h; }
  return Math.max(0.5, Math.min(1, Math.sqrt(avail / (need * 1.5))));
});

function box(n: number) {
  const s = layoutScale.value;
  const { cols, rows } = colsRows(n);
  const cw = CARD_W * s, ch = CARD_H * s, gap = GAP * s, pad = PAD * s, hdr = HEADER * s;
  return { cols, rows, cw, ch, gap, pad, hdr, w: cols * cw + (cols - 1) * gap + pad * 2, h: hdr + rows * ch + (rows - 1) * gap + pad * 2 };
}

// ── cluster boxes: physics + rect collision + viewport clamp ───────────────
interface CNode extends SimulationNodeDatum { id: string; w: number; h: number }
let cnodes: CNode[] = [];
let csim: Simulation<CNode, undefined> | null = null;
const clusterPos = ref<Record<string, { x: number; y: number }>>({});

function syncClusters() {
  const list = jostle.clusterList;
  const ids = new Set(list.map((c) => c.id));
  cnodes = cnodes.filter((n) => ids.has(n.id));
  for (const c of list) {
    const d = box(jostle.statementsOf(c.id).length);
    const ex = cnodes.find((n) => n.id === c.id);
    if (ex) { ex.w = d.w; ex.h = d.h; }
    else cnodes.push({ id: c.id, w: d.w, h: d.h, x: dims.w / 2 + (Math.random() - 0.5) * 250, y: dims.h / 2 + (Math.random() - 0.5) * 150 });
  }
  csim?.nodes(cnodes);
  csim?.alpha(0.7).restart();
}
// Hard rectangular separation: push overlapping boxes fully apart along their
// axis of least overlap (not alpha-scaled), run a few iterations for stability.
function rectCollide() {
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < cnodes.length; i++) {
      for (let j = i + 1; j < cnodes.length; j++) {
        const a = cnodes[i], b = cnodes[j];
        const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
        const ox = (a.w + b.w) / 2 + 16 - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + 16 - Math.abs(dy);
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
  csim = forceSimulation<CNode>(cnodes)
    .force('x', forceX<CNode>(() => dims.w / 2).strength(0.02))
    .force('y', forceY<CNode>(() => dims.h / 2).strength(0.02))
    .force('rect', rectCollide)
    .alphaTarget(0.06)
    .on('tick', () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const n of cnodes) {
        // clamp so the WHOLE box stays inside the viewport
        n.x = Math.max(n.w / 2 + 8, Math.min(dims.w - n.w / 2 - 8, n.x ?? dims.w / 2));
        n.y = Math.max(TOP + n.h / 2, Math.min(dims.h - BOTTOM + 30 - n.h / 2, n.y ?? dims.h / 2));
        next[n.id] = { x: n.x, y: n.y };
      }
      clusterPos.value = next;
    });

  // loose statements: free physics, collision, clamp
  ssim = forceSimulation<SNode>(snodes)
    .force('collide', forceCollide<SNode>(CARD_W / 2 + 12))
    .force('x', forceX<SNode>(() => dims.w / 2).strength(0.05))
    .force('y', forceY<SNode>(() => dims.h / 2).strength(0.06))
    .alphaTarget(0.05)
    .on('tick', () => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const n of snodes) {
        n.x = Math.max(CARD_W / 2 + 10, Math.min(dims.w - CARD_W / 2 - 10, n.x ?? dims.w / 2));
        n.y = Math.max(TOP + CARD_H / 2, Math.min(dims.h - BOTTOM - CARD_H / 2, n.y ?? dims.h / 2));
        next[n.id] = { x: n.x, y: n.y };
      }
      loosePos.value = next;
    });

  syncClusters();
  syncLoose();
});
onBeforeUnmount(() => { csim?.stop(); ssim?.stop(); });

watch([() => jostle.clusterList.map((c) => c.id + ':' + jostle.statementsOf(c.id).length).join(','), layoutScale], syncClusters);

// ── loose statements physics ───────────────────────────────────────────────
interface SNode extends SimulationNodeDatum { id: string }
let snodes: SNode[] = [];
let ssim: Simulation<SNode, undefined> | null = null;
const loosePos = ref<Record<string, { x: number; y: number }>>({});
function syncLoose() {
  const loose = jostle.visibleStatements.filter((s) => !s.cluster_id);
  const ids = new Set(loose.map((s) => s.id));
  snodes = snodes.filter((n) => ids.has(n.id));
  const have = new Set(snodes.map((n) => n.id));
  for (const s of loose) if (!have.has(s.id)) snodes.push({ id: s.id, x: dims.w / 2 + (Math.random() - 0.5) * 300, y: dims.h / 2 + (Math.random() - 0.5) * 200 });
  ssim?.nodes(snodes);
  ssim?.alpha(0.5).restart();
}
watch(() => jostle.visibleStatements.map((s) => s.id + (s.cluster_id ?? '')).join(','), syncLoose);

// ── positions / styles ─────────────────────────────────────────────────────
const activeCluster = computed(() => (jostle.activeClusterId ? jostle.clusters.get(jostle.activeClusterId) : null) ?? null);
const visibleClusters = computed(() => (jostle.activeClusterId ? jostle.clusterList.filter((c) => c.id === jostle.activeClusterId) : jostle.clusterList));
const renderStatements = computed(() => (jostle.activeClusterId ? jostle.statementsOf(jostle.activeClusterId) : jostle.visibleStatements));
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
  const d = box(jostle.statementsOf(cid).length);
  const col = clusterColor(idxOf(cid));
  return { left: c.x - d.w / 2 + 'px', top: c.y - d.h / 2 + 'px', width: d.w + 'px', height: d.h + 'px', background: col.bg, border: `1px solid ${col.border}`, '--hdr': d.hdr + 'px', '--fs': 0.78 * layoutScale.value + 'rem' };
}
function chipStyle(s: { id: string; cluster_id: string | null }) {
  if (!s.cluster_id) {
    const p = loosePos.value[s.id] ?? { x: dims.w / 2, y: dims.h / 2 };
    return { left: p.x + 'px', top: p.y + 'px', width: CARD_W + 'px', fontSize: '0.8rem' };
  }
  const list = jostle.statementsOf(s.cluster_id);
  const idx = list.findIndex((x) => x.id === s.id);
  const d = box(list.length);
  const c = clusterCenter(s.cluster_id);
  const col = idx % d.cols, row = Math.floor(idx / d.cols);
  return {
    left: c.x - d.w / 2 + d.pad + d.cw / 2 + col * (d.cw + d.gap) + 'px',
    top: c.y - d.h / 2 + d.hdr + d.pad + d.ch / 2 + row * (d.ch + d.gap) + 'px',
    width: d.cw + 'px',
    height: d.ch + 'px',
    fontSize: 0.8 * layoutScale.value + 'rem',
  };
}
function avatarSize(s: { cluster_id: string | null }) {
  return s.cluster_id ? Math.max(14, Math.round(18 * layoutScale.value)) : 20;
}
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

        <div class="actions">
          <button class="act" :disabled="addingBotStmts || !participants.bots.length" @click="addBotStatements">
            <img src="https://api.iconify.design/mdi/robot-outline.svg?color=%23cdd6f4" width="16" height="16" alt="" />
            {{ addingBotStmts ? 'Adding…' : 'Add bot statements' }}
          </button>
          <button class="act" :disabled="jostle.clustering || jostle.visibleStatements.length === 0" @click="clusterNow">
            {{ jostle.clustering ? 'Clustering…' : 'Cluster statements' }}
          </button>
          <button class="act ready" :class="{ on: myReady }" @click="toggleReady">{{ myReady ? '✓ Ready to vote' : 'Ready to vote' }}</button>
        </div>

        <!-- cluster boxes (float with physics, clamped + non-overlapping) -->
        <div v-for="c in visibleClusters" :key="c.id" class="cluster-box" :style="boxStyle(c.id)">
          <div class="cluster-head">
            <span class="cluster-name">{{ c.name }}</span>
            <button class="cluster-chat" :title="'Open ' + c.name" @click="openCluster(c.id)">
              <img src="https://api.iconify.design/mdi/message-outline.svg?color=%23cdd6f4" width="14" height="14" alt="chat" />
              <span v-if="(jostle.messagesByCluster.get(c.id)?.length ?? 0) > 0" class="badge">{{ jostle.messagesByCluster.get(c.id)?.length }}</span>
            </button>
          </div>
        </div>

        <!-- statement cards -->
        <div v-for="s in renderStatements" :key="s.id" class="chip" :class="{ boxed: !!s.cluster_id }" :style="chipStyle(s)">
          <p class="chip-text">{{ s.text }}</p>
          <ParticipantAvatar
            class="chip-author"
            :id="s.participant_id"
            :name="author(s.participant_id)?.name ?? '?'"
            :avatar-url="author(s.participant_id)?.avatar_url"
            :is-bot="author(s.participant_id)?.is_bot"
            :size="avatarSize(s)"
          />
          <button v-if="s.participant_id === myParticipantId" class="trash" @click="deleteChip(s.id)">🗑</button>
        </div>

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

.actions { position: absolute; top: 0.9rem; right: 1rem; z-index: 40; display: flex; gap: 0.5rem; }
.act { display: inline-flex; align-items: center; gap: 0.4rem; background: #1b2236; border: 1px solid #2a3350; color: #cdd6f4; border-radius: 9px; padding: 0.45rem 0.7rem; font: inherit; font-size: 0.82rem; cursor: pointer; }
.act:hover:not(:disabled) { border-color: #4f7cff; }
.act:disabled { opacity: 0.45; cursor: default; }
.act.ready.on { background: #2a7a44; border-color: #2a7a44; color: #fff; }

.cluster-box { position: absolute; border-radius: 14px; z-index: 1; }
.cluster-head { display: flex; align-items: center; gap: 0.4rem; height: var(--hdr, 26px); padding: 0 0.55rem; }
.cluster-name { font-size: var(--fs, 0.78rem); font-weight: 600; color: #e6ecff; opacity: 0.92; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cluster-chat { position: relative; display: inline-flex; align-items: center; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; padding: 0.15rem 0.3rem; cursor: pointer; flex: none; }
.cluster-chat:hover { border-color: #4f7cff; }
.badge { position: absolute; top: -7px; right: -8px; background: #e06c75; color: #fff; border-radius: 999px; font-size: 0.55rem; padding: 0 4px; }

.chip { position: absolute; transform: translate(-50%, -50%); z-index: 2; background: #1b2236; border: 1px solid #2a3350; padding: 0.4rem 0.5rem; border-radius: 10px; box-sizing: border-box; font-size: 0.8rem; display: flex; flex-direction: column; gap: 2px; }
.chip.boxed { overflow: hidden; }
.chip-text { margin: 0; line-height: 1.25; overflow: hidden; }
.chip-author { align-self: flex-end; }
.trash { position: absolute; top: -9px; right: -9px; background: #e06c75; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 0.7rem; cursor: pointer; display: none; }
.chip:hover .trash { display: block; }

.input-bar { position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%); display: flex; gap: 0.5rem; width: min(560px, 80%); z-index: 50; }
.input-bar input { flex: 1; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
.input-bar button { background: #4f7cff; border: none; color: #fff; border-radius: 10px; padding: 0 1.2rem; cursor: pointer; }
</style>
