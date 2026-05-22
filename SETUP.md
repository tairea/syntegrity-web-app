# Syntegrity Web App — Setup

A Vue 3 + Vite + Supabase prototype of Stafford Beer's Team Syntegrity process.
The 7 process steps map to numbered views (`src/views/N-Name.vue`); shared
infrastructure has no number prefix. The compute layer (geometry, role
assignment, scheduler, LLM transport) lives in `src/util/`.

## 1. Environment

Copy `.env.example` to `.env` and fill in:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_OPENROUTER_API_KEY=...   # used for clustering, merges, role-assignment LLM, bots
```

> ⚠️ `VITE_`-prefixed vars are bundled into client code (public). Fine for local
> prototyping; move LLM calls behind a Supabase Edge Function before deploying.

## 2. Database

Run `supabase/schema.sql` in the Supabase SQL editor. It creates all tables,
adds them to the realtime publication, applies **permissive** prototype RLS
(anon read/write — harden before production), and creates the public `avatars`
storage bucket. **The app will not function until this is applied.**

## 3. Run

```
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks (vue-tsc) + production build
```

## Flow

1. **Initiate** — start a session (set the driving question) or join by code.
2. **Profile** — name, avatar, discord handle (anonymous identity, no login).
3. **Lobby** — rotating 3D shape that snaps to the nearest encoded shape
   (6 → tetrahedron, 12 → octahedron, 30 → icosahedron) by headcount. Enter
   Problem Jostle whenever you like.
4. **Problem Jostle** — post statements (chips with d3-force clustering),
   per-cluster chat, mark Ready. At >50% ready the roster locks; if the count
   isn't 6/12/30 a reconciliation vote offers **trim** vs **pad with bots**.
5. **Voting** — 5 sticker votes each; drag a card onto another to propose a
   timed merge.
6. **Topic Preference** — drag to rank the winning topics; Save when ready.
7. **Syntegrity Graph** — toggle between the **algorithm** and **LLM** role
   assignments; click a person/topic to focus; "show critique" flips to critic
   relationships (red edges); the schedule panel shows personal + full Outcome
   Resolve timetables.

Phases auto-advance with a 5→1 countdown once everyone is ready. One client (the
session creator, else the lowest-id present human) is the **driver** that
performs phase transitions, reconciliation, and bot actions.

## Notes / TODO
- Only 3 shapes are encoded (6/12/30). Cube/cuboctahedron/icosidodecahedron
  need a non-deltahedron critic rule before they can be added.
- Dev scripts: `npx tsx src/util/7-demo-tetrahedron.ts`, `npx tsx src/util/_generate-shapes.ts`.
