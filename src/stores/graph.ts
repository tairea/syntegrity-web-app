/**
 * Step 7 (Syntegrity Graph) store: assembles RoleAssignmentInput from the
 * finalized topics + roster + preferences, runs BOTH assignment methods
 * (algorithm + LLM), builds each schedule, caches results to role_assignments,
 * and holds the focus/critique UI state. The prototype UI toggles between the
 * two cached method results.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { supabase } from '@/services/supabase';
import type { RoleAssignmentRow, TopicCardRow } from '@/services/db-types';
import { topicCardRowToTopic } from '@/services/db-types';
import {
  assertInputConsistency,
  assignRolesAlgorithm,
  assignRolesOpenRouter,
  buildSchedule,
  getShape,
  type AssignmentMethod,
  type RoleAssignmentInput,
  type RoleAssignmentResult,
  type SessionSchedule,
  type Topic,
  type TopicId,
} from '@/util';
import { getFormat, type SessionFormatId } from '@/util/session-formats';
import { useSessionStore } from './session';
import { useVotingStore } from './voting';
import { useParticipantsStore } from './participants';
import { usePreferenceStore } from './preference';

export interface FocusTarget {
  type: 'person' | 'topic';
  id: string;
}

export const useGraphStore = defineStore('graph', () => {
  const results = ref<Partial<Record<AssignmentMethod, RoleAssignmentResult>>>({});
  const schedules = ref<Partial<Record<AssignmentMethod, SessionSchedule>>>({});
  const activeMethod = ref<AssignmentMethod>('algorithm');
  const focus = ref<FocusTarget | null>(null);
  const critiqueMode = ref(false);
  const computing = ref<Partial<Record<AssignmentMethod, boolean>>>({});

  const activeResult = computed(() => results.value[activeMethod.value]);
  const activeSchedule = computed(() => schedules.value[activeMethod.value]);

  /** Finalized topics = top-N winning cards, vertex-indexed by rank order. */
  const finalizedTopics = computed<Topic[]>(() => {
    const session = useSessionStore();
    if (!session.session?.locked_shape) return [];
    const shape = getShape(session.session.locked_shape);
    const winners = useVotingStore().topNCards(shape.topicCount);
    return winners.map((c: TopicCardRow, i: number) => topicCardRowToTopic(c, i));
  });

  function buildInput(): RoleAssignmentInput {
    const session = useSessionStore();
    if (!session.session?.locked_shape) throw new Error('No locked shape; cannot build role input.');
    const shape = getShape(session.session.locked_shape);
    const input: RoleAssignmentInput = {
      shape,
      topics: finalizedTopics.value,
      participants: useParticipantsStore().asDomain,
      preferences: usePreferenceStore().asTopicPreferences,
    };
    assertInputConsistency(input); // gate on the hard participantCount invariant
    return input;
  }

  // ── realtime (cached results) ───────────────────────────────────────────
  function load(rows: RoleAssignmentRow[]): void {
    for (const r of rows) apply(r);
  }
  function apply(r: RoleAssignmentRow): void {
    results.value = { ...results.value, [r.method]: r.result as RoleAssignmentResult };
    schedules.value = { ...schedules.value, [r.method]: r.schedule as SessionSchedule };
  }

  /**
   * If the session's format declares `topicsCovered < topicCount`, return the
   * top `topicsCovered` topic ids by vote rank (Topic.vertexIndex is assigned
   * in rank order in `finalizedTopics`, so the first N entries are the highest
   * voted). Otherwise return undefined and the scheduler runs every topic.
   */
  function activeTopicIds(topics: Topic[]): TopicId[] | undefined {
    const session = useSessionStore();
    const id = session.session?.session_format_id;
    if (!id) return undefined;
    const f = getFormat(id as SessionFormatId);
    const or = f?.stages.find((s) => s.kind === 'outcome-resolve');
    if (!or || or.kind !== 'outcome-resolve') return undefined;
    const covered = or.topicsCovered ?? topics.length;
    if (covered >= topics.length) return undefined;
    // finalizedTopics is rank-ordered (highest-voted first); take the prefix.
    return topics.slice(0, covered).map((t) => t.id);
  }

  /** Compute a method if not already cached, persist, and store locally. */
  async function compute(method: AssignmentMethod): Promise<void> {
    if (results.value[method] || computing.value[method]) return;
    computing.value = { ...computing.value, [method]: true };
    try {
      const input = buildInput();
      const result = method === 'algorithm' ? assignRolesAlgorithm(input) : await assignRolesOpenRouter(input);
      const schedule = buildSchedule({
        shape: input.shape,
        assignment: result,
        topics: input.topics,
        participants: input.participants,
        activeTopicIds: activeTopicIds(input.topics),
      });
      results.value = { ...results.value, [method]: result };
      schedules.value = { ...schedules.value, [method]: schedule };
      const session = useSessionStore();
      await supabase.from('role_assignments').upsert(
        { session_id: session.sessionId, method, result, schedule },
        { onConflict: 'session_id,method' },
      );
    } catch (e) {
      console.error(`[graph] compute ${method} failed`, e);
      throw e;
    } finally {
      computing.value = { ...computing.value, [method]: false };
    }
  }

  function setMethod(m: AssignmentMethod): void { activeMethod.value = m; }
  function setFocus(target: FocusTarget | null): void { focus.value = target; critiqueMode.value = false; }
  function toggleCritique(): void { critiqueMode.value = !critiqueMode.value; }

  return {
    results, schedules, activeMethod, focus, critiqueMode, computing,
    activeResult, activeSchedule, finalizedTopics,
    buildInput, load, apply, compute, setMethod, setFocus, toggleCritique,
  };
});
