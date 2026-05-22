/**
 * 3D vertex coordinates for the encoded shapes (shared — used by the three.js
 * PolyhedronScene in the lobby and syntegrity-graph views). Same coordinates the
 * dev generator used to derive the strut tables, so vertex indices line up
 * exactly with StrutSlot.memberOf / criticOf.
 *
 * Coordinates are returned normalized to a unit-ish radius so the camera setup
 * can stay constant across shapes.
 */
import type { ShapeName } from './types';

export type Vec3 = [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

const RAW: Partial<Record<ShapeName, Vec3[]>> = {
  tetrahedron: [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ],
  octahedron: [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  icosahedron: [
    [0, 1, PHI],
    [0, 1, -PHI],
    [0, -1, PHI],
    [0, -1, -PHI],
    [1, PHI, 0],
    [1, -PHI, 0],
    [-1, PHI, 0],
    [-1, -PHI, 0],
    [PHI, 0, 1],
    [PHI, 0, -1],
    [-PHI, 0, 1],
    [-PHI, 0, -1],
  ],
};

function normalize(verts: Vec3[]): Vec3[] {
  const max = Math.max(...verts.map((v) => Math.hypot(v[0], v[1], v[2])));
  return verts.map(([x, y, z]) => [x / max, y / max, z / max] as Vec3);
}

/** Unit-radius vertex positions for a shape, indexed to match its strut table. */
export function vertexPositions(name: ShapeName): Vec3[] {
  const raw = RAW[name];
  if (!raw) throw new Error(`No 3D coordinates for shape "${name}".`);
  return normalize(raw);
}

/** Midpoint of an edge between two vertex indices (where an avatar sits). */
export function edgeMidpoint(positions: Vec3[], a: number, b: number): Vec3 {
  return [
    (positions[a][0] + positions[b][0]) / 2,
    (positions[a][1] + positions[b][1]) / 2,
    (positions[a][2] + positions[b][2]) / 2,
  ];
}
