<script setup lang="ts">
/**
 * Shared profile form (name + avatar + discord). Used both by the full-page
 * onboarding view (step 2) and the lobby edit modal (step 3). Pre-fills from the
 * existing participant row, uploads avatars to Supabase Storage, and emits
 * `saved` after upserting. The parent decides what happens next (navigate vs
 * close modal).
 */
import { onMounted, ref } from 'vue';
import { supabase } from '@/services/supabase';
import { useSessionStore } from '@/stores/session';
import { useParticipantsStore } from '@/stores/participants';
import ParticipantAvatar from './ParticipantAvatar.vue';

const props = withDefaults(
  defineProps<{ sessionId: string; submitLabel?: string }>(),
  { submitLabel: 'Save' },
);
const emit = defineEmits<{ (e: 'saved'): void }>();

const session = useSessionStore();
const participants = useParticipantsStore();

const pid = ref('');
const name = ref('');
const discord = ref('');
const avatarUrl = ref<string | null>(null);
const busy = ref(false);
const error = ref('');

onMounted(async () => {
  pid.value = session.ensureIdentity(props.sessionId);
  // Prefer the already-loaded roster row (instant); fall back to a direct fetch.
  const row = participants.byId(pid.value);
  if (row) {
    name.value = row.name ?? '';
    discord.value = row.discord_handle ?? '';
    avatarUrl.value = row.avatar_url ?? null;
    return;
  }
  const { data } = await supabase.from('participants').select('*').eq('id', pid.value).maybeSingle();
  if (data) {
    name.value = data.name ?? '';
    discord.value = data.discord_handle ?? '';
    avatarUrl.value = data.avatar_url ?? null;
  }
});

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true; error.value = '';
  try {
    const path = `${props.sessionId}/${pid.value}-${Date.now()}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
    if (upErr) throw upErr;
    avatarUrl.value = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  } catch {
    error.value = 'Image upload failed — you can continue without one.';
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (!name.value.trim()) return;
  busy.value = true; error.value = '';
  try {
    await participants.upsertProfile(props.sessionId, pid.value, {
      name: name.value.trim(),
      avatarUrl: avatarUrl.value,
      discordHandle: discord.value.trim() || null,
    });
    emit('saved');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="profile-form">
    <div class="avatar-row">
      <ParticipantAvatar :id="pid" :name="name || '?'" :avatar-url="avatarUrl" :size="72" />
      <label class="upload">
        <input type="file" accept="image/*" @change="onFile" hidden />
        <span>Upload image</span>
      </label>
    </div>
    <label class="lbl">Name</label>
    <input v-model="name" placeholder="Your name" @keyup.enter="save" />
    <label class="lbl">Discord handle <span class="opt">(optional)</span></label>
    <input v-model="discord" placeholder="@handle" />
    <p v-if="error" class="error">{{ error }}</p>
    <button class="primary" :disabled="busy || !name.trim()" @click="save">{{ busy ? 'Saving…' : submitLabel }}</button>
  </div>
</template>

<style scoped>
.profile-form { display: grid; gap: 0.7rem; }
.avatar-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }
.upload { cursor: pointer; color: #7aa2ff; border: 1px dashed #2a3350; padding: 0.5rem 0.8rem; border-radius: 10px; }
.lbl { font-size: 0.85rem; opacity: 0.8; }
.opt { opacity: 0.5; }
input { width: 100%; box-sizing: border-box; background: #0c0f18; border: 1px solid #2a3350; color: #fff; border-radius: 10px; padding: 0.7rem; font: inherit; }
button { font: inherit; border-radius: 10px; padding: 0.7rem 1.2rem; cursor: pointer; border: none; background: #4f7cff; color: #fff; margin-top: 0.5rem; }
button:disabled { opacity: 0.5; }
.error { color: #e06c75; margin: 0; }
</style>
