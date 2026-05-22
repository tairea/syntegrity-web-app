/**
 * Step 7 — Outcome Resolve scheduler.
 *
 * Given a role assignment, produce the meeting schedule: each of the `topicCount`
 * teams runs through `iterations` meetings (default 3: status quo -> ideal ->
 * actions). Two teams may share a time slot ONLY if their attendee sets are
 * disjoint, where a team's attendees = its members + its critics.
 *
 * CONCURRENCY IS A PROPERTY OF THE SHAPE, NOT A CONSTANT 2.
 * Beer's "two teams at once" is specific to the icosahedron, where non-adjacent
 * teams happen to share no people. In a tetrahedron every team contains all 6
 * people, so only ONE team can meet at a time. The scheduler therefore computes
 * the maximum feasible concurrency from the actual attendee overlaps and packs
 * accordingly, rather than assuming a number.
 *
 * Strategy (deterministic, conflict-free by construction):
 *   - derive teams from the assignment;
 *   - schedule iteration-by-iteration (all teams do meeting 1, then meeting 2,
 *     ...), so every team's iterations stay in order and stay phase-aligned;
 *   - within an iteration, open slots and greedily fill each with teams whose
 *     attendees don't clash with teams already in that slot, up to the cap.
 */

import type {
  MeetingSession,
  ParticipantId,
  PersonalSchedule,
  PersonalScheduleItem,
  ScheduleConflict,
  ScheduleSlot,
  SchedulerInput,
  SessionSchedule,
  Team,
} from './types';

const DEFAULT_ITERATIONS = 3;

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

/** All attendees (members + critics) of a team. */
function attendeesOf(team: Team): Set<ParticipantId> {
  return new Set([...team.memberParticipantIds, ...team.criticParticipantIds]);
}

export function buildSchedule(input: SchedulerInput): SessionSchedule {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const teams = deriveTeams(input);
  const cap = Math.max(1, input.concurrency ?? Number.POSITIVE_INFINITY);

  const teamAttendees = teams.map(attendeesOf);
  const slots: ScheduleSlot[] = [];

  for (let iter = 1; iter <= iterations; iter++) {
    // Teams still needing a slot this iteration.
    const remaining = teams.map((_, i) => i);

    while (remaining.length > 0) {
      const slot: ScheduleSlot = { index: slots.length, sessions: [] };
      const occupied = new Set<ParticipantId>();

      for (let k = 0; k < remaining.length && slot.sessions.length < cap; ) {
        const ti = remaining[k];
        const clashes = [...teamAttendees[ti]].some((p) => occupied.has(p));
        if (clashes) {
          k++; // try the next candidate; leave this team for a later slot
          continue;
        }
        const team = teams[ti];
        slot.sessions.push(buildSession(team, iter, slot.index));
        for (const p of teamAttendees[ti]) occupied.add(p);
        remaining.splice(k, 1); // placed; do not advance k (array shrank)
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

function buildSession(team: Team, iteration: number, slotIndex: number): MeetingSession {
  return {
    teamTopicId: team.topicId,
    vertexIndex: team.vertexIndex,
    iteration,
    slotIndex,
    attendeeMemberIds: team.memberParticipantIds,
    attendeeCriticIds: team.criticParticipantIds,
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

  // Every team must appear exactly `iterations` times.
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
