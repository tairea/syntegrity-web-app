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

// Per-element handles for highlight updates + disposal.
interface LineEntry { line: THREE.Line; strutId: number }
interface SpriteEntry { sprite: THREE.Sprite; kind: 'vertexLabel' | 'avatar' | 'name'; index: number }
let lineEntries: LineEntry[] = [];
let spriteEntries: SpriteEntry[] = [];
const disposables: { dispose(): void }[] = [];

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
function makeLabelSprite(text: string, opts: LabelOpts = {}): { sprite: THREE.Sprite; aspect: number } {
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
  disposables.push(tex, mat);
  return { sprite, aspect: w / h };
}

function makeAvatarSprite(node: SceneNode): THREE.Sprite {
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
  disposables.push(tex, mat);
  return sprite;
}

// ── build / clear ───────────────────────────────────────────────────────────
function clearGroup() {
  if (group && scene) scene.remove(group);
  group?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
  for (const d of disposables) d.dispose();
  disposables.length = 0;
  lineEntries = [];
  spriteEntries = [];
  group = null;
}

function build() {
  if (!scene) return;
  clearGroup();
  group = new THREE.Group();
  scene.add(group);
  if (!props.shapeName) return;

  const shape = getShape(props.shapeName);
  const pos = vertexPositions(props.shapeName).map(([x, y, z]) => new THREE.Vector3(x, y, z));

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

  // Struts: line + (optional) avatar + name at midpoint.
  shape.struts.forEach((strut, sid) => {
    const a = pos[strut.memberOf[0]];
    const b = pos[strut.memberOf[1]];
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: NORMAL.clone(), transparent: true });
    const line = new THREE.Line(geo, mat);
    disposables.push(geo, mat);
    group!.add(line);
    lineEntries.push({ line, strutId: sid });

    const node = props.edgeNodes[sid] ?? null;
    const [mx, my, mz] = edgeMidpoint(pos.map((p) => [p.x, p.y, p.z]) as [number, number, number][], strut.memberOf[0], strut.memberOf[1]);

    // Filled struts show the participant; empty struts show a "?" placeholder.
    const avatar = makeAvatarSprite(node ?? { id: `vacant-${sid}`, name: '?', color: '#39414f' });
    avatar.scale.set(0.1, 0.1, 1); // person circles ~half their old size
    avatar.position.set(mx, my, mz);
    if (node) avatar.userData = { clickable: true, type: 'person', id: node.id };
    spriteEntries.push({ sprite: avatar, kind: 'avatar', index: sid });
    group!.add(avatar);

    if (node) {
      const { sprite: nameSprite, aspect } = makeLabelSprite(node.name, { fontSize: 40, bg: 'rgba(12,15,24,0.0)', border: 'rgba(0,0,0,0)' });
      const nh = 0.07;
      nameSprite.scale.set(nh * aspect, nh, 1);
      nameSprite.position.set(mx, my - 0.09, mz);
      spriteEntries.push({ sprite: nameSprite, kind: 'name', index: sid });
      group!.add(nameSprite);
    }
  });

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

  for (const { line, strutId } of lineEntries) {
    const lit = litStruts.has(strutId);
    const mat = line.material as THREE.LineBasicMaterial;
    mat.color.copy(critique && lit ? RED : NORMAL);
    mat.opacity = focus ? (lit ? 1 : 0.08) : 0.6;
  }
  for (const { sprite, kind, index } of spriteEntries) {
    const lit = kind === 'vertexLabel' ? litVertices.has(index) : litStruts.has(index);
    (sprite.material as THREE.SpriteMaterial).opacity = !focus ? 1 : lit ? 1 : 0.1;
  }
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
  if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
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
  if (group && props.rotate && !props.focus && !dragging) group.rotation.y += 0.003;
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

  build();
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

watch(() => [props.shapeName, props.edgeNodes, props.vertexLabels], build, { deep: true });
watch(() => [props.focus, props.critique], applyHighlights, { deep: true });
</script>

<template>
  <div ref="host" class="scene-host"></div>
</template>

<style scoped>
.scene-host { position: relative; width: 100%; height: 100%; overflow: hidden; }
</style>
