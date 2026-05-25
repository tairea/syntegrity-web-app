<script setup lang="ts">
/**
 * Shared timetable preview for a SessionFormat. Used both on /schedule (host
 * picks the format) and on /scheduled/:code (invitees see what they're
 * committing to). Renders the per-stage breakdown plus the Outcome Resolve
 * placement grid (members + critics + idle) per slot.
 */
import { computed } from 'vue';
import { SHAPE_META } from '@/util';
import type { SessionFormat } from '@/util/session-formats';
import { buildTimetableRows, formatDuration, ordinal } from '@/util/timetable';

const props = defineProps<{
  format: SessionFormat;
}>();

const shapeMeta = computed(() => SHAPE_META[props.format.shape]);
const rows = computed(() => buildTimetableRows(props.format, shapeMeta.value));
</script>

<template>
  <div class="timetable">
    <template v-for="row in rows" :key="row.id">
      <div v-if="row.kind === 'standard'" class="t-row">
        <div class="t-main">
          <span class="t-label">{{ row.label }}</span>
          <span class="t-mins">{{ row.minutes }} min</span>
        </div>
        <div v-if="row.sub" class="t-sub">{{ row.sub }}</div>
      </div>

      <div v-else class="t-row or-row">
        <div class="t-main">
          <span class="t-label">{{ row.label }}</span>
          <span class="t-mins">{{ row.minutes }} min</span>
        </div>
        <div class="t-sub">
          {{ row.concurrency }} parallel meeting{{ row.concurrency === 1 ? '' : 's' }} per slot — {{ row.criticPolicy }}
        </div>
        <div class="or-iters">
          <div v-for="(slots, ii) in row.schedule" :key="ii" class="or-iter">
            <div v-if="row.iterations > 1" class="or-iter-label">Iteration {{ ii + 1 }}</div>
            <div class="or-grid" :style="{ gridTemplateColumns: `auto repeat(${row.concurrency}, minmax(0, 1fr)) auto` }">
              <template v-for="(slot, si) in slots" :key="si">
                <div class="or-slot-label">{{ row.slotMinutes }}m</div>
                <div v-for="meeting in slot.meetings" :key="`m-${si}-${meeting.topic}`" class="or-cell">
                  <div class="or-cell-head">
                    <span class="or-cell-main">Topic {{ meeting.topic }}</span>
                    <span class="or-cell-sub">{{ ordinal(ii + 1) }} iteration</span>
                  </div>
                  <div class="people">
                    <span v-for="p in meeting.members" :key="`mem-${p}`" class="pid member">{{ p }}</span>
                    <template v-if="meeting.critics.length">
                      <span class="pid-sep">·</span>
                      <span v-for="p in meeting.critics" :key="`crit-${p}`" class="pid critic">{{ p }}</span>
                    </template>
                  </div>
                  <div class="or-cell-foot">
                    {{ meeting.members.length }} member{{ meeting.members.length === 1 ? '' : 's' }}<span v-if="meeting.critics.length"> · {{ meeting.critics.length }} critic{{ meeting.critics.length === 1 ? '' : 's' }}</span>
                  </div>
                </div>
                <div v-for="n in (row.concurrency - slot.meetings.length)" :key="`e-${si}-${n}`" class="or-cell empty"></div>
                <div class="or-idle" :class="{ none: !slot.idle.length }">
                  <template v-if="slot.idle.length">
                    <span class="or-idle-label">sitting out</span>
                    <div class="people idle">
                      <span v-for="p in slot.idle" :key="`idle-${si}-${p}`" class="pid idle">{{ p }}</span>
                    </div>
                  </template>
                  <template v-else>
                    <span class="or-idle-label all-in">all {{ shapeMeta.participantCount }} engaged</span>
                  </template>
                </div>
              </template>
            </div>
            <div v-if="ii < row.schedule.length - 1 && row.betweenIterationBreakMinutes" class="or-break">
              Break — {{ row.betweenIterationBreakMinutes }} min
            </div>
          </div>
        </div>
        <div class="or-legend">
          <span class="pid member sm">1</span> member
          <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'" class="legend-sep">·</span>
          <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'" class="pid critic sm">1</span>
          <span v-if="row.criticPolicy === 'all-critics-in-room' || row.criticPolicy === 'split-critics-in-room'"> critic</span>
          <span class="legend-sep">·</span>
          <span class="pid idle sm">1</span> sitting out
          <span class="legend-note">— preview placement; the real per-person assignment is computed when the session starts.</span>
        </div>
      </div>
    </template>
    <div class="t-total">
      <span>Total</span>
      <span>{{ formatDuration(format.totalMinutes) }}</span>
    </div>
  </div>
</template>

<style scoped>
.timetable { background: #0c0f18; border: 1px solid #2a3350; border-radius: 10px; overflow: hidden; }
.t-row { padding: 0.6rem 0.9rem; border-bottom: 1px solid #1a2138; }
.t-row:last-of-type { border-bottom: none; }
.t-main { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
.t-label { color: #e6ecff; }
.t-mins { color: #9fb0d8; font-variant-numeric: tabular-nums; }
.t-sub { font-size: 0.78rem; color: #6f7c98; margin-top: 0.2rem; }
.t-total { display: flex; justify-content: space-between; padding: 0.7rem 0.9rem; background: #11162a; color: #e6ecff; font-weight: 600; border-top: 1px solid #2a3350; }

/* Outcome Resolve grid (rows = time slots, cols = parallel meetings) */
.or-row { background: #0a0d16; }
.or-iters { display: grid; gap: 0.6rem; margin-top: 0.6rem; }
.or-iter-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #7aa2ff; margin-bottom: 0.3rem; }
.or-grid { display: grid; gap: 4px; align-items: stretch; }
.or-slot-label { font-size: 0.72rem; color: #6f7c98; padding: 0.55rem 0.5rem 0 0; align-self: start; font-variant-numeric: tabular-nums; }
.or-cell { background: #1a2138; border: 1px solid #2a3350; border-radius: 6px; padding: 0.5rem 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
.or-cell-head { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.or-cell-main { font-size: 0.82rem; color: #cdd6f4; line-height: 1.1; }
.or-cell-sub { font-size: 0.62rem; color: #6f7c98; line-height: 1.1; }
.or-cell-foot { font-size: 0.65rem; color: #6f7c98; text-align: center; }
.or-cell.empty { background: transparent; border-style: dashed; border-color: #1a2138; }
.or-break { font-size: 0.75rem; color: #6f7c98; padding: 0.4rem 0; text-align: center; border-top: 1px dashed #1a2138; margin-top: 0.4rem; }

.people { display: flex; flex-wrap: wrap; gap: 3px; justify-content: center; align-items: center; }
.pid { display: inline-flex; align-items: center; justify-content: center; min-width: 1.4em; height: 1.4em; padding: 0 0.3em; border-radius: 999px; font-size: 0.65rem; font-variant-numeric: tabular-nums; line-height: 1; }
.pid.member { background: #2d3f6e; color: #e6ecff; }
.pid.critic { background: transparent; color: #9fb0d8; border: 1px solid #3a456b; }
.pid.idle { background: transparent; color: #6f7c98; border: 1px dashed #2a3350; }
.pid.sm { font-size: 0.6rem; min-width: 1.2em; height: 1.2em; }
.pid-sep { color: #3a456b; font-weight: 700; }

.or-idle { padding: 0.5rem 0 0.5rem 0.6rem; border-left: 1px dashed #1a2138; min-width: 110px; display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start; }
.or-idle.none { opacity: 0.6; }
.or-idle-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6f7c98; }
.or-idle-label.all-in { color: #8be8a8; }
.people.idle { gap: 2px; }

.or-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.6rem; font-size: 0.72rem; color: #9fb0d8; }
.legend-sep { color: #3a456b; }
.legend-note { color: #6f7c98; flex-basis: 100%; margin-top: 0.2rem; }
</style>
