<script setup lang="ts">
/**
 * Lobby format picker — a centered full-overlay dialog over the lobby, sized
 * to fit the format details plus the full example timetable with room to
 * breathe (the old 50vh slide-up drawer was too cramped for the timetable).
 *
 * Format selection lives in the lobby because format dictates how EVERY
 * downstream step actually behaves (topicsCovered, slotMinutes, criticPolicy,
 * iterations). The lobby is also where headcount is stabilising, so the
 * list of available formats can refresh reactively as the live shape changes.
 *
 * Browsing the dropdown is non-destructive: the previewed format is local
 * state until the user clicks "Select this format", at which point the
 * commit propagates to everyone via realtime. This protects against an
 * accidental dropdown click flipping the session's behaviour for the
 * whole room.
 *
 * For the post-lobby case where reconciliation (trim/pad) changes the
 * shape AFTER the format has been committed, the existing graph-sidebar
 * swap in 7-SchedulePanel.vue serves as the mismatch-only fallback.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ShapeName } from '@/util';
import { useSessionStore } from '@/stores/session';
import { getFormat, listFormatsForShape, type SessionFormatId } from '@/util/session-formats';
import FormatInfo from '@/components/FormatInfo.vue';
import SessionTimetable from '@/components/SessionTimetable.vue';
import NewExperimentalFormatDialog from '@/components/NewExperimentalFormatDialog.vue';

const props = defineProps<{
  open: boolean;
  shape: ShapeName | null;
}>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const session = useSessionStore();

// ── Format options (reactive to lobby shape) ────────────────────────────────
const formatOptions = computed(() => (props.shape ? listFormatsForShape(props.shape) : []));

// ── Committed format (session.session_format_id is the source of truth) ─────
const currentFormatId = computed<string | null>(() => session.session?.session_format_id ?? null);
const currentFormat = computed(() => {
  const id = currentFormatId.value;
  if (!id) return null;
  try { return getFormat(id as SessionFormatId); } catch { return null; }
});
const currentName = computed(() => currentFormat.value?.name ?? null);

/** Committed format whose shape no longer matches the lobby's live shape. */
const shapeMismatchOnCurrent = computed(() =>
  !!currentFormat.value && !!props.shape && currentFormat.value.shape !== props.shape,
);

// ── Preview state (browsing is non-destructive) ─────────────────────────────
const previewFormatId = ref<string>('');
const previewFormat = computed(() => {
  const id = previewFormatId.value;
  if (!id) return null;
  try { return getFormat(id as SessionFormatId); } catch { return null; }
});
const isCurrent = computed(() => !!previewFormatId.value && previewFormatId.value === currentFormatId.value);

/**
 * When the panel opens (or shape changes while open), prime preview to a
 * sensible default: committed format if it still fits the current shape,
 * else first available option, else nothing.
 */
function primePreview(): void {
  const opts = formatOptions.value;
  const committed = currentFormatId.value;
  const committedStillFits = committed && opts.some((f) => f.id === committed);
  if (committedStillFits) {
    previewFormatId.value = committed;
  } else if (opts.length) {
    previewFormatId.value = opts[0].id;
  } else {
    previewFormatId.value = '';
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) primePreview();
});
watch(() => props.shape, () => {
  if (props.open) primePreview();
});

// ── Commit ──────────────────────────────────────────────────────────────────
const swapBusy = ref(false);
const swapError = ref('');

async function commitSelected(): Promise<void> {
  const id = previewFormatId.value;
  if (!id || id === currentFormatId.value) return;
  swapBusy.value = true; swapError.value = '';
  try {
    await session.updateSessionFormat(id);
  } catch (err) {
    swapError.value = (err as Error).message;
  } finally {
    swapBusy.value = false;
  }
}

function onBrowseChange(e: Event): void {
  previewFormatId.value = (e.target as HTMLSelectElement).value;
}

// ── "Create new experimental format" dialog ─────────────────────────────────
const showNewFormatDialog = ref(false);

function close(): void { emit('update:open', false); }

// Esc to close while open.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) close();
}
onMounted(() => { window.addEventListener('keydown', onKeydown); });
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="lfp-backdrop" @click="close" />
    </Transition>

    <Transition name="pop">
      <aside v-if="open" class="lfp" role="dialog" aria-modal="true" aria-labelledby="lfp-title" @click.stop>
        <header class="lfp-head">
          <h2 id="lfp-title" class="lfp-title">Session format</h2>
          <div class="lfp-head-actions">
            <button class="lfp-icon" :title="'Close'" @click="close">✕</button>
          </div>
        </header>

        <div class="lfp-body">
          <!-- Mismatch banner: committed format's shape doesn't match live shape. -->
          <p v-if="shapeMismatchOnCurrent" class="lfp-warn">
            Shape changed to <strong>{{ shape }}</strong> — the currently selected format
            <strong>{{ currentName }}</strong> no longer fits. Pick a matching format below.
          </p>

          <!-- Browse dropdown — non-destructive; only previews. -->
          <div v-if="formatOptions.length" class="lfp-browse">
            <div class="lfp-browse-head">
              <label class="lfp-lbl" for="lfp-browse">Browse formats for {{ shape ?? '…' }}</label>
              <button class="lfp-new-format-btn" type="button" @click="showNewFormatDialog = true">
                + Create new experimental
              </button>
            </div>
            <select
              id="lfp-browse"
              :value="previewFormatId"
              :disabled="swapBusy"
              @change="onBrowseChange"
            >
              <option v-for="f in formatOptions" :key="f.id" :value="f.id">
                {{ f.name }}{{ f.id === currentFormatId ? ' (current)' : '' }}
              </option>
            </select>
          </div>
          <p v-else class="lfp-empty">No formats available for the current shape.</p>

          <!-- Preview: pure presentational components, drop in as-is. -->
          <template v-if="previewFormat">
            <FormatInfo :format="previewFormat" />
            <SessionTimetable :format="previewFormat" class="lfp-tt" />
          </template>

        </div>

        <!-- Pinned footer: stays put while the body scrolls, so the commit
             action is always reachable no matter how long the timetable is. -->
        <footer class="lfp-foot">
          <p v-if="swapError" class="lfp-err">{{ swapError }}</p>
          <div class="lfp-actions">
            <button
              v-if="!isCurrent"
              class="lfp-commit"
              :disabled="swapBusy || !previewFormatId"
              @click="commitSelected"
            >
              {{ swapBusy ? 'Saving…' : 'Select this format' }}
            </button>
            <span v-else class="lfp-current">✓ Current format</span>
          </div>
        </footer>
      </aside>
    </Transition>

    <!-- LLM-assisted "draft a new format" flow. Self-teleports to <body> so it
         overlays above this (transformed) dialog correctly. -->
    <NewExperimentalFormatDialog v-model:open="showNewFormatDialog" />
  </Teleport>
</template>

<style scoped>
/* Backdrop above the polyhedron, below the drawer. */
.lfp-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(7, 10, 18, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

/* Centered full-overlay dialog: wide enough for the format details + the full
   example timetable, capped at 90vh with the body scrolling inside. */
.lfp {
  position: fixed; top: 50%; left: 50%; z-index: 101;
  transform: translate(-50%, -50%);
  width: min(920px, 94vw); max-height: 90vh;
  background: #11141f;
  border: 1px solid #232b44;
  border-radius: 16px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
  display: flex; flex-direction: column;
  color: #e6ecff;
  overflow: hidden; /* clip the scrolling body to the rounded corners */
}

.lfp-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.7rem 1rem; border-bottom: 1px solid #232b44;
  flex: none;
}
.lfp-title { margin: 0; font-size: 0.95rem; font-weight: 600; color: #cdd6f4; letter-spacing: 0.01em; }
.lfp-head-actions { display: flex; gap: 0.3rem; }
.lfp-icon {
  width: 28px; height: 28px; border-radius: 8px;
  background: transparent; border: 1px solid #2a3350;
  color: #cdd6f4; cursor: pointer; font: inherit; font-size: 0.85rem;
  display: grid; place-items: center; transition: background 0.12s, border-color 0.12s;
}
.lfp-icon:hover { background: #1a2138; border-color: #4f7cff; color: #e6ecff; }

.lfp-body {
  flex: 1; min-height: 0; overflow-y: auto; /* min-height:0 lets the flex child shrink so it scrolls instead of overflowing */
  padding: 1.1rem 1.4rem 1.4rem;
  /* Flex column (not grid): a constrained-height grid container resolves its
     row tracks so a tall last child (the timetable) gets trapped instead of
     extending the scrollable content. Flex column scrolls the whole stack. */
  display: flex; flex-direction: column; gap: 0.8rem;
  width: 100%; box-sizing: border-box;
  scrollbar-width: thin; scrollbar-color: #2a3350 transparent; /* Firefox */
}
/* Children must keep their natural height (default flex-shrink would compress
   the tall timetable to fit instead of letting the body scroll). */
.lfp-body > * { flex: none; }
/* WebKit/Chromium scrollbar — matches the dialog's dark palette. */
.lfp-body::-webkit-scrollbar { width: 10px; }
.lfp-body::-webkit-scrollbar-track { background: transparent; }
.lfp-body::-webkit-scrollbar-thumb {
  background: #2a3350; border-radius: 999px;
  border: 2px solid #11141f; /* inset gap so the thumb reads as a pill */
}
.lfp-body::-webkit-scrollbar-thumb:hover { background: #3a4a78; }

.lfp-warn {
  margin: 0; font-size: 0.82rem; color: #f5c66c;
  background: rgba(245, 198, 108, 0.1);
  border: 1px solid rgba(245, 198, 108, 0.3);
  border-radius: 8px; padding: 0.55rem 0.7rem; line-height: 1.4;
}
.lfp-warn strong { color: #ffe2a8; text-transform: capitalize; }

.lfp-browse { display: grid; gap: 0.35rem; }
/* Label + "Create new experimental" action share a row; button pinned right. */
.lfp-browse-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.lfp-lbl { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #9fb0d8; margin: 0; }
.lfp-new-format-btn {
  flex-shrink: 0; background: transparent; border: 1px solid #2a3350; color: #7aa2ff;
  padding: 0.3rem 0.65rem; border-radius: 8px; font: inherit; font-size: 0.75rem;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.lfp-new-format-btn:hover { border-color: #4f7cff; background: #131a30; }
.lfp-browse select {
  background: #0c0f18; border: 1px solid #2a3350; color: #e6ecff;
  border-radius: 8px; padding: 0.5rem 0.6rem; font: inherit; font-size: 0.88rem;
  width: 100%;
}
.lfp-browse select:disabled { opacity: 0.55; }

.lfp-empty { margin: 0; padding: 0.7rem; background: #0c0f18; border: 1px dashed #2a3350; border-radius: 8px; color: #9fb0d8; font-size: 0.85rem; text-align: center; }

.lfp-tt { margin-top: 0.2rem; }

.lfp-err { margin: 0; font-size: 0.78rem; color: #e06c75; }

/* Pinned footer (outside the scroll area). */
.lfp-foot {
  flex: none;
  padding: 0.7rem 1.4rem 0.95rem;
  border-top: 1px solid #232b44;
  background: #11141f;
  display: grid; gap: 0.4rem;
}
.lfp-actions { display: flex; justify-content: center; }
.lfp-commit {
  background: linear-gradient(180deg, #4f7cff, #3a5fdc); border: none; color: #fff;
  border-radius: 10px; padding: 0.7rem 1.4rem; cursor: pointer; font: inherit;
  font-weight: 600; font-size: 0.92rem;
  box-shadow: 0 4px 14px rgba(79, 124, 255, 0.3);
  transition: transform 0.08s, box-shadow 0.15s;
}
.lfp-commit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79, 124, 255, 0.4); }
.lfp-commit:disabled { opacity: 0.55; cursor: not-allowed; }
.lfp-current { color: #8be8a8; font-weight: 600; font-size: 0.92rem; padding: 0.7rem; }

/* Transitions */
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.pop-enter-active, .pop-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
</style>
