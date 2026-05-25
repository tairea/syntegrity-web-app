/**
 * Step 7 — Outcome Resolve scheduler.
 *
 * Given a role assignment, produce the meeting schedule: each of the `topicCount`
 * teams runs through `iterations` meetings (default 3: status quo -> ideal ->
 * actions). Two teams may share a time slot ONLY if their blocking-attendee sets
 * are disjoint — what counts as "blocking" depends on `criticPolicy`.
 *
 * CONCURRENCY IS A PROPERTY OF THE SHAPE × CRITIC POLICY.
 * Beer's "two teams at once" is specific to the icosahedron with critics in
 * room. In a tetrahedron every team contains all 6 people, so only ONE team
 * can meet at a time regardless of policy. On the octahedron, all-critics-in-
 * room forces sequential (8 attendees per topic, 12 people total), but split-
 * critics-in-room frees concurrency to 2 (only members block, and opposite
 * vertices have disjoint members). The scheduler computes the maximum feasible
 * concurrency from the actual blocking-attendee overlaps and packs accordingly.
 *
 * Strategy (deterministic, conflict-free by construction):
 *   - derive teams from the assignment, filter to `activeTopicIds`;
 *   - schedule iteration-by-iteration (all active teams do meeting 1, then
 *     meeting 2, ...), so every team's iterations stay in order and stay
 *     phase-aligned;
 *   - within an iteration, open slots and greedily fill each with teams whose
 *     blocking attendees don't clash with teams already in that slot, up to
 *     the cap;
 *   - after a slot is packed, if criticPolicy is 'split-critics-in-room',
 *     distribute eligible critics across the slot's meetings (one critic per
 *     meeting per slot, balanced across qualifying meetings).
 */

import type {
  CriticPolicy,
  MeetingSession,
  ParticipantId,
  PersonalSchedule,
  PersonalScheduleItem,
  ScheduleConflict,
  ScheduleSlot,
  SchedulerInput,
  SessionSchedule,
  Team,
  TopicId,
} from './types';

const DEFAULT_ITERATIONS = 3;
const DEFAULT_CRITIC_POLICY: CriticPolicy = 'all-critics-in-room';

/** Map each strut to the participant sitting on it, from the assignment. */
function strutToParticipant(input: SchedulerInput): Map<number, ParticipantId> {
  const m = new Map<number, ParticipantId>();
  for (const a of input.assignment.assignments) m.set(a.strutId, a.participantId);
  return m;
}

/**
 * Derive the `topicCount` teams from the geometry + assignment: for each vertex,
 * members are the people on struts touching it, critics are the people on struts
 * that critique it.
 */
export function deriveTeams(input: SchedulerInput): Team[] {
  const { shape, topics } = input;
  const strutPerson = strutToParticipant(input);
  const topicByVertex = new Map(topics.map((t) => [t.vertexIndex, t]));

  const members: ParticipantId[][] = Array.from({ length: shape.topicCount }, () => []);
  const critics: ParticipantId[][] = Array.from({ length: shape.topicCount }, () => []);

  for (const strut of shape.struts) {
    const person = strutPerson.get(strut.id);
    if (person === undefined) continue; // unassigned strut (shouldn't happen)
    for (const v of strut.memberOf) members[v].push(person);
    for (const v of strut.criticOf) critics[v].push(person);
  }

  const teams: Team[] = [];
  for (let v = 0; v < shape.topicCount; v++) {
    const topic = topicByVertex.get(v);
    if (!topic) throw new Error(`No topic bound to vertex ${v}`);
    teams.push({
      topicId: topic.id,
      vertexIndex: v,
      memberParticipantIds: members[v],
      criticParticipantIds: critics[v],
    });
  }
  return teams;
}

/**
 * Attendees that BLOCK a team from sharing a slot with another. Under
 * 'all-critics-in-room' this is members ∪ critics (Beer canon). Under the
 * other policies only members count — critics are either distributed across
 * the slot's meetings later (`split-critics-in-room`) or not in the room at
 * all (`async-notes-only`, `no-critics`).
 */
function blockingAttendeesOf(team: Team, policy: CriticPolicy): Set<ParticipantId> {
  if (policy === 'all-critics-in-room') {
    return new Set([...team.memberParticipantIds, ...team.criticParticipantIds]);
  }
  return new Set(team.memberParticipantIds);
}

export function buildSchedule(input: SchedulerInput): SessionSchedule {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const policy = input.criticPolicy ?? DEFAULT_CRITIC_POLICY;
  const allTeams = deriveTeams(input);
  const teams = filterActiveTeams(allTeams, input.activeTopicIds);
  const cap = Math.max(1, input.concurrency ?? Number.POSITIVE_INFINITY);

  const blockingAttendees = teams.map((t) => blockingAttendeesOf(t, policy));
  const slots: ScheduleSlot[] = [];

  for (let iter = 1; iter <= iterations; iter++) {
    const remaining = teams.map((_, i) => i);

    while (remaining.length > 0) {
      const slot: ScheduleSlot = { index: slots.length, sessions: [] };
      const occupied = new Set<ParticipantId>();

      for (let k = 0; k < remaining.length && slot.sessions.length < cap; ) {
        const ti = remaining[k];
        const clashes = [...blockingAttendees[ti]].some((p) => occupied.has(p));
        if (clashes) {
          k++;
          continue;
        }
        const team = teams[ti];
        slot.sessions.push(buildSession(team, iter, slot.index, policy));
        for (const p of blockingAttendees[ti]) occupied.add(p);
        remaining.splice(k, 1);
      }

      if (policy === 'split-critics-in-room') {
        distributeCritics(slot, teams);
      }

      slots.push(slot);
    }
  }

  const effectiveConcurrency = slots.reduce((max, s) => Math.max(max, s.sessions.length), 0);
  const perParticipant = buildPersonalSchedules(input, slots);
  const conflicts = validateSchedule(slots, teams, iterations, effectiveConcurrency);

  return {
    slots,
    concurrency: effectiveConcurrency,
    iterations,
    teams,
    perParticipant,
    conflicts,
  };
}

function filterActiveTeams(teams: Team[], activeTopicIds?: TopicId[]): Team[] {
  if (!activeTopicIds) return teams;
  const active = new Set(activeTopicIds);
  return teams.filter((t) => active.has(t.topicId));
}

/**
 * For 'split-critics-in-room' slots, assign eligible critics to the slot's
 * meetings. A critic is eligible for a meeting M if they critique M's topic
 * AND they are not already a member of any meeting in the same slot. Each
 * eligible critic is placed in exactly one meeting per slot, choosing the
 * meeting (among the ones they qualify for) with the fewest critics so far.
 *
 * Deterministic: critics are processed in id order; ties broken by the
 * meeting's vertexIndex.
 */
function distributeCritics(slot: ScheduleSlot, allTeams: Team[]): void {
  const teamByTopic = new Map(allTeams.map((t) => [t.topicId, t]));

  const membersInSlot = new Set<ParticipantId>();
  for (const session of slot.sessions) {
    for (const p of session.attendeeMemberIds) membersInSlot.add(p);
  }

  // Map each candidate critic to the meetings in this slot they qualify for.
  const options = new Map<ParticipantId, MeetingSession[]>();
  for (const session of slot.sessions) {
    const team = teamByTopic.get(session.teamTopicId);
    if (!team) continue;
    for (const critic of team.criticParticipantIds) {
      if (membersInSlot.has(critic)) continue;
      const list = options.get(critic) ?? [];
      list.push(session);
      options.set(critic, list);
    }
  }

  const sortedCritics = [...options.keys()].sort();
  for (const critic of sortedCritics) {
    const opts = options.get(critic)!;
    opts.sort(
      (a, b) =>
        a.attendeeCriticIds.length - b.attendeeCriticIds.length ||
        a.vertexIndex - b.vertexIndex,
    );
    opts[0].attendeeCriticIds.push(critic);
  }
}

function buildSession(
  team: Team,
  iteration: number,
  slotIndex: number,
  policy: CriticPolicy,
): MeetingSession {
  // attendeeCriticIds depends on policy:
  //  - all-critics-in-room: every critic of the team is in the room
  //  - split-critics-in-room: filled in by distributeCritics() after packing
  //  - async-notes-only / no-critics: no critics ever in the room
  const attendeeCriticIds: ParticipantId[] =
    policy === 'all-critics-in-room' ? [...team.criticParticipantIds] : [];

  return {
    teamTopicId: team.topicId,
    vertexIndex: team.vertexIndex,
    iteration,
    slotIndex,
    attendeeMemberIds: team.memberParticipantIds,
    attendeeCriticIds,
  };
}

function buildPersonalSchedules(input: SchedulerInput, slots: ScheduleSlot[]): PersonalSchedule[] {
  const byPerson = new Map<ParticipantId, PersonalScheduleItem[]>();
  for (const p of input.participants) byPerson.set(p.id, []);

  for (const slot of slots) {
    for (const session of slot.sessions) {
      for (const id of session.attendeeMemberIds) {
        byPerson.get(id)?.push({ slotIndex: slot.index, teamTopicId: session.teamTopicId, role: 'member', iteration: session.iteration });
      }
      for (const id of session.attendeeCriticIds) {
        byPerson.get(id)?.push({ slotIndex: slot.index, teamTopicId: session.teamTopicId, role: 'critic', iteration: session.iteration });
      }
    }
  }

  const totalSlots = slots.length;
  return input.participants.map((p) => {
    const items = (byPerson.get(p.id) ?? []).sort((a, b) => a.slotIndex - b.slotIndex);
    const busy = new Set(items.map((i) => i.slotIndex));
    const offSlots = Array.from({ length: totalSlots }, (_, i) => i).filter((i) => !busy.has(i));
    return { participantId: p.id, items, offSlots };
  });
}

function validateSchedule(
  slots: ScheduleSlot[],
  teams: Team[],
  iterations: number,
  concurrency: number,
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];

  for (const slot of slots) {
    if (slot.sessions.length > concurrency) {
      conflicts.push({ kind: 'oversubscribed-slot', slotIndex: slot.index, detail: `${slot.sessions.length} sessions > concurrency ${concurrency}` });
    }
    const seen = new Set<ParticipantId>();
    for (const s of slot.sessions) {
      for (const p of [...s.attendeeMemberIds, ...s.attendeeCriticIds]) {
        if (seen.has(p)) {
          conflicts.push({ kind: 'double-booked', slotIndex: slot.index, participantId: p, detail: `in two sessions in slot ${slot.index}` });
        }
        seen.add(p);
      }
    }
  }

  // Every ACTIVE team must appear exactly `iterations` times.
  // (`teams` has already been filtered to activeTopicIds upstream.)
  const counts = new Map<string, number>();
  for (const slot of slots) for (const s of slot.sessions) counts.set(s.teamTopicId, (counts.get(s.teamTopicId) ?? 0) + 1);
  for (const team of teams) {
    const c = counts.get(team.topicId) ?? 0;
    if (c !== iterations) {
      conflicts.push({ kind: 'missing-iteration', slotIndex: -1, detail: `team ${team.topicId} scheduled ${c}/${iterations} times` });
    }
  }

  return conflicts;
}
