<script setup lang="ts">
/**
 * /scheduled/:code — invite + commitment page for a session that hasn't
 * started yet.
 *
 * Three modes:
 *   - host view (no token): shows the invite link + N empty "commit" slots
 *   - committed visitor (?token=…): same UI but their slot is highlighted with
 *     a "Remove me" button. From T−10min the page promotes the session to
 *     'live', claims their participant identity in localStorage, and routes to
 *     the existing lobby.
 *   - full / not found / past start: dedicated messages.
 *
 * Creator-only edits: the user who created this scheduled session is granted
 * a creator_token (returned at create time, also passed back via ?owner=…).
 * That token lets them edit the driving question inline; everyone else sees
 * the read-only DQ pinned at the top of the page.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useScheduleStore, LOBBY_OPEN_OFFSET_MS } from '@/stores/schedule';
import { supabase } from '@/services/supabase';
import { getShape, type ShapeName } from '@/util';
import PolyhedronScene, { type SceneNode } from '@/components/PolyhedronScene.vue';
import ParticipantAvatar from '@/components/ParticipantAvatar.vue';

const props = defineProps<{ code: string }>();
const route = useRoute();
const router = useRouter();
const schedule = useScheduleStore();
const { session, commitments, isFull, capacity } = storeToRefs(schedule);

const state = ref<'loading' | 'ready' | 'notfound' | 'promoting'>('loading');
const error = ref('');
const showCommitModal = ref(false);
const copied = ref(false);
const tickNow = ref(Date.now());

let tickTimer: ReturnType<typeof setInterval> | null = null;

const myToken = computed(() => (route.query.token as string | undefined) ?? null);
const myCommitment = computed(() =>
  myToken.value ? schedule.findByToken(myToken.value) : undefined,
);

// ── Creator-token (owner) handling ───────────────────────────────────
// Order of precedence:
//   1. ?owner=… in the URL (just-after-create or shared owner link)
//   2. localStorage backup written either at create time or by this view
// We promote a URL token to localStorage so the owner can edit on revisits
// even if they drop the query string.
const ownerToken = computed<string | null>(() => {
  const fromUrl = (route.query.owner as string | undefined) ?? null;
  if (fromUrl) return fromUrl;
  return schedule.getStoredCreatorToken(props.code);
});

const isCreator = computed(() =>
  !!session.value?.creator_token &&
  !!ownerToken.value &&
  session.value.creator_token === ownerToken.value,
);

// If we arrived with ?owner=… and it actually matches the loaded session,
// stash it locally so future visits keep the edit affordance.
watch(
  [() => session.value?.creator_token, ownerToken],
  ([creator, owner]) => {
    if (creator && owner && creator === owner) {
      schedule.rememberCreatorToken(props.code, owner);
    }
  },
);

const startMs = computed(() =>
  session.value?.scheduled_start_at ? Date.parse(session.value.scheduled_start_at) : 0,
);
const msUntilStart = computed(() => startMs.value - tickNow.value);
const msUntilLobbyOpen = computed(() => startMs.value - LOBBY_OPEN_OFFSET_MS - tickNow.value);
const lobbyOpen = computed(() => msUntilLobbyOpen.value <= 0);

const shapeName = computed<ShapeName | null>(() => session.value?.locked_shape ?? null);
const shapeInfo = computed(() => (shapeName.value ? getShape(shapeName.value) : null));

const inviteLink = computed(() =>
  session.value ? `${window.location.origin}/scheduled/${session.value.code}` : '',
);

const edgeNodes = computed<(SceneNode | null)[]>(() => {
  const cap = capacity.value;
  if (!cap) return [];
  return Array.from({ length: cap }, (_, i) => {
    const c = commitments.value[i];
    return c
      ? { id: c.id, name: c.name || 'Anon', avatarUrl: c.avatar_url, isBot: false }
      : null;
  });
});

const placeholderTopics = computed(() => {
  const t = shapeInfo.value?.topicCount ?? 0;
  return Array.from({ length: t }, (_, i) => `Topic ${i + 1}`);
});

// ── Time formatting ──────────────────────────────────────────────────
const viewerTz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
})();

function fmtInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

const hostTzLine = computed(() => {
  if (!session.value?.scheduled_start_at || !session.value.scheduled_timezone) return '';
  return fmtInTz(new Date(session.value.scheduled_start_at), session.value.scheduled_timezone);
});
const viewerTzLine = computed(() => {
  if (!session.value?.scheduled_start_at) return '';
  if (viewerTz === session.value.scheduled_timezone) return '';
  return fmtInTz(new Date(session.value.scheduled_start_at), viewerTz);
});

// ── Countdown ────────────────────────────────────────────────────────
interface CountdownParts { days: number; hours: number; minutes: number; seconds: number; past: boolean; }
const countdown = computed<CountdownParts>(() => {
  let ms = msUntilStart.value;
  const past = ms <= 0;
  ms = Math.abs(ms);
  const days = Math.floor(ms / 86_400_000);
  ms -= days * 86_400_000;
  const hours = Math.floor(ms / 3_600_000);
  ms -= hours * 3_600_000;
  const minutes = Math.floor(ms / 60_000);
  ms -= minutes * 60_000;
  const seconds = Math.floor(ms / 1000);
  return { days, hours, minutes, seconds, past };
});

const countdownLabel = computed(() => {
  const c = countdown.value;
  if (c.past) return 'Session has started';
  if (c.days > 0) return 'Session starts in';
  if (c.hours > 0) return 'Session starts in';
  if (c.minutes >= 10) return 'Session starts in';
  return 'Starting soon —';
});

// ── Lifecycle ────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    await schedule.loadByCode(props.code);
    if (!session.value) { state.value = 'notfound'; return; }
    state.value = 'ready';
    tickTimer = setInterval(() => { tickNow.value = Date.now(); void maybePromote(); }, 1_000);
    await maybePromote();
  } catch {
    state.value = 'notfound';
  }
});
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  void schedule.unsubscribe();
});

async function maybePromote(): Promise<void> {
  if (!session.value || !lobbyOpen.value || !myCommitment.value) return;
  if (state.value === 'promoting') return;
  state.value = 'promoting';
  try {
    await schedule.promoteToLive(session.value.id);
    // Re-read the commitment after promotion so participant_id is filled.
    const { data } = await supabase
      .from('scheduled_commitments')
      .select('*')
      .eq('id', myCommitment.value.id)
      .maybeSingle();
    const pid = (data as { participant_id?: string } | null)?.participant_id;
    if (pid) schedule.claimLocalIdentity(session.value.id, pid);
    await router.replace({ name: 'session', params: { sessionId: session.value.id } });
  } catch (e) {
    state.value = 'ready';
    error.value = (e as Error).message;
  }
}

// ── Driving question editing (creator only) ──────────────────────────
const editingDq = ref(false);
const dqDraft = ref('');
const dqSaving = ref(false);
const dqError = ref('');

function startEditDq(): void {
  if (!isCreator.value || !session.value) return;
  dqDraft.value = session.value.driving_question;
  dqError.value = '';
  editingDq.value = true;
}
function cancelEditDq(): void {
  editingDq.value = false;
  dqError.value = '';
}
async function saveDq(): Promise<void> {
  if (!ownerToken.value) return;
  const next = dqDraft.value.trim();
  if (!next) { dqError.value = 'Driving question cannot be empty'; return; }
  dqSaving.value = true; dqError.value = '';
  try {
    await schedule.updateDrivingQuestion(ownerToken.value, next);
    editingDq.value = false;
  } catch (e) {
    dqError.value = (e as Error).message;
  } finally {
    dqSaving.value = false;
  }
}

// ── Commit modal ─────────────────────────────────────────────────────
const cName = ref('');
const cEmail = ref('');
const cDiscord = ref('');
const cAvatarUrl = ref<string | null>(null);
const commitBusy = ref(false);
const commitError = ref('');
const commitDone = ref(false);

async function onAvatarFile(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || !session.value) return;
  commitBusy.value = true; commitError.value = '';
  try {
    const path = `scheduled/${session.value.id}/${crypto.randomUUID()}-${Date.now()}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
    if (upErr) throw upErr;
    cAvatarUrl.value = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  } catch {
    commitError.value = 'Image upload failed — you can continue without one.';
  } finally {
    commitBusy.value = false;
  }
}

async function submitCommit(): Promise<void> {
  if (!cName.value.trim() || !cEmail.value.trim()) return;
  commitBusy.value = true; commitError.value = '';
  try {
    await schedule.commit({
      email: cEmail.value.trim(),
      name: cName.value.trim(),
      avatarUrl: cAvatarUrl.value,
      discordHandle: cDiscord.value.trim() || null,
    });
    commitDone.value = true;
  } catch (e) {
    commitError.value = (e as Error).message;
  } finally {
    commitBusy.value = false;
  }
}

function openCommit(): void {
  if (isFull.value) return;
  showCommitModal.value = true;
  cName.value = ''; cEmail.value = ''; cDiscord.value = ''; cAvatarUrl.value = null;
  commitError.value = ''; commitDone.value = false;
}
function closeCommit(): void {
  showCommitModal.value = false;
}

async function removeMe(): Promise<void> {
  if (!myCommitment.value) return;
  await schedule.uncommit(myCommitment.value.id);
  await router.replace({ name: 'initiate' });
}

function copyLink(): void {
  if (!inviteLink.value) return;
  navigator.clipboard?.writeText(inviteLink.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <main class="scheduled">
    <div v-if="state === 'loading' || state === 'promoting'" class="center-msg">
      <p>{{ state === 'promoting' ? 'Joining the lobby…' : 'Loading…' }}</p>
    </div>

    <div v-else-if="state === 'notfound'" class="center-msg">
      <h1>Scheduled session not found</h1>
      <p>Check the link and try again.</p>
    </div>

    <div v-else-if="isFull && !myCommitment" class="center-msg">
      <h1>Sorry, this Syntegrity session is full</h1>
      <p>All {{ capacity }} spots have been committed.</p>
    </div>

    <div v-else class="layout">
      <!-- Sticky driving question — pinned at top while scrolling. -->
      <header class="dq" :class="{ editing: editingDq }">
        <p class="dq-label">Driving Question</p>

        <div v-if="!editingDq" class="dq-readonly">
          <h1 class="dq-text">{{ session?.driving_question }}</h1>
          <button v-if="isCreator" class="dq-edit" type="button" @click="startEditDq" aria-label="Edit driving question" title="Edit driving question">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
        </div>

        <div v-else class="dq-editor">
          <textarea v-model="dqDraft" rows="3" class="dq-textarea" placeholder="What single question does this group need to think through together?" />
          <p v-if="dqError" class="error">{{ dqError }}</p>
          <div class="dq-editor-row">
            <button class="ghost" type="button" :disabled="dqSaving" @click="cancelEditDq">Cancel</button>
            <button class="primary" type="button" :disabled="dqSaving || !dqDraft.trim()" @click="saveDq">
              {{ dqSaving ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </header>

      <section class="when">
        <p class="when-lede">This Syntegrity session is scheduled for</p>
        <p class="when-host">{{ hostTzLine }}</p>
        <p v-if="viewerTzLine" class="when-viewer">your local time: {{ viewerTzLine }}</p>
        <p v-if="!lobbyOpen" class="when-countdown">
          Lobby opens 10 minutes before the start time.
        </p>
        <p v-else class="when-countdown live">The lobby is open — joining now…</p>
      </section>

      <section class="invite">
        <label class="lbl">Invite link</label>
        <div class="invite-row">
          <input :value="inviteLink" readonly />
          <button class="ghost" @click="copyLink">{{ copied ? 'Copied!' : 'Copy' }}</button>
        </div>
      </section>

      <section class="stage">
        <PolyhedronScene
          :shape-name="shapeName"
          :edge-nodes="edgeNodes"
          :vertex-labels="placeholderTopics"
          :rotate="true"
        />
      </section>

      <!-- Live countdown under the graph. -->
      <section class="countdown" :class="{ past: countdown.past }">
        <p class="countdown-label">{{ countdownLabel }}</p>
        <div class="countdown-grid" v-if="!countdown.past">
          <div v-if="countdown.days > 0" class="cd-cell">
            <span class="cd-n">{{ countdown.days }}</span><span class="cd-u">day{{ countdown.days === 1 ? '' : 's' }}</span>
          </div>
          <div v-if="countdown.days > 0 || countdown.hours > 0" class="cd-cell">
            <span class="cd-n">{{ countdown.hours }}</span><span class="cd-u">hr{{ countdown.hours === 1 ? '' : 's' }}</span>
          </div>
          <div class="cd-cell">
            <span class="cd-n">{{ countdown.minutes }}</span><span class="cd-u">min{{ countdown.minutes === 1 ? '' : 's' }}</span>
          </div>
          <div class="cd-cell">
            <span class="cd-n">{{ countdown.seconds }}</span><span class="cd-u">sec</span>
          </div>
        </div>
      </section>

      <section class="slots">
        <h2>{{ commitments.length }} / {{ capacity }} participants signed up for this session</h2>
        <div class="slot-grid">
          <template v-for="(c, i) in edgeNodes" :key="i">
            <div v-if="c" class="slot filled" :class="{ mine: myCommitment?.id === c.id }">
              <ParticipantAvatar :id="c.id" :name="c.name" :avatar-url="c.avatarUrl" :size="40" />
              <span class="slot-name">{{ c.name }}</span>
              <button v-if="myCommitment?.id === c.id" class="slot-remove" @click="removeMe">Remove me</button>
            </div>
            <button v-else class="slot empty" @click="openCommit">
              <ParticipantAvatar :id="`empty-${i}`" name="?" :avatar-url="null" :size="36" />
              <span class="slot-empty-text">Join this session</span>
            </button>
          </template>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </section>
    </div>

    <!-- Commit modal — styled to mirror the pre-lobby ProfileForm UI. -->
    <div v-if="showCommitModal" class="modal" @click.self="closeCommit">
      <div class="modal-inner">
        <div v-if="!commitDone" class="profile-form">
          <h3>Join this session</h3>
          <p class="modal-sub">We'll email you a calendar invite. The link in the email lets you manage your spot or join when the lobby opens (10 min before start).</p>
          <div class="avatar-row">
            <ParticipantAvatar :id="'preview'" :name="cName || '?'" :avatar-url="cAvatarUrl" :size="72" />
            <label class="upload">
              <input type="file" accept="image/*" @change="onAvatarFile" hidden />
              <span>Upload image</span>
            </label>
          </div>
          <label class="lbl">Name</label>
          <input v-model="cName" placeholder="Your name" />
          <label class="lbl">Email</label>
          <input v-model="cEmail" type="email" placeholder="you@example.com" />
          <label class="lbl">Discord handle <span class="opt">(optional)</span></label>
          <input v-model="cDiscord" placeholder="@handle" />
          <p v-if="commitError" class="error">{{ commitError }}</p>
          <div class="modal-row">
            <button class="ghost" @click="closeCommit">Cancel</button>
            <button class="primary" :disabled="commitBusy || !cName.trim() || !cEmail.trim()" @click="submitCommit">
              {{ commitBusy ? 'Saving…' : 'Sign me up' }}
            </button>
          </div>
        </div>
        <div v-else>
          <h3>Calendar invite sent</h3>
          <p>A calendar invite for this Syntegrity session has been sent to <strong>{{ cEmail }}</strong>. Use the link in that email to manage your spot or join when the session opens.</p>
          <div class="modal-row">
            <button class="primary" @click="closeCommit">Done</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.scheduled { min-height: 100vh; background: radial-gradient(circle at 50% 0%, #1a2138, #0b0e16); color: #e6ecff; padding: 2rem 1rem 4rem; }
.center-msg { min-height: 70vh; display: grid; place-items: center; text-align: center; gap: 0.4rem; }

.layout { width: min(960px, 96vw); margin: 0 auto; display: grid; gap: 1.75rem; }

/* ── Sticky driving question ────────────────────────────────── */
.dq {
  position: sticky; top: 0; z-index: 50;
  margin: -2rem -1rem 0;
  padding: 1.1rem 1rem 1rem;
  text-align: center;
  background: rgba(11, 14, 22, 0.82);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid #1a2138;
}
.dq.editing { background: rgba(11, 14, 22, 0.95); }
.dq-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #9fb0d8; margin: 0 0 0.35rem; }
.dq-readonly { display: inline-flex; align-items: flex-start; gap: 0.6rem; max-width: min(800px, 92vw); }
.dq-text { font-size: 1.45rem; font-weight: 600; margin: 0; line-height: 1.3; }
.dq-edit { background: transparent; border: 1px solid transparent; color: #7aa2ff; padding: 0.25rem; border-radius: 8px; cursor: pointer; flex: none; display: inline-flex; margin-top: 0.15rem; }
.dq-edit:hover { background: rgba(79,124,255,0.12); border-color: #2a3350; }
.dq-edit svg { display: block; }

.dq-editor { max-width: min(800px, 92vw); margin: 0 auto; display: grid; gap: 0.5rem; text-align: left; }
.dq-textarea { width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; background: #0a0d18; border: 1px solid #4f7cff; color: #e6ecff; border-radius: 10px; font: inherit; font-size: 1.05rem; line-height: 1.45; resize: vertical; min-height: 4.2rem; }
.dq-textarea:focus { outline: none; box-shadow: 0 0 0 1px rgba(79,124,255,0.4); }
.dq-editor-row { display: flex; justify-content: flex-end; gap: 0.5rem; }

/* ── "Scheduled for" block ──────────────────────────────────── */
.when { text-align: center; }
.when-lede { color: #9fb0d8; font-size: 0.95rem; margin: 0 0 0.25rem; }
.when-host { font-size: 1.15rem; margin: 0; color: #e6ecff; font-weight: 500; }
.when-viewer { color: #9fb0d8; font-size: 0.9rem; margin: 0.2rem 0 0; }
.when-countdown { color: #6f7c98; font-size: 0.85rem; margin: 0.6rem 0 0; }
.when-countdown.live { color: #8be8a8; }

.invite { display: grid; gap: 0.4rem; }
.lbl { display: inline-block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0d8; margin-bottom: 0.1rem; }
.invite-row { display: flex; gap: 0.5rem; }
input, textarea { background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
.invite-row input { flex: 1; }
button { font: inherit; border-radius: 10px; padding: 0.7rem 1.2rem; cursor: pointer; border: 1px solid transparent; }
.primary { background: #4f7cff; color: #fff; }
.primary:disabled { opacity: 0.5; cursor: default; }
.ghost { background: transparent; border-color: #2a3350; color: #cdd6f4; }

.stage { height: clamp(320px, 50vh, 520px); background: #0c0f18; border: 1px solid #1a2138; border-radius: 12px; overflow: hidden; }

/* ── Countdown ──────────────────────────────────────────────── */
.countdown { text-align: center; display: grid; gap: 0.5rem; }
.countdown-label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: #9fb0d8; margin: 0; }
.countdown.past .countdown-label { color: #8be8a8; }
.countdown-grid { display: inline-flex; justify-content: center; gap: 0.9rem; flex-wrap: wrap; margin: 0 auto; }
.cd-cell { background: #11162a; border: 1px solid #2a3350; border-radius: 10px; padding: 0.55rem 0.9rem; min-width: 72px; display: grid; gap: 0.1rem; }
.cd-n { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.6rem; font-weight: 600; color: #e6ecff; line-height: 1; font-variant-numeric: tabular-nums; }
.cd-u { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6f7c98; }

/* ── Slots ──────────────────────────────────────────────────── */
.slots h2 { margin: 0 0 0.8rem; font-size: 1rem; font-weight: 600; color: #cdd6f4; }
.slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem; }
.slot { background: #11162a; border: 1px solid #2a3350; border-radius: 10px; padding: 0.55rem 0.8rem; display: flex; align-items: center; gap: 0.6rem; min-height: 56px; }
.slot.filled { color: #e6ecff; }
.slot.filled.mine { border-color: #4f7cff; box-shadow: 0 0 0 1px rgba(79,124,255,0.3); }
.slot-name { flex: 1; font-size: 0.9rem; }
.slot-remove { background: transparent; border: 1px solid #6c2a30; color: #e06c75; padding: 0.3rem 0.6rem; border-radius: 8px; font-size: 0.75rem; }
.slot.empty {
  background: #0c0f18; color: #7aa2ff; border-style: dashed; cursor: pointer;
  justify-content: flex-start; text-align: left;
}
.slot.empty:hover { background: #131a30; border-color: #4f7cff; }
.slot-empty-text { font-size: 0.92rem; }

.error { color: #e06c75; margin: 0.5rem 0 0; }

/* ── Modal (ProfileForm-styled) ─────────────────────────────── */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: grid; place-items: center; z-index: 200; padding: 1rem; }
.modal-inner { background: #11141f; border: 1px solid #232b44; border-radius: 16px; padding: 1.5rem; width: min(440px, 100%); }
.modal-inner h3 { margin: 0 0 0.4rem; font-size: 1.25rem; }
.modal-sub { color: #9fb0d8; margin: 0 0 1rem; font-size: 0.88rem; line-height: 1.5; }
.profile-form { display: grid; gap: 0.7rem; }
.profile-form input { width: 100%; box-sizing: border-box; }
.avatar-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
.upload { cursor: pointer; color: #7aa2ff; border: 1px dashed #2a3350; padding: 0.5rem 0.8rem; border-radius: 10px; font-size: 0.85rem; }
.opt { opacity: 0.5; font-weight: normal; }
.modal-row { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.7rem; }
</style>
