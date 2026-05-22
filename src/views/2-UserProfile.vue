<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { supabase } from '@/services/supabase';
import ProfileForm from '@/components/ProfileForm.vue';

const props = defineProps<{ sessionId: string }>();
const router = useRouter();

// If the session no longer exists, saving would FK-conflict — send home instead.
onMounted(async () => {
  const { data } = await supabase.from('sessions').select('id').eq('id', props.sessionId).maybeSingle();
  if (!data) router.replace({ name: 'initiate' });
});

function onSaved() {
  router.push({ name: 'session', params: { sessionId: props.sessionId } });
}
</script>

<template>
  <main class="profile">
    <div class="card">
      <h1>Your profile</h1>
      <ProfileForm :session-id="sessionId" submit-label="Enter session →" @saved="onSaved" />
    </div>
  </main>
</template>

<style scoped>
.profile { min-height: 100vh; display: grid; place-items: center; background: #0b0e16; }
.card { width: min(420px, 90vw); background: #11141f; border: 1px solid #232b44; border-radius: 16px; padding: 1.5rem; }
h1 { margin: 0 0 1rem; }
</style>
