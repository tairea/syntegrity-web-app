<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '@/stores/session';

const router = useRouter();
const session = useSessionStore();

const mode = ref<'home' | 'start' | 'created'>('home');
const drivingQuestion = ref('');
const showExamples = ref(false);
const busy = ref(false);
const error = ref('');
const created = ref<{ sessionId: string; code: string } | null>(null);

const inviteLink = computed(() => (created.value ? `${location.origin}/join/${created.value.code}` : ''));
const copied = ref(false);

const heading = computed(() => {
  switch (mode.value) {
    case 'start':
      return {
        title: 'Driving Question',
        subtitle: 'Pose one open, shared, and consequential question for the group to explore — it should invite genuinely different answers.',
      };
    case 'created':
      return { title: 'Session created', subtitle: 'Share the invite link, then continue to your profile.' };
    default:
      return { title: 'Team Syntegrity', subtitle: 'A non-hierarchical method for group thinking, after Stafford Beer.' };
  }
});

const EXAMPLES = [
  'How should our community move from informal mutual aid to a functioning Integral node this year?',
  'What kinds of contribution should our node recognise, and what should remain freely accessible regardless of contribution?',
  'How do we coordinate production and resources with neighbouring nodes without recreating central authority?',
];

async function startSession() {
  if (!drivingQuestion.value.trim()) return;
  busy.value = true; error.value = '';
  try {
    created.value = await session.createSession(drivingQuestion.value.trim());
    mode.value = 'created';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function goToProfile() {
  if (created.value) router.push({ name: 'profile', params: { sessionId: created.value.sessionId } });
}
function copyLink() {
  if (!inviteLink.value) return;
  navigator.clipboard?.writeText(inviteLink.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <main class="initiate">
    <div class="hero">
      <h1>{{ heading.title }}</h1>
      <p class="sub">
        {{ heading.subtitle }}
        <span v-if="mode === 'start'" class="info-wrap">
          <button
            class="info"
            aria-label="Examples of good driving questions"
            @mouseenter="showExamples = true"
            @mouseleave="showExamples = false"
            @click="showExamples = !showExamples"
          >
            <img class="info-icon" src="https://api.iconify.design/mdi/information-outline.svg?color=%237aa2ff" alt="info" width="18" height="18" />
          </button>
          <span v-if="showExamples" class="tooltip">
            <span class="tt-title">Examples</span>
            <ul><li v-for="ex in EXAMPLES" :key="ex">{{ ex }}</li></ul>
          </span>
        </span>
      </p>

      <div v-if="mode === 'home'" class="home">
        <button class="primary" @click="mode = 'start'">Start a session</button>
        <p class="join-note">Joining? Open the invite link your host shared with you.</p>
      </div>

      <div v-else-if="mode === 'start'" class="form">
        <textarea v-model="drivingQuestion" rows="3" placeholder="Please enter the driving question for this syntegrity session" />
        <p v-if="error" class="error">{{ error }}</p>
        <div class="row">
          <button class="ghost" @click="mode = 'home'">Back</button>
          <button class="primary" :disabled="busy || !drivingQuestion.trim()" @click="startSession">{{ busy ? 'Creating…' : 'Create session' }}</button>
        </div>
      </div>

      <div v-else-if="mode === 'created'" class="form">
        <div class="link">
          <input :value="inviteLink" readonly />
          <div class="copy-wrap">
            <button class="ghost" @click="copyLink">Copy</button>
            <Transition name="fade"><span v-if="copied" class="copied">Copied!</span></Transition>
          </div>
        </div>
        <button class="primary" @click="goToProfile">Continue to your profile →</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.initiate { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 50% 30%, #1a2138, #0b0e16); }
.hero { width: min(520px, 90vw); text-align: center; }
h1 { font-size: 2.4rem; font-weight: 600; margin: 0 0 0.5rem; line-height: 1.1; }
/* Use a muted color, NOT opacity — opacity on this element would bleed into the
   absolutely-positioned tooltip child and make it look transparent. */
.sub { color: #9fb0d8; margin: 0 0 1.75rem; line-height: 1.45; }

.info-wrap { position: relative; display: inline-flex; vertical-align: middle; }
.info { background: none; border: none; cursor: pointer; padding: 0 0 0 0.3rem; display: inline-flex; align-items: center; }
.info-icon { display: block; }
.tooltip {
  position: absolute; left: 50%; top: calc(100% + 10px); transform: translateX(-50%);
  width: min(340px, 80vw); background: #1c2233; border: 1px solid #3a456b; border-radius: 12px;
  padding: 0.8rem 1rem; text-align: left; z-index: 100; box-shadow: 0 16px 40px rgba(0,0,0,.6);
  opacity: 1;
}
.tt-title { display: block; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9fb0d8; margin-bottom: 0.45rem; }
.tooltip ul { margin: 0; padding-left: 1.1rem; font-size: 0.85rem; color: #eef2ff; }
.tooltip li { margin: 0.25rem 0; }

.home { display: grid; gap: 1rem; justify-items: center; }
.home .primary { min-width: 220px; }
.join-note { color: #6b7694; font-size: 0.8rem; margin: 0.5rem 0 0; }
.copy-wrap { position: relative; display: flex; }
.copied { position: absolute; bottom: calc(100% + 6px); right: 0; background: #2a7a44; color: #fff; font-size: 0.72rem; padding: 0.2rem 0.5rem; border-radius: 6px; white-space: nowrap; pointer-events: none; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.form { display: grid; gap: 0.75rem; text-align: left; }

textarea, input { width: 100%; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
.row { display: flex; justify-content: space-between; gap: 0.5rem; }
.link { display: flex; gap: 0.5rem; }
button { font: inherit; border-radius: 10px; padding: 0.7rem 1.2rem; cursor: pointer; border: 1px solid transparent; }
.primary { background: #4f7cff; color: #fff; }
.primary:disabled { opacity: 0.5; cursor: default; }
.ghost { background: transparent; border-color: #2a3350; color: #cdd6f4; }
.error { color: #e06c75; margin: 0; }
.code { opacity: 0.8; }
</style>
