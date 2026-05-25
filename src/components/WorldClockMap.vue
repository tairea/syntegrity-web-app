<script setup lang="ts">
/**
 * Equirectangular world map with day/night terminator and city labels showing
 * the equivalent local time at the chosen source instant.
 *
 * Vue 3 port of the world-clock prototype's TimezoneStrip.tsx, restyled to
 * the Syntegrity palette (blue accent instead of cyan, dark navy ocean).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { geoEquirectangular, geoPath } from 'd3-geo';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import worldTopo from 'world-atlas/countries-110m.json';
import { CITIES } from '@/util/world-clock-cities';
import {
  formatTimeInZone, getZoneOffsetMinutes, subsolarPoint,
} from '@/util/world-clock';

const props = defineProps<{ baseUtc: Date; sourceZone: string }>();

// Centre the map a few degrees east so Avarua (~−160°) hugs the left edge
// and Auckland (~+175°) breathes on the right.
const CENTER_LON = 10;

const container = ref<HTMLDivElement | null>(null);
const width = ref(1024);
let ro: ResizeObserver | null = null;

onMounted(() => {
  const el = container.value;
  if (!el) return;
  ro = new ResizeObserver(() => {
    const w = Math.max(320, Math.floor(el.getBoundingClientRect().width));
    width.value = w;
  });
  ro.observe(el);
});
onBeforeUnmount(() => { ro?.disconnect(); ro = null; });

const height = computed(() => Math.round(width.value / 2));

const land = computed<FeatureCollection<Geometry>>(() => {
  const topo = worldTopo as unknown as Topology;
  const obj = topo.objects.countries as GeometryCollection;
  return feature(topo, obj) as FeatureCollection<Geometry>;
});

const project = computed(() =>
  geoEquirectangular()
    .scale(width.value / (2 * Math.PI))
    .translate([width.value / 2, height.value / 2])
    .rotate([-CENTER_LON, 0, 0]),
);
const pathGen = computed(() => geoPath(project.value));

const countryPaths = computed(() =>
  (land.value.features as Feature<Geometry>[])
    .map((f, i) => ({ id: i, d: pathGen.value(f) }))
    .filter((p): p is { id: number; d: string } => !!p.d),
);

const sub = computed(() => subsolarPoint(props.baseUtc));
const nightPath = computed(() => buildNightPath(sub.value, width.value, height.value));

const sourceCity = computed(() => CITIES.find((c) => c.tz === props.sourceZone));

const visibleCities = computed(() => {
  const minDx = Math.max(70, Math.round(width.value * 0.08));
  const minDy = 30;
  const ordered = [...CITIES].sort((a, b) => {
    if (a.tz === props.sourceZone) return -1;
    if (b.tz === props.sourceZone) return 1;
    return 0;
  });
  const kept: { c: typeof CITIES[number]; x: number; y: number }[] = [];
  for (const c of ordered) {
    const xy = project.value([c.lng, c.lat]);
    if (!xy) continue;
    const [x, y] = xy;
    const crowded = kept.some((k) => Math.abs(k.x - x) < minDx && Math.abs(k.y - y) < minDy);
    if (crowded) continue;
    kept.push({ c, x, y });
  }
  return kept;
});

const sourceX = computed(() => {
  const lon = sourceCity.value?.lng ?? 0;
  const xy = project.value([lon, 0]);
  return xy ? xy[0] : 0;
});

const ticks = computed(() => {
  const out: { x: number; label: string; lon: number }[] = [];
  for (let h = -12; h <= 12; h += 1) {
    const lon = h * 15;
    const xy = project.value([lon, 0]);
    if (!xy) continue;
    const sign = h >= 0 ? '+' : '−';
    out.push({ x: xy[0], label: `${sign}${Math.abs(h)}`, lon });
  }
  return out.sort((a, b) => a.x - b.x);
});

const sourceOffset = computed(() => getZoneOffsetMinutes(props.baseUtc, props.sourceZone));
const sourceOffsetLabel = computed(() => {
  const m = sourceOffset.value;
  const sign = m >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(m) / 60);
  const rem = Math.abs(m) % 60;
  return rem === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(rem).padStart(2, '0')}`;
});

const subPos = computed(() => {
  const xy = project.value([sub.value.lon, sub.value.lat]);
  return xy ? { x: xy[0], y: xy[1] } : null;
});

/**
 * Build a closed SVG path covering the night hemisphere. Uses a custom
 * equirectangular projection (no antimeridian clipping) so the polygon spans
 * the full visible map width — d3's clip wraps any point past the rotated
 * antimeridian back to the left edge, which would collapse the polar-close
 * points to (0, H) and shade the wrong half of the map.
 */
function buildNightPath(
  s: { lon: number; lat: number },
  width: number,
  height: number,
): string {
  const declRaw = s.lat;
  const decl = Math.abs(declRaw) < 0.5 ? (declRaw >= 0 ? 0.5 : -0.5) : declRaw;
  const declRad = (decl * Math.PI) / 180;

  const project = (lon: number, lat: number): [number, number] => {
    let dLon = lon - CENTER_LON;
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    return [
      ((dLon + 180) / 360) * width,
      ((90 - lat) / 180) * height,
    ];
  };

  const pts: [number, number][] = [];
  for (let dLon = -180; dLon <= 180; dLon += 1) {
    const lon = CENTER_LON + dLon;
    const lonRel = ((lon - s.lon) * Math.PI) / 180;
    const lat = (Math.atan(-Math.cos(lonRel) / Math.tan(declRad)) * 180) / Math.PI;
    pts.push(project(lon, lat));
  }

  // Close around the polar night cap. For decl > 0 (sun in N) the dark
  // hemisphere wraps the South Pole → close along the bottom edge. For
  // decl < 0, close along the top edge instead.
  const polarY = decl > 0 ? height : 0;
  pts.push([width, polarY]);
  pts.push([0, polarY]);

  return 'M ' + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' L ') + ' Z';
}

function cityFontSize(isSource: boolean): number { return isSource ? 16 : 13; }
function cityTimeFontSize(isSource: boolean): number { return isSource ? 14 : 12; }
</script>

<template>
  <div ref="container" class="map-host">
    <svg :width="width" :height="height" class="map-svg">
      <defs>
        <linearGradient id="syn-seaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0e1a32" />
          <stop offset="100%" stop-color="#070d1c" />
        </linearGradient>
        <linearGradient id="syn-dayWash" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(122, 160, 255, 0.05)" />
          <stop offset="100%" stop-color="rgba(122, 160, 255, 0)" />
        </linearGradient>
        <filter id="syn-terminatorBlur" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>

      <!-- Ocean -->
      <rect :x="0" :y="0" :width="width" :height="height" fill="url(#syn-seaGrad)" />

      <!-- Subtle hour grid -->
      <line v-for="t in ticks" :key="`grid-${t.label}`"
            :x1="t.x" :x2="t.x" :y1="0" :y2="height"
            stroke="rgba(255,255,255,0.04)" stroke-width="1" />

      <!-- Day wash -->
      <rect :x="0" :y="0" :width="width" :height="height" fill="url(#syn-dayWash)" />

      <!-- Countries -->
      <g>
        <path v-for="p in countryPaths" :key="p.id" :d="p.d"
              fill="#2a3450" stroke="rgba(122,160,255,0.35)" stroke-width="0.4" />
      </g>

      <!-- Night overlay -->
      <path :d="nightPath" fill="rgba(2,4,10,0.62)"
            stroke="rgba(120,160,255,0.45)" stroke-width="1"
            filter="url(#syn-terminatorBlur)" />

      <!-- Source-zone vertical highlight -->
      <line :x1="sourceX" :x2="sourceX" :y1="0" :y2="height"
            stroke="#7aa2ff" stroke-width="1.5" stroke-dasharray="3 4" />
      <rect :x="Math.max(0, sourceX - 10)" :y="0" :width="20" :height="height"
            fill="rgba(122, 160, 255, 0.07)" />

      <!-- Cities -->
      <g v-for="entry in visibleCities" :key="entry.c.name"
         :transform="`translate(${entry.x},${entry.y})`">
        <circle :r="entry.c.tz === sourceZone ? 6 : 3.5"
                :fill="entry.c.tz === sourceZone ? '#7aa2ff' : '#fde68a'"
                :stroke="entry.c.tz === sourceZone ? 'rgba(122,160,255,0.45)' : 'rgba(253,230,138,0.4)'"
                :stroke-width="entry.c.tz === sourceZone ? 4 : 2.5" />
        <text x="9" y="-7"
              :font-size="cityFontSize(entry.c.tz === sourceZone)"
              :font-weight="entry.c.tz === sourceZone ? 700 : 600"
              :fill="entry.c.tz === sourceZone ? '#cdd6f4' : '#fde68a'"
              style="paint-order: stroke"
              stroke="rgba(2,4,10,0.92)" stroke-width="3.6">{{ entry.c.name }}</text>
        <text x="9" y="10"
              :font-size="cityTimeFontSize(entry.c.tz === sourceZone)"
              :font-weight="entry.c.tz === sourceZone ? 600 : 500"
              :fill="entry.c.tz === sourceZone ? '#e6ecff' : 'rgba(255,255,255,0.92)'"
              style="paint-order: stroke; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
              stroke="rgba(2,4,10,0.92)" stroke-width="3.6">{{ formatTimeInZone(baseUtc, entry.c.tz) }}</text>
      </g>

      <!-- Subsolar marker -->
      <g v-if="subPos" :transform="`translate(${subPos.x},${subPos.y})`">
        <circle r="7" fill="rgba(255,220,140,0.18)" />
        <circle r="3" fill="#ffe49b" />
      </g>

      <!-- Hour ticks -->
      <g v-for="t in ticks" :key="`tick-${t.label}`">
        <line :x1="t.x" :x2="t.x" :y1="height - 18" :y2="height - 8"
              stroke="rgba(255,255,255,0.25)" />
        <text :x="t.x" :y="height - 2" font-size="11" text-anchor="middle"
              fill="rgba(255,255,255,0.6)"
              font-family="ui-monospace, SFMono-Regular, Menlo, monospace">{{ t.label }}</text>
      </g>
    </svg>

    <div class="map-badge">Source · {{ sourceOffsetLabel }}</div>
  </div>
</template>

<style scoped>
.map-host { position: relative; width: 100%; overflow: hidden; border-radius: 12px; border: 1px solid #2a3350; background: linear-gradient(180deg, rgba(10,18,35,1), rgba(2,4,10,1)); }
.map-svg { display: block; width: 100%; height: auto; }
.map-badge {
  position: absolute; top: 0.6rem; right: 0.7rem;
  border: 1px solid rgba(122, 160, 255, 0.35);
  background: rgba(79, 124, 255, 0.12);
  color: #cdd6f4;
  padding: 0.25rem 0.55rem;
  border-radius: 6px;
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
</style>
