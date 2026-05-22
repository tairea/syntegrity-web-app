/**
 * Generator (dev-only) for deltahedron strut tables. NOT imported by the app.
 * Run: `npx tsx src/util/_generate-shapes.ts` -> prints validated TS literals to
 * paste into geometry.ts. Re-runnable; deterministic ordering.
 *
 * Critic rule (deltahedra only): a strut critiques the two vertices that, with
 * its two endpoints, form the two triangular faces sharing that edge — i.e. the
 * two common neighbours of the edge's endpoints. This yields exactly teamSize
 * critics per team and is the same rule the hand-encoded tetrahedron follows.
 */

type V3 = [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;
const EPS = 1e-6;

const OCTAHEDRON: V3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

const ICOSAHEDRON: V3[] = [
  [0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI],
  [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0],
  [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1],
];

function dist2(a: V3, b: V3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

interface Generated {
  struts: { id: number; memberOf: [number, number]; criticOf: [number, number] }[];
  faces: number[][];
}

function generate(verts: V3[]): Generated {
  const n = verts.length;

  // Minimum positive squared distance = edge length.
  let min = Infinity;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) min = Math.min(min, dist2(verts[i], verts[j]));

  // Adjacency + edge list (sorted endpoints, lexicographic order => deterministic).
  const adj: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Math.abs(dist2(verts[i], verts[j]) - min) < EPS) {
        adj[i][j] = adj[j][i] = true;
        edges.push([i, j]);
      }

  const edgeId = new Map<string, number>();
  edges.forEach(([a, b], id) => edgeId.set(`${a}-${b}`, id));
  const idOf = (a: number, b: number) => edgeId.get(`${Math.min(a, b)}-${Math.max(a, b)}`)!;

  // Critics: common neighbours of the two endpoints (the two triangle apexes).
  const struts = edges.map(([a, b], id) => {
    const common: number[] = [];
    for (let w = 0; w < n; w++) if (adj[a][w] && adj[b][w]) common.push(w);
    if (common.length !== 2) throw new Error(`edge ${a}-${b} has ${common.length} common neighbours (deltahedron expected 2)`);
    return { id, memberOf: [a, b] as [number, number], criticOf: [common[0], common[1]] as [number, number] };
  });

  // Triangular faces (i<j<k all mutually adjacent), expressed as strut-id triples.
  const faces: number[][] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        if (adj[i][j] && adj[j][k] && adj[i][k]) faces.push([idOf(i, j), idOf(j, k), idOf(i, k)]);

  return { struts, faces };
}

// Inlined validator (mirrors geometry.validateShape) so generation self-checks.
function validate(g: Generated, topicCount: number, teamSize: number): string[] {
  const errors: string[] = [];
  const m = new Array(topicCount).fill(0);
  const c = new Array(topicCount).fill(0);
  for (const s of g.struts) {
    if (new Set(s.memberOf).size !== 2) errors.push(`strut ${s.id} bad memberOf`);
    if (new Set(s.criticOf).size !== 2) errors.push(`strut ${s.id} bad criticOf`);
    if (s.criticOf.some((v) => s.memberOf.includes(v))) errors.push(`strut ${s.id} critiques own team`);
    s.memberOf.forEach((v) => m[v]++);
    s.criticOf.forEach((v) => c[v]++);
  }
  for (let v = 0; v < topicCount; v++) {
    if (m[v] !== teamSize) errors.push(`vertex ${v}: ${m[v]} members != ${teamSize}`);
    if (c[v] !== teamSize) errors.push(`vertex ${v}: ${c[v]} critics != ${teamSize}`);
  }
  return errors;
}

function emit(name: string, g: Generated): string {
  const struts = g.struts
    .map((s) => `  { id: ${s.id}, memberOf: [${s.memberOf.join(', ')}], criticOf: [${s.criticOf.join(', ')}] },`)
    .join('\n');
  const faces = g.faces.map((f) => `[${f.join(', ')}]`).join(', ');
  return `// ${name}: ${g.struts.length} struts, ${g.faces.length} faces (generated + validated)\nconst ${name}_STRUTS: StrutSlot[] = [\n${struts}\n];\nconst ${name}_FACES: number[][] = [${faces}];`;
}

for (const [name, verts, topics, team] of [
  ['OCTAHEDRON', OCTAHEDRON, 6, 4],
  ['ICOSAHEDRON', ICOSAHEDRON, 12, 5],
] as const) {
  const g = generate(verts);
  const errs = validate(g, topics, team);
  console.log(`\n=== ${name} === struts=${g.struts.length} faces=${g.faces.length} valid=${errs.length === 0}`);
  if (errs.length) console.log(errs);
  console.log(emit(name, g));
}
