/**
 * Core domain data objects for the Syntegrity prototype.
 *
 * These are the *compute-layer* types shared by the three step-7 utility scripts:
 *   - 7-role-assignment-algorithm.ts  (deterministic assignment of people -> struts)
 *   - 7-role-assignment-llm.ts        (LLM assignment of people -> struts)
 *   - 7-scheduler.ts                  (Outcome Resolve meeting schedule)
 *
 * They are deliberately independent of Supabase row shapes and of any Vue/UI
 * concerns. A persistence layer can map these to/from DB rows later; the scripts
 * only ever see plain domain objects.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE INVARIANT THAT MAKES THE WHOLE THING WORK
 * ─────────────────────────────────────────────────────────────────────────────
 * In every valid Syntegrity geometry, a participant IS an edge (a "strut") of a
 * polyhedron. An edge touches 2 vertices and is assigned to critique 2 more.
 * Therefore EVERY participant, on EVERY shape, is:
 *      - a full MEMBER of exactly 2 teams (its 2 endpoint vertices), and
 *      - a CRITIC of exactly 2 other teams.
 * => 4 team involvements per person, always. The data model is built around this.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

/** A finalized topic that occupies one vertex of the chosen shape. */
export type TopicId = string;
/** A person in the session. */
export type ParticipantId = string;
/** Index of a vertex (0..topicCount-1). A vertex == a topic slot == a team. */
export type VertexIndex = number;
/** Index of an edge/strut (0..participantCount-1). A strut == one person's role. */
export type StrutId = number;

// ─────────────────────────────────────────────────────────────────────────────
// Geometry (see geometry.ts for concrete instances)
// ─────────────────────────────────────────────────────────────────────────────

/** The six edge-transitive solids on which Syntegrity is valid. */
export type ShapeName =
  | 'tetrahedron'      //  6 people /  4 topics / teams of 3
  | 'octahedron'       // 12 people /  6 topics / teams of 4
  | 'cube'             // 12 people /  8 topics / teams of 3
  | 'cuboctahedron'    // 24 people / 12 topics / teams of 4
  | 'icosahedron'      // 30 people / 12 topics / teams of 5  (canonical)
  | 'icosidodecahedron'; // 60 people / 30 topics / teams of 4

/**
 * One strut/edge of the polyhedron == one participant role slot.
 * `memberOf` and `criticOf` are vertex indices, NOT topic ids — topics are bound
 * to vertices separately (see `SyntegrityShape` notes + `topicAtVertex`). This is
 * pure structure and is computed/validated once per shape, never at runtime.
 */
export interface StrutSlot {
  id: StrutId;
  /** The two teams this person is a full participant of. */
  memberOf: [VertexIndex, VertexIndex];
  /** The two teams this person critiques. Disjoint from `memberOf`. */
  criticOf: [VertexIndex, VertexIndex];
}

/**
 * A fully described, validated Syntegrity geometry. Instances live in geometry.ts.
 * Vertices are implicit (0..topicCount-1); topics are mapped onto them by array
 * order at finalization (topics[i] occupies vertex i).
 */
export interface SyntegrityShape {
  name: ShapeName;
  /** edges  == number of participants the shape supports exactly. */
  participantCount: number;
  /** vertices == number of topics. */
  topicCount: number;
  /** vertex degree == members per team == critics per team. */
  teamSize: number;
  /** faces (used later for Face Planning; uniform groups-of-3 only on deltahedra). */
  faceCount: number;
  /** The role slots. `length === participantCount`. */
  struts: StrutSlot[];
  /**
   * Faces expressed as the strut ids on each face, for later Face Planning.
   * Triangular (deltahedron) shapes give length-3 groups; cube / cuboctahedron /
   * icosidodecahedron have square/pentagon faces => non-uniform group sizes.
   */
  faces: StrutId[][];
}

// ─────────────────────────────────────────────────────────────────────────────
// People & topics (produced upstream by steps 1-6)
// ─────────────────────────────────────────────────────────────────────────────

export interface Participant {
  id: ParticipantId;
  name: string;
  avatarUrl?: string;
  discordHandle?: string;
}

/** A winning topic from voting (step 5), bound to a vertex of the shape. */
export interface Topic {
  id: TopicId;
  /** Which vertex/team slot this topic occupies. */
  vertexIndex: VertexIndex;
  title: string;
  /** LLM-generated summary of the participant statements behind this topic. */
  rationale: string;
}

/**
 * Output of step 6 (Topic Preference). Each participant ranks ALL finalized
 * topics most-preferred-first. `rankedTopicIds[0]` is their #1 choice.
 * `length === shape.topicCount`.
 */
export interface TopicPreference {
  participantId: ParticipantId;
  rankedTopicIds: TopicId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Role assignment (step 7) — SHARED contract for BOTH methods
// ─────────────────────────────────────────────────────────────────────────────
//
// The algorithm and the LLM script take the SAME input and return the SAME
// output shape, so the prototype UI can toggle between their graphs freely.

export interface RoleAssignmentInput {
  shape: SyntegrityShape;
  /** length === shape.topicCount, indexed/bound to vertices. */
  topics: Topic[];
  /** length === shape.participantCount. */
  participants: Participant[];
  /** length === shape.participantCount, one per participant. */
  preferences: TopicPreference[];
}

/** The result of assigning one person to one strut, resolved to topic ids. */
export interface ParticipantAssignment {
  participantId: ParticipantId;
  strutId: StrutId;
  /** The two topics this person is a MEMBER of (from strut.memberOf). */
  memberTopicIds: [TopicId, TopicId];
  /** The two topics this person is a CRITIC of (from strut.criticOf). */
  criticTopicIds: [TopicId, TopicId];
}

/** Per-person quality breakdown, used to compare the two methods side by side. */
export interface ParticipantSatisfaction {
  participantId: ParticipantId;
  /** 0-based preference ranks the person got for their 2 MEMBER topics (lower=better). */
  memberRanks: [number, number];
  /** 0-based preference ranks for their 2 CRITIC topics. */
  criticRanks: [number, number];
  /** Normalized 0..1 score (1 == got their two most-preferred topics as member). */
  score: number;
}

export interface AssignmentSatisfaction {
  perParticipant: ParticipantSatisfaction[];
  /** Mean of per-participant scores, 0..1. The headline number for the toggle. */
  average: number;
  /** Sum of member ranks across everyone (lower is better). */
  totalMemberRank: number;
  /** Worst single member-rank anyone was handed (fairness floor). */
  worstMemberRank: number;
  /** How many people got both member topics within their top-`teamSize` picks. */
  happyCount: number;
}

export type AssignmentMethod = 'algorithm' | 'llm';

export interface RoleAssignmentResult {
  method: AssignmentMethod;
  assignments: ParticipantAssignment[];
  satisfaction: AssignmentSatisfaction;
  /** Method-specific extras: solver iterations, or LLM model/tokens/reasoning. */
  meta?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler (step 7) — Outcome Resolve
// ─────────────────────────────────────────────────────────────────────────────
//
// A "team" is a vertex with its members + critics, derived from the assignment.
// Outcome Resolve runs each team through N iterations (default 3). Multiple teams
// may meet at once ONLY if their attendee sets are disjoint — so concurrency is
// computed/validated per shape, not assumed to be 2 (e.g. a tetrahedron forces
// concurrency 1 because every team involves all 6 people).

export interface Team {
  topicId: TopicId;
  vertexIndex: VertexIndex;
  /** length === shape.teamSize. */
  memberParticipantIds: ParticipantId[];
  /** length === shape.teamSize. */
  criticParticipantIds: ParticipantId[];
}

export type SessionRole = 'member' | 'critic';

/** One team meeting (one team, one iteration) placed in a time slot. */
export interface MeetingSession {
  teamTopicId: TopicId;
  vertexIndex: VertexIndex;
  /** 1..iterations. Iteration intent: 1=status quo, 2=ideal/greenfield, 3=actions. */
  iteration: number;
  slotIndex: number;
  attendeeMemberIds: ParticipantId[];
  attendeeCriticIds: ParticipantId[];
}

/** A block of time. Holds up to `concurrency` non-overlapping sessions. */
export interface ScheduleSlot {
  index: number;
  sessions: MeetingSession[];
}

/** A single person's itinerary entry. */
export interface PersonalScheduleItem {
  slotIndex: number;
  teamTopicId: TopicId;
  role: SessionRole;
  iteration: number;
}

export interface PersonalSchedule {
  participantId: ParticipantId;
  items: PersonalScheduleItem[];
  /** Slot indices where this person has no meeting (their "off periods"). */
  offSlots: number[];
}

/**
 * How critics participate in team meetings. Affects scheduling and per-meeting
 * attendee lists. Mirrors the field on `OutcomeResolveStage` in session-formats.ts.
 *
 *  - all-critics-in-room   Beer canon: every critic of T attends T's meeting.
 *                          Critics count as attendees for slot-packing, so
 *                          shapes whose opposite-topic critic sets overlap
 *                          (e.g. octahedron) are forced sequential.
 *  - split-critics-in-room Only members are blocking attendees. After teams
 *                          are packed into a slot, eligible critics are
 *                          distributed across the slot's meetings (each critic
 *                          at most one meeting per slot, balanced across the
 *                          meetings they qualify for).
 *  - async-notes-only      Critics never enter the room. Members only count
 *                          for packing; meeting `attendeeCriticIds` is empty.
 *  - no-critics            Contributors-only meetings (off-protocol). Same
 *                          scheduling effect as async-notes-only.
 */
export type CriticPolicy =
  | 'all-critics-in-room'
  | 'split-critics-in-room'
  | 'async-notes-only'
  | 'no-critics';

export interface SchedulerInput {
  shape: SyntegrityShape;
  assignment: RoleAssignmentResult;
  topics: Topic[];
  participants: Participant[];
  /** Meetings per team. Default 3. */
  iterations?: number;
  /**
   * Max teams meeting at once. If omitted, the scheduler computes the maximum
   * feasible value for the shape. If provided and infeasible, it is clamped.
   */
  concurrency?: number;
  /** Defaults to 'all-critics-in-room' (Beer canon). */
  criticPolicy?: CriticPolicy;
  /**
   * Topic ids to actually schedule. Defaults to every topic in `topics`. Use
   * this to drop the lowest-voted topics (e.g. "run 4 of 6 topics") — the
   * caller chooses which to drop; the scheduler just honors the subset.
   */
  activeTopicIds?: TopicId[];
}

export interface SessionSchedule {
  slots: ScheduleSlot[];
  /** Effective concurrency actually used. */
  concurrency: number;
  iterations: number;
  /** The derived teams, for the "full schedule" panel. */
  teams: Team[];
  /** Per-person itineraries, for the "your schedule" panel. */
  perParticipant: PersonalSchedule[];
  /** Validation problems found (should be empty for a good schedule). */
  conflicts: ScheduleConflict[];
}

export interface ScheduleConflict {
  kind: 'double-booked' | 'missing-iteration' | 'oversubscribed-slot';
  slotIndex: number;
  participantId?: ParticipantId;
  detail: string;
}
