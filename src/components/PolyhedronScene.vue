<script setup lang="ts">
/**
 * Shared 3D polyhedron renderer — fully native three.js (no CSS2D/DOM overlay).
 *
 * Everything lives in ONE WebGL scene: vertex topic labels and edge participant
 * avatars are billboarded sprites drawn from canvas textures, so they share the
 * 3D space (depth-sorted, occlude correctly, rotate naturally) with no DOM↔3D
 * sync to manage. Clicks are handled by a single raycaster. Used by the Lobby
 * (vacant struts empty, auto-rotating) and the Syntegrity Graph (struts filled
 * from an assignment, with focus + critique modes).
 *
 * Canvas-texture sprites (not troika) keep this dependency-free and mobile-safe:
 * it needs only WebGL, which the scene already requires.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as THREE from 'three';
import { edgeMidpoint, getShape, vertexPositions, type ShapeName } from '@/util';

export interface SceneNode {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isBot?: boolean;
  color?: string;
}
export type FocusTarget = { type: 'person' | 'topic'; id: string } | null;

const props = withDefaults(
  defineProps<{
    shapeName: ShapeName | null;
    edgeNodes: (SceneNode | null)[];
    vertexLabels: string[];
    rotate?: boolean;
    focus?: FocusTarget;
    critique?: boolean;
  }>(),
  { rotate: true, focus: null, critique: false },
);

const emit = defineEmits<{
  (e: 'select-person', id: string): void;
  (e: 'select-topic', vertexIndex: number): void;
}>();

const host = ref<HTMLDivElement | null>(null);

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let group: THREE.Group | null = null;
let raf = 0;
let ro: ResizeObserver | null = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const NORMAL = new THREE.Color('#6c7a96');
const RED = new THREE.Color('#e06c75');

// Local (unrotated) vertex positions, kept so highlights can re-cut struts and
// the focus animation can compute a target orientation.
let localVerts: THREE.Vector3[] = [];
// When a focus is active, the group eases toward this orientation so the clicked
// element sits centred (facing the camera) with its connections horizontal.
let focusQuat: THREE.Quaternion | null = null;
// Set when the user drags during a focus — suspends auto-centring so their
// manual rotation isn't fought by the slerp.
let userAdjusted = false;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Per-element handles for highlight updates + disposal.
interface LineEntry { line: THREE.Line; strutId: number }
interface SpriteEntry { sprite: THREE.Sprite; kind: 'vertexLabel' | 'avatar' | 'name'; index: number }
let lineEntries: LineEntry[] = [];
let spriteEntries: SpriteEntry[] = [];
// Red lines drawn in critique mode. A critic relationship is NOT a physical edge
// of the solid (a strut critiques two vertices it doesn't touch), so we draw it
// as a dedicated line from the focused element to each critique target. Rebuilt
// on every applyHighlights and torn down when leaving critique/focus.
let relLines: THREE.Line[] = [];
const disposables: { dispose(): void }[] = []; // permanent: vertex labels + lines
let nodeDisposables: { dispose(): void }[] = []; // per-participant avatars + names

// ── canvas-texture helpers ─────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface LabelOpts { fontSize?: number; color?: string; bg?: string; border?: string }
function makeLabelSprite(text: string, opts: LabelOpts = {}, track: { dispose(): void }[] = disposables): { sprite: THREE.Sprite; aspect: number } {
  const { fontSize = 48, color = '#e6ecff', bg = 'rgba(20,24,38,0.9)', border = '#313a59' } = opts;
  const pad = 18;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text || ' ').width) + pad * 2;
  const h = fontSize + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.fillStyle = bg;
  roundRect(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = border;
  roundRect(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  track.push(tex, mat);
  return { sprite, aspect: w / h };
}

function makeAvatarSprite(node: SceneNode, track: { dispose(): void }[] = disposables): THREE.Sprite {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const ring = () => {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#8a94b0'; // minimal light border, no colour fill
    ctx.stroke();
  };
  // base: neutral dark disc + initial (also the fallback if the image fails)
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = node.color ?? '#222a3d';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e6ecff';
  ctx.font = 'bold 120px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((node.name?.[0] ?? '?').toUpperCase(), size / 2, size / 2);
  ctx.restore();
  ring();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (node.avatarUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
      ctx.clip();
      const s = Math.max(size / img.width, size / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
      ctx.restore();
      ring();
      tex.needsUpdate = true;
    };
    img.onerror = () => {}; // keep colored-initial fallback
    img.src = node.avatarUrl;
  }
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  track.push(tex, mat);
  return sprite;
}

// ── build / clear ───────────────────────────────────────────────────────────
function clearRelLines() {
  for (const l of relLines) {
    group?.remove(l);
    l.geometry.dispose();
    (l.material as THREE.Material).dispose();
  }
  relLines = [];
}

function clearGroup() {
  clearRelLines();
  if (group && scene) scene.remove(group);
  group?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
  for (const d of disposables) d.dispose();
  for (const d of nodeDisposables) d.dispose();
  disposables.length = 0;
  nodeDisposables = [];
  lineEntries = [];
  spriteEntries = [];
  group = null;
}

/** Remove just the participant avatars/names (keep vertices + lines). */
function clearNodes() {
  for (const e of spriteEntries) {
    if (e.kind === 'vertexLabel') continue;
    group?.remove(e.sprite);
  }
  spriteEntries = spriteEntries.filter((e) => e.kind === 'vertexLabel');
  for (const d of nodeDisposables) d.dispose();
  nodeDisposables = [];
}

/** (Re)build participant avatars + name labels at strut midpoints. */
function buildNodes() {
  if (!group || !props.shapeName) return;
  const shape = getShape(props.shapeName);
  const verts = vertexPositions(props.shapeName) as [number, number, number][];
  shape.struts.forEach((strut, sid) => {
    const node = props.edgeNodes[sid] ?? null;
    const [mx, my, mz] = edgeMidpoint(verts, strut.memberOf[0], strut.memberOf[1]);
    // Filled struts show the participant; empty struts show a "?" placeholder.
    const avatar = makeAvatarSprite(node ?? { id: `vacant-${sid}`, name: '?', color: '#39414f' }, nodeDisposables);
    avatar.scale.set(0.1, 0.1, 1);
    avatar.position.set(mx, my, mz);
    if (node) avatar.userData = { clickable: true, type: 'person', id: node.id };
    spriteEntries.push({ sprite: avatar, kind: 'avatar', index: sid });
    group!.add(avatar);
    if (node) {
      const { sprite: nameSprite, aspect } = makeLabelSprite(node.name, { fontSize: 40, bg: 'rgba(12,15,24,0.0)', border: 'rgba(0,0,0,0)' }, nodeDisposables);
      const nh = 0.07;
      nameSprite.scale.set(nh * aspect, nh, 1);
      nameSprite.position.set(mx, my - 0.09, mz);
      spriteEntries.push({ sprite: nameSprite, kind: 'name', index: sid });
      group!.add(nameSprite);
    }
  });
}

/** Full build (geometry + nodes). Preserves rotation so even a shape roll-up
 *  (6→12→30) keeps spinning rather than snapping back to zero. */
function build() {
  if (!scene) return;
  const prevRot = group ? { x: group.rotation.x, y: group.rotation.y } : null;
  clearGroup();
  group = new THREE.Group();
  if (prevRot) { group.rotation.x = prevRot.x; group.rotation.y = prevRot.y; }
  scene.add(group);
  if (!props.shapeName) return;

  const pos = vertexPositions(props.shapeName).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  localVerts = pos;

  // Vertices: the topic box IS the node — placed directly at the vertex.
  pos.forEach((v, i) => {
    const label = props.vertexLabels[i] ?? `Topic ${i + 1}`;
    const { sprite, aspect } = makeLabelSprite(label, { fontSize: 44 });
    const hgt = 0.105;
    sprite.scale.set(hgt * aspect, hgt, 1);
    sprite.position.copy(v);
    sprite.userData = { clickable: true, type: 'topic', index: i };
    spriteEntries.push({ sprite, kind: 'vertexLabel', index: i });
    group!.add(sprite);
  });

  // Struts: static lines.
  getShape(props.shapeName).struts.forEach((strut, sid) => {
    const geo = new THREE.BufferGeometry().setFromPoints([pos[strut.memberOf[0]], pos[strut.memberOf[1]]]);
    const mat = new THREE.LineBasicMaterial({ color: NORMAL.clone(), transparent: true });
    const line = new THREE.Line(geo, mat);
    disposables.push(geo, mat);
    group!.add(line);
    lineEntries.push({ line, strutId: sid });
  });

  buildNodes();
  applyHighlights();
}

/** Refresh only the participant sprites — keeps geometry, lines and the current
 *  rotation intact so adding a member doesn't reset the spinning graph. */
function updateNodes() {
  if (!group) { build(); return; }
  clearNodes();
  buildNodes();
  applyHighlights();
}

// ── highlight / focus / critique ─────────────────────────────────────────────
function applyHighlights() {
  if (!props.shapeName) return;
  const shape = getShape(props.shapeName);
  const focus = props.focus;
  const critique = props.critique;

  const litVertices = new Set<number>();
  const litStruts = new Set<number>();

  if (!focus) {
    shape.struts.forEach((_, i) => litStruts.add(i));
    shape.struts.forEach((s) => s.memberOf.forEach((v) => litVertices.add(v)));
  } else if (focus.type === 'topic') {
    const v = Number(focus.id);
    litVertices.add(v);
    shape.struts.forEach((s, sid) => {
      if ((critique ? s.criticOf : s.memberOf).includes(v)) litStruts.add(sid);
    });
  } else {
    const sid = shape.struts.findIndex((_, i) => props.edgeNodes[i]?.id === focus.id);
    if (sid >= 0) {
      litStruts.add(sid);
      (critique ? shape.struts[sid].criticOf : shape.struts[sid].memberOf).forEach((v) => litVertices.add(v));
    }
  }

  // In critique mode the meaning is carried by the red relationship lines, so the
  // physical struts fade right back out of the way.
  const critiqueFocus = !!focus && critique;
  clearRelLines();

  for (const { line, strutId } of lineEntries) {
    const lit = litStruts.has(strutId);
    const mat = line.material as THREE.LineBasicMaterial;
    const s = shape.struts[strutId];
    mat.color.copy(NORMAL);
    mat.opacity = critiqueFocus ? 0.05 : focus ? (lit ? 1 : 0.08) : 0.6;

    if (localVerts.length) {
      // Normal (member) topic focus: cut the lit strut at the person (midpoint)
      // so the line stops at the avatar rather than running on to the dimmed
      // far topic. Everything else (incl. critique mode) keeps the full edge.
      if (!critiqueFocus && focus && focus.type === 'topic' && lit) {
        const v = Number(focus.id);
        const other = s.memberOf[0] === v ? s.memberOf[1] : s.memberOf[0];
        const mid = localVerts[v].clone().add(localVerts[other]).multiplyScalar(0.5);
        line.geometry.setFromPoints([localVerts[v], mid]);
      } else {
        line.geometry.setFromPoints([localVerts[s.memberOf[0]], localVerts[s.memberOf[1]]]);
      }
    }
  }

  // Critique relationship lines: from the focused topic out to each of its critic
  // people's avatars, or from a focused person out to each topic they critique.
  if (critiqueFocus && localVerts.length && group) {
    const midOf = (sid: number) => {
      const st = shape.struts[sid];
      return localVerts[st.memberOf[0]].clone().add(localVerts[st.memberOf[1]]).multiplyScalar(0.5);
    };
    const addRel = (a: THREE.Vector3, b: THREE.Vector3) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      const m = new THREE.LineBasicMaterial({ color: RED.clone(), transparent: true, opacity: 0.95 });
      const l = new THREE.Line(geo, m);
      group!.add(l);
      relLines.push(l);
    };
    if (focus!.type === 'topic') {
      const v = Number(focus!.id);
      shape.struts.forEach((st, sid) => {
        if (st.criticOf.includes(v)) addRel(localVerts[v], midOf(sid));
      });
    } else {
      const sid = shape.struts.findIndex((_, i) => props.edgeNodes[i]?.id === focus!.id);
      if (sid >= 0) {
        const personMid = midOf(sid);
        for (const v of shape.struts[sid].criticOf) addRel(personMid, localVerts[v]);
      }
    }
  }

  for (const { sprite, kind, index } of spriteEntries) {
    const lit = kind === 'vertexLabel' ? litVertices.has(index) : litStruts.has(index);
    (sprite.material as THREE.SpriteMaterial).opacity = !focus ? 1 : lit ? 1 : 0.1;
  }
}

/** Target orientation that brings the focused element to the centre, facing the
 *  camera (world +Z). For a person, the strut's two topics are also laid out
 *  horizontally — topic on the left (−X), topic on the right (+X), person between
 *  them. Returns null when there's no focus or geometry isn't built yet. */
function computeFocusQuat(): THREE.Quaternion | null {
  const f = props.focus;
  if (!f || !props.shapeName || !localVerts.length) return null;
  const shape = getShape(props.shapeName);

  if (f.type === 'topic') {
    const v = Number(f.id);
    if (!localVerts[v]) return null;
    const dir = localVerts[v].clone().normalize();
    return new THREE.Quaternion().setFromUnitVectors(dir, Z_AXIS);
  }

  // person: orient so the strut midpoint faces the camera and the edge is level.
  const sid = shape.struts.findIndex((_, i) => props.edgeNodes[i]?.id === f.id);
  if (sid < 0) return null;
  const s = shape.struts[sid];
  const v0 = localVerts[s.memberOf[0]];
  const v1 = localVerts[s.memberOf[1]];
  const mid = v0.clone().add(v1).multiplyScalar(0.5).normalize();
  const edge = v1.clone().sub(v0).normalize();
  // Step 1: midpoint → camera. Step 2: spin about that axis so the edge is horizontal.
  const q1 = new THREE.Quaternion().setFromUnitVectors(mid, Z_AXIS);
  const e1 = edge.applyQuaternion(q1).normalize();
  const q2 = new THREE.Quaternion().setFromUnitVectors(e1, X_AXIS);
  return q2.multiply(q1);
}

// ── drag-to-rotate + click (raycast) ─────────────────────────────────────────
let dragging = false;
let moved = false;
let lastX = 0;
let lastY = 0;
function onPointerDown(e: PointerEvent) {
  dragging = true;
  moved = false;
  lastX = e.clientX;
  lastY = e.clientY;
}
function onPointerMove(e: PointerEvent) {
  if (!dragging || !group) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; if (props.focus) userAdjusted = true; }
  lastX = e.clientX;
  lastY = e.clientY;
  group.rotation.y += dx * 0.006;
  group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x + dy * 0.006));
}
function onPointerUp(e: PointerEvent) {
  const wasDrag = moved;
  dragging = false;
  if (wasDrag || !renderer || !camera || !group) return;
  // treat as a click → raycast
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(group.children, false);
  for (const hit of hits) {
    const ud = hit.object.userData as { clickable?: boolean; type?: string; index?: number; id?: string };
    if (!ud?.clickable) continue;
    if (ud.type === 'person' && ud.id) emit('select-person', ud.id);
    else if (ud.type === 'topic' && ud.index !== undefined) emit('select-topic', ud.index);
    break;
  }
}

function resize() {
  if (!host.value || !renderer || !camera) return;
  const { clientWidth: w, clientHeight: h } = host.value;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

function animate() {
  raf = requestAnimationFrame(animate);
  if (group) {
    if (focusQuat && !dragging && !userAdjusted) {
      // Ease toward the centred orientation; near-identical slerp snaps cheaply.
      group.quaternion.slerp(focusQuat, 0.12);
    } else if (props.rotate && !props.focus && !dragging) {
      group.rotation.y += 0.003;
    }
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

onMounted(() => {
  if (!host.value) return;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 3.2);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.style.cursor = 'grab';
  host.value.appendChild(renderer.domElement);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  syncScene();
  resize();
  ro = new ResizeObserver(resize);
  ro.observe(host.value);
  animate();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  ro?.disconnect();
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  clearGroup();
  renderer?.dispose();
  if (host.value) host.value.innerHTML = '';
});

// Full rebuild only when the geometry (shape) or topic labels change; adding or
// removing a participant just refreshes the avatars in place — no rotation reset.
let builtKey = '';
function syncScene() {
  const key = (props.shapeName ?? 'none') + '|' + props.vertexLabels.join('');
  if (key !== builtKey) { build(); builtKey = key; }
  else updateNodes();
}
watch(() => [props.shapeName, props.edgeNodes, props.vertexLabels], syncScene, { deep: true });
watch(
  () => [props.focus, props.critique],
  () => {
    focusQuat = computeFocusQuat();
    userAdjusted = false;
    applyHighlights();
  },
  { deep: true },
);
</script>

<template>
  <div ref="host" class="scene-host"></div>
</template>

<style scoped>
.scene-host { position: relative; width: 100%; height: 100%; overflow: hidden; }
</style>
