<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { supabase } from '@/services/supabase';
import { useSessionStore } from '@/stores/session';
import { MAX_PARTICIPANTS } from '@/util';

const props = defineProps<{ code: string }>();
const router = useRouter();
const session = useSessionStore();
const state = ref<'resolving' | 'locked' | 'full' | 'notfound'>('resolving');

onMounted(async () => {
  try {
    const row = await session.resolveCode(props.code);
    // Scheduled sessions live on a separate invite page until promotion.
    if (row.status === 'scheduled') {
      router.replace({ name: 'scheduled', params: { code: row.code } });
      return;
    }
    if (row.roster_locked) { state.value = 'locked'; return; }

    // Returning participants are always let back in; new joiners are blocked
    // once the session hits the icosahedron ceiling (30).
    const myPid = localStorage.getItem(`syntegrity:pid:${row.id}`);
    let amParticipant = false;
    if (myPid) {
      const { data } = await supabase.from('participants').select('id').eq('id', myPid).eq('removed', false).maybeSingle();
      amParticipant = !!data;
    }
    if (!amParticipant) {
      const { count } = await supabase
        .from('participants')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', row.id)
        .eq('removed', false);
      if ((count ?? 0) >= MAX_PARTICIPANTS) { state.value = 'full'; return; }
    }

    router.replace({ name: 'profile', params: { sessionId: row.id } });
  } catch {
    state.value = 'notfound';
  }
});
</script>

<template>
  <main class="center">
    <p v-if="state === 'resolving'">Joining…</p>
    <div v-else-if="state === 'full'">
      <h1>Sorry, this session is full</h1>
      <p>This Syntegrity session already has its maximum of {{ MAX_PARTICIPANTS }} participants.</p>
    </div>
    <div v-else-if="state === 'locked'">
      <h1>This session is locked</h1>
      <p>The roster has closed and is no longer accepting new participants.</p>
    </div>
    <div v-else>
      <h1>Session not found</h1>
      <p>Check the code and try again.</p>
    </div>
  </main>
</template>

<style scoped>
.center { min-height: 100vh; display: grid; place-items: center; text-align: center; color: #e6ecff; background: #0b0e16; gap: 0.5rem; }
</style>
