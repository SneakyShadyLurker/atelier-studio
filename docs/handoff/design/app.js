const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ──────────────────────────────────────────────────────────────────────────────
// Mock backend: a registry of "models" routed across local + remote backends.
// In production, this list is populated by a server-side discovery endpoint.
// ──────────────────────────────────────────────────────────────────────────────
const MODELS = [
  { id: 'sdxl-local',     name: 'SDXL 1.0',         backend: 'local',  size: '6.9GB', latency: 'fast',   tag: 'GPU-0' },
  { id: 'sdxl-turbo',     name: 'SDXL Turbo',       backend: 'local',  size: '4.1GB', latency: 'instant',tag: 'GPU-0' },
  { id: 'flux-schnell',   name: 'FLUX.1 schnell',   backend: 'local',  size: '23GB',  latency: 'fast',   tag: 'GPU-1' },
  { id: 'flux-dev',       name: 'FLUX.1 dev',       backend: 'local',  size: '23GB',  latency: 'medium', tag: 'GPU-1' },
  { id: 'sd35-large',     name: 'SD 3.5 Large',     backend: 'local',  size: '16GB',  latency: 'medium', tag: 'GPU-2' },
  { id: 'imagen4',        name: 'Imagen 4',         backend: 'cloud',  size: '—',     latency: 'fast',   tag: 'us-central1' },
  { id: 'dalle3',         name: 'DALL·E 3',         backend: 'cloud',  size: '—',     latency: 'medium', tag: 'azure' },
  { id: 'recraft-v3',     name: 'Recraft v3',       backend: 'cloud',  size: '—',     latency: 'slow',   tag: 'api' },
];

const RATIOS = [
  { id: '1:1',  w: 1024, h: 1024, label: 'Square' },
  { id: '4:5',  w: 896,  h: 1120, label: 'Portrait' },
  { id: '3:4',  w: 896,  h: 1184, label: 'Portrait' },
  { id: '16:9', w: 1344, h: 768,  label: 'Wide' },
  { id: '9:16', w: 768,  h: 1344, label: 'Vertical' },
];

const COUNTS = [1, 2, 3, 4];
const COLLECTIONS = [
  { id: 'c_logo', name: 'Logo concepts' },
  { id: 'c_studio', name: 'Studio refs' },
  { id: 'c_launch', name: 'Launch ideas' },
];

// ──────────────────────────────────────────────────────────────────────────────
// Mock generator. Returns a Promise that resolves to a placeholder image URL
// (a deterministic SVG data URI built from the prompt + seed) — or rejects.
// ──────────────────────────────────────────────────────────────────────────────
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function generateMockImage(prompt, model, ratio, seed, w, h) {
  const r = rng(hashString(`${prompt}::${model}::${seed}`));
  // Build a soft gradient + abstract shapes — a plausible "AI image" stand-in.
  const hue1 = Math.floor(r() * 360);
  const hue2 = (hue1 + 40 + r() * 80) % 360;
  const hue3 = (hue1 + 180 + r() * 60) % 360;
  const sat = 28 + r() * 30;
  const lum1 = 55 + r() * 25;
  const lum2 = 35 + r() * 30;
  const blobs = [];
  const n = 5 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    blobs.push({
      cx: r() * w,
      cy: r() * h,
      rx: 0.15 * w + r() * 0.45 * w,
      ry: 0.15 * h + r() * 0.45 * h,
      hue: [hue1, hue2, hue3][Math.floor(r() * 3)],
      l: 40 + r() * 35,
      a: 0.35 + r() * 0.4,
      rot: r() * 360,
    });
  }
  const blobsSvg = blobs.map(b =>
    `<ellipse cx="${b.cx.toFixed(1)}" cy="${b.cy.toFixed(1)}" rx="${b.rx.toFixed(1)}" ry="${b.ry.toFixed(1)}" fill="hsl(${b.hue.toFixed(0)} ${sat.toFixed(0)}% ${b.l.toFixed(0)}%)" opacity="${b.a.toFixed(2)}" transform="rotate(${b.rot.toFixed(0)} ${b.cx.toFixed(1)} ${b.cy.toFixed(1)})"/>`
  ).join('');
  // Some film grain via noise turbulence for texture.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue1} ${sat}% ${lum1}%)"/>
        <stop offset="100%" stop-color="hsl(${hue2} ${sat}% ${lum2}%)"/>
      </linearGradient>
      <filter id="b"><feGaussianBlur stdDeviation="${(w*0.04).toFixed(1)}"/></filter>
      <filter id="n">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${(seed%97).toFixed(0)}"/>
        <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0"/>
      </filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g filter="url(#b)">${blobsSvg}</g>
    <rect width="100%" height="100%" filter="url(#n)"/>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function generateImage({ prompt, modelId, ratio, seed }) {
  return new Promise((resolve, reject) => {
    const model = MODELS.find(m => m.id === modelId);
    const ratioDef = RATIOS.find(r => r.id === ratio);
    const base = { instant: 1200, fast: 2200, medium: 4500, slow: 7500 }[model?.latency || 'medium'];
    const jitter = base * 0.5 * Math.random();
    const total = base + jitter;
    const failProb = 0.06; // ~6% failures
    setTimeout(() => {
      if (Math.random() < failProb) {
        const reasons = [
          'CUDA out of memory on GPU-1',
          'Upstream timeout (cloud provider)',
          'Safety filter blocked output',
          'Model unloaded; retry to reload',
          'Rate limited (429)',
        ];
        reject(new Error(reasons[Math.floor(Math.random() * reasons.length)]));
      } else {
        resolve(generateMockImage(prompt, modelId, ratio, seed, ratioDef.w, ratioDef.h));
      }
    }, total);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Persistence (history)
// ──────────────────────────────────────────────────────────────────────────────
const STORE_KEY = 'atelier.history.v1';
function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return stored.length > 0 ? stored : [sampleQueuedBatch()];
  }
  catch { return [sampleQueuedBatch()]; }
}
function saveHistory(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 200))); } catch {}
}

function sampleQueuedBatch() {
  const createdAt = Date.now() - 12_000;
  return {
    id: 'sample-queued',
    prompt: 'A bronze observatory at dusk, etched glass, precise architectural lighting',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt,
    collectionId: null,
    pinned: false,
    status: 'queued',
    queueLengthAhead: 3,
    tiles: [
      { id: 'sample-queued-1', status: 'loading', modelId: 'gpt-image-2.5-sunburst', seed: 101, startedAt: createdAt },
      { id: 'sample-queued-2', status: 'loading', modelId: 'gpt-image-2.5-sunburst', seed: 102, startedAt: createdAt },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Icons
// ──────────────────────────────────────────────────────────────────────────────
const I = {
  arrow: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14M13 5l7 7-7 7"/></svg>,
  close: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 6L6 18M6 6l12 12"/></svg>,
  download: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  trash: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>,
  archive: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>,
  copy: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  reroll: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 1 1-3.5-7.1M21 4v5h-5"/></svg>,
  alert: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10.3 3.86a2 2 0 0 1 3.4 0l8 14A2 2 0 0 1 20 21H4a2 2 0 0 1-1.7-3.14l8-14zM12 9v4M12 17h.01"/></svg>,
  check: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6L9 17l-5-5"/></svg>,
  expand: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>,
  cloud: (p={}) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 1 0 6 16h11.5z"/></svg>,
  chip: (p={}) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9zM2 10h2M2 14h2M20 10h2M20 14h2M10 2v2M14 2v2M10 20v2M14 20v2"/></svg>,
  folder: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 8h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>,
  folderPlus: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 8h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>,
  star: (p={}) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 2 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 16.2l-5.6 3 1.1-6.2L3 8.6l6.2-.9Z"/></svg>,
};

// ──────────────────────────────────────────────────────────────────────────────
// Loading shimmer (pure CSS, but a more interesting "scanning" pattern)
// ──────────────────────────────────────────────────────────────────────────────
const css = `
:root {
    --glass-on-dark-70: rgba(255,255,255,0.7);
    --glass-on-dark-75: rgba(255,255,255,0.75);
    --text-2xs: 0.6875rem;
    --text-xs: 0.75rem;
    --text-sm: 0.8125rem;
    --text-md: 0.9375rem;
    --text-base: 1rem;
    --text-lg: 1.0625rem;
    --text-xl: 1.25rem;
    --text-display: 1.75rem;
}

.app {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100%;
  background: var(--bg);
}

/* Sidebar */
.sb {
  border-right: 1px solid var(--line);
  background: var(--bg-elev);
  display: flex; flex-direction: column;
  min-height: 0;
}
.sb-h {
  padding: 18px 18px 14px;
  display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--line);
}
.sb-mark {
  width: 22px; height: 22px;
  background: var(--ink);
  position: relative;
}
.sb-mark::after {
  content: '';
  position: absolute; inset: 4px;
  background: var(--bg-elev);
  clip-path: polygon(0 0, 100% 0, 100% 60%, 60% 100%, 0 100%);
}
.sb-title { font-weight: 500; letter-spacing: -0.01em; font-size: 14px; }
.sb-sub { font-family: var(--mono); font-size: 10px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; margin-left: auto; }

.sb-section {
  padding: 14px 18px 8px;
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ink-3);
  display: flex; align-items: center; justify-content: space-between;
}
.sb-list { flex: 1; overflow-y: auto; padding: 0 8px 80px; min-height: 0; }
.sb-empty { padding: 20px 16px; color: var(--ink-3); font-size: 12px; }
.hist-item {
  padding: 10px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: 10px;
  align-items: start;
  transition: background 120ms ease;
  border: 1px solid transparent;
}
.hist-item:hover { background: var(--bg-sunk); }
.hist-item.active { background: var(--bg-sunk); border-color: var(--line-2); }
.hist-thumb {
  width: 32px; height: 32px;
  background: var(--bg-sunk);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.hist-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hist-thumb.empty {
  /* Same resting material as QueuedTile. */
  background:
    radial-gradient(ellipse at 20% 30%, oklch(78% 0.12 38 / 0.3), transparent 50%),
    radial-gradient(ellipse at 80% 70%, oklch(74% 0.10 220 / 0.3), transparent 55%),
    radial-gradient(ellipse at 50% 50%, oklch(80% 0.09 320 / 0.3), transparent 60%),
    var(--bg-sunk);
}
.hist-text {
  min-width: 0;
}
.hist-prompt {
  font-size: 12px;
  color: var(--ink);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.35;
}
.hist-meta {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--ink-3);
  margin-top: 3px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.sb-footer {
  border-top: 1px solid var(--line);
  padding: 10px 14px;
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 10px; color: var(--ink-3);
  text-transform: uppercase; letter-spacing: 0.08em;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px oklch(58% 0.10 145 / 0.18); }

/* Main */
.main {
  display: grid;
  grid-template-rows: 1fr auto;
  min-height: 0;
  position: relative;
}
.canvas {
  overflow-y: auto;
  padding: 28px 36px 180px;
}
.canvas-empty {
  height: 100%;
  display: flex; align-items: center; justify-content: center;
  flex-direction: column;
  gap: 16px;
  color: var(--ink-3);
  text-align: center;
}
.canvas-empty .glyph {
  width: 64px; height: 64px;
  border: 1px dashed var(--line-2);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--ink-3);
  position: relative;
}
.canvas-empty .glyph::before {
  content: ''; position: absolute; inset: -8px;
  border: 1px dashed var(--line);
  border-radius: 50%;
  animation: pulse 3s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.08); opacity: 0.2; }
}
.canvas-empty h2 {
  font-weight: 400;
  font-size: 22px;
  letter-spacing: -0.015em;
  color: var(--ink);
  margin: 0;
}
.canvas-empty p { max-width: 420px; line-height: 1.55; margin: 0; font-size: 13px; }
.canvas-empty kbd {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--ink-2);
}

.batch { position: relative; padding-top: 44px; }
.batch::before {
  content: '';
  position: absolute;
  top: 24px;
  left: 0;
  width: 32px;
  height: 1px;
  background: var(--line-2);
}
.batch:first-of-type { padding-top: 0; }
.batch:first-of-type::before { display: none; }
.batch-h {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 8px;
}
.batch-prompt {
  font-size: 15px;
  color: var(--ink);
  letter-spacing: -0.005em;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-meta {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  display: flex; gap: 14px; flex-shrink: 0;
}
.batch-meta-col {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ink-3);
  font: inherit;
  text-transform: uppercase;
  letter-spacing: inherit;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.batch-meta-col:hover { color: var(--ink); }
.batch-meta b { color: var(--ink-2); font-weight: 500; }
.queue-badge {
  color: var(--ink-2);
}
.batch-pin {
  width: 28px; height: 28px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-3);
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.batch-pin svg,
.icon-btn svg { fill: none; }
.batch-pin[data-pinned="true"] { opacity: 1; color: var(--ink); }
.batch-pin[data-pinned="true"] svg,
.icon-btn[data-in-collection="true"] svg { fill: currentColor; }
.batch-h:hover .batch-pin,
.batch-pin:focus-visible { opacity: 1; }
.batch-pin:hover,
.batch-pin:focus-visible { background: var(--bg-sunk); color: var(--ink); border-color: var(--line); }
.batch-actions { display: flex; gap: 4px; }
.icon-btn {
  width: 28px; height: 28px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-3);
  transition: all 120ms ease;
}
.icon-btn:hover { background: var(--bg-sunk); color: var(--ink); border-color: var(--line); }

.move-popover {
  position: fixed;
  width: 220px;
  padding: 6px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  box-shadow: var(--shadow-2);
  z-index: var(--z-popover);
  animation: popover-in 140ms cubic-bezier(.2,.8,.2,1);
}
.move-popover-h {
  padding: 8px 8px 7px;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.move-popover ul { list-style: none; margin: 0; padding: 0; }
.move-row {
  width: 100%;
  min-height: 36px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0 8px;
  background: transparent;
  color: var(--ink);
  display: flex; align-items: center; gap: 8px;
  text-align: left;
}
.move-row:hover,
.move-row[data-current="true"] { background: var(--bg-sunk); }
.move-row[data-current="true"] { border-color: var(--line); }
.move-row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.move-divider { height: 1px; margin: 6px 4px; background: var(--line); }
.move-new { color: var(--ink-3); font-family: var(--mono); font-size: 11px; letter-spacing: 0.02em; }
.move-backdrop { display: none; }

.grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

/* Tile */
.tile {
  position: relative;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: zoom-in;
  transition: transform 200ms cubic-bezier(.2,.8,.2,1), box-shadow 200ms ease, border-color 120ms ease;
  animation: tile-in 380ms cubic-bezier(.2,.8,.2,1) both;
}
@keyframes tile-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.tile:hover { border-color: var(--line-2); box-shadow: var(--shadow-2); transform: translateY(-2px); }
.tile.failed { cursor: default; }
.tile.failed:hover { transform: none; box-shadow: var(--shadow-1); }
.tile-frame {
  width: 100%;
  background: var(--bg-sunk);
  display: block;
  position: relative;
  overflow: hidden;
}
.tile-frame img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  animation: img-in 500ms cubic-bezier(.2,.8,.2,1) both;
}
@keyframes img-in {
  from { opacity: 0; filter: blur(12px); transform: scale(1.04); }
  to { opacity: 1; filter: blur(0); transform: scale(1); }
}

/* Loading state — animated scan + diffusion noise */
.loading {
  position: absolute; inset: 0;
  background:
    linear-gradient(var(--bg-sunk), var(--bg-sunk));
  overflow: hidden;
}
.loading::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    radial-gradient(ellipse at 20% 30%, oklch(78% 0.12 38 / 0.6), transparent 50%),
    radial-gradient(ellipse at 80% 70%, oklch(74% 0.10 220 / 0.5), transparent 55%),
    radial-gradient(ellipse at 50% 50%, oklch(80% 0.09 320 / 0.45), transparent 60%);
  filter: blur(20px);
  will-change: transform;
  transform: translateZ(0);
  animation: drift 6s ease-in-out infinite alternate;
}
@keyframes drift {
  from { transform: scale(1) translate(0, 0); }
  to { transform: scale(1.15) translate(-4%, 4%); }
}
.loading::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(180deg,
    transparent 0%,
    transparent 45%,
    rgba(20,19,15,0.06) 50%,
    transparent 55%,
    transparent 100%);
  animation: scan 2.4s linear infinite;
}
@keyframes scan {
  from { transform: translateY(-100%); }
  to { transform: translateY(100%); }
}
.loading-noise {
  position: absolute; inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.4'/></svg>");
  opacity: 0.25;
  mix-blend-mode: multiply;
  animation: shift 0.6s steps(4) infinite;
}
@keyframes shift {
  0% { transform: translate(0,0); }
  25% { transform: translate(-3px,2px); }
  50% { transform: translate(2px,-3px); }
  75% { transform: translate(-2px,-2px); }
  100% { transform: translate(0,0); }
}
.loading-text {
  position: absolute;
  bottom: 12px; left: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: white;
  /* Match LoadingTile's contrast backing, including over bright previews. */
  background:
    linear-gradient(var(--scrim-on-image), var(--scrim-on-image)),
    linear-gradient(var(--scrim-on-image), var(--scrim-on-image)),
    var(--scrim-on-image);
  padding: 4px 6px;
  border-radius: var(--radius-4);
  text-shadow: var(--shadow-text-on-image);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex; align-items: center; gap: 8px;
  z-index: 2;
}
.loading-bar {
  width: 60px; height: 1px;
  background: var(--line-2);
  position: relative;
  overflow: hidden;
}
.loading-bar::after {
  content: '';
  position: absolute; inset: 0;
  background: var(--accent);
  animation: progress 1.8s cubic-bezier(.4,0,.2,1) infinite;
  transform-origin: left;
}
@keyframes progress {
  0% { transform: scaleX(0) translateX(0); transform-origin: left; }
  50% { transform: scaleX(0.8) translateX(0); transform-origin: left; }
  51% { transform-origin: right; }
  100% { transform: scaleX(0) translateX(0); transform-origin: right; }
}

.queued {
  position: absolute; inset: 0;
  background:
    linear-gradient(135deg, transparent 0 34%, var(--glass-on-dark-6) 34% 36%, transparent 36% 62%, var(--glass-on-dark-6) 62% 64%, transparent 64%),
    radial-gradient(ellipse at 20% 30%, oklch(78% 0.12 38 / 0.3), transparent 50%),
    radial-gradient(ellipse at 80% 70%, oklch(74% 0.10 220 / 0.3), transparent 55%),
    radial-gradient(ellipse at 50% 50%, oklch(80% 0.09 320 / 0.3), transparent 60%),
    var(--bg-sunk);
  overflow: hidden;
}
.queued-sheen {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, transparent 0 42%, var(--glass-on-dark-12) 50%, transparent 58% 100%);
  opacity: 0.72;
}
.queued-text {
  position: absolute;
  bottom: 12px; left: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: white;
  background:
    linear-gradient(var(--scrim-on-image), var(--scrim-on-image)),
    linear-gradient(var(--scrim-on-image), var(--scrim-on-image)),
    var(--scrim-on-image);
  padding: 4px 6px;
  border-radius: var(--radius-4);
  text-shadow: var(--shadow-text-on-image);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  z-index: 2;
}

/* Failed state */
.failed-body {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  padding: 18px;
  background: var(--bg-elev);
  background-image: repeating-linear-gradient(45deg,
    transparent, transparent 8px,
    var(--bg-sunk) 8px, var(--bg-sunk) 9px);
}
.failed-icon {
  color: var(--danger);
  margin-bottom: 8px;
}
.failed-title {
  font-family: var(--mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--danger);
  margin-bottom: 6px;
}
.failed-msg {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.5;
  flex: 1;
}
.failed-actions {
  display: flex; gap: 8px;
  margin-top: 12px;
}
.btn-mini {
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 5px 9px;
  border: 1px solid var(--line-control);
  background: var(--bg-elev);
  color: var(--ink-2);
  border-radius: 3px;
  display: inline-flex; align-items: center; gap: 5px;
  transition: all 120ms ease;
}
.btn-mini:hover { background: var(--ink); color: var(--bg); border-color: var(--ink); }

/* Tile overlay with actions */
.tile-overlay {
  position: absolute; inset: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 160ms ease;
  background: linear-gradient(180deg,
    transparent 60%,
    rgba(20,19,15,0.55) 100%);
}
.tile:hover .tile-overlay { opacity: 1; }
.tile-actions {
  position: absolute;
  bottom: 10px; left: 10px; right: 10px;
  display: flex; align-items: center; justify-content: space-between;
  pointer-events: auto;
}
.tile-num {
  font-family: var(--mono);
  font-size: 10px;
  color: rgba(255,255,255,0.85);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.tile-btns { display: flex; gap: 4px; }
.tile-btn {
  width: 26px; height: 26px;
  background: rgba(20,19,15,0.6);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: rgba(255,255,255,0.9);
  display: inline-flex; align-items: center; justify-content: center;
  transition: all 120ms ease;
}
.tile-btn:hover { background: rgba(20,19,15,0.85); color: white; }

/* Composer */
.composer-wrap {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 72px);
  max-width: 920px;
  z-index: 5;
}
.composer {
  background: var(--bg-elev);
  border: 1px solid var(--line-2);
  border-radius: 14px;
  box-shadow: var(--shadow-3);
  padding: 14px 14px 10px;
  display: flex; flex-direction: column; gap: 10px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.composer:focus-within {
  border-color: var(--ink);
}
.composer textarea {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  font-size: 14.5px;
  line-height: 1.5;
  min-height: 48px;
  max-height: 180px;
  font-family: var(--sans);
  letter-spacing: -0.005em;
}
.composer textarea::placeholder { color: var(--ink-3); }

.composer-row {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--line-control);
  border-radius: 6px;
  background: var(--bg);
  font-family: var(--mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-2);
  cursor: pointer;
  position: relative;
  transition: all 120ms ease;
}
.chip:hover { background: var(--bg-sunk); border-color: var(--line-2); color: var(--ink); }
.chip-label { color: var(--ink-3); }
.chip-val { color: var(--ink); }
.chip svg { color: var(--ink-3); }
.chip select {
  position: absolute; inset: 0;
  opacity: 0; cursor: pointer;
  width: 100%; height: 100%;
}
.spacer { flex: 1; }
.shortcut {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  display: flex; align-items: center; gap: 4px;
  margin-right: 6px;
}
.shortcut kbd {
  background: var(--bg);
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}
.btn-go {
  background: var(--ink);
  color: var(--bg);
  border: 1px solid var(--ink);
  border-radius: 7px;
  padding: 8px 14px 8px 16px;
  font-family: var(--sans);
  font-size: 13px;
  letter-spacing: -0.005em;
  display: inline-flex; align-items: center; gap: 8px;
  transition: all 140ms ease;
}
.btn-go:hover:not(:disabled) { background: var(--ink-2); border-color: var(--ink-2); }
.btn-go:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-go svg { transition: transform 200ms cubic-bezier(.2,.8,.2,1); }
.btn-go:hover:not(:disabled) svg { transform: translateX(2px); }

/* Lightbox */
.lb-backdrop {
  position: fixed; inset: 0;
  background: rgba(20,19,15,0.85);
  backdrop-filter: blur(12px);
  z-index: 100;
  display: flex; align-items: center; justify-content: center;
  animation: lb-in 220ms cubic-bezier(.2,.8,.2,1) both;
  cursor: zoom-out;
}
@keyframes lb-in { from { opacity: 0; } to { opacity: 1; } }
.lb-frame {
  position: relative;
  max-width: 90vw;
  max-height: calc(100vh - 120px);
  display: flex; align-items: center; justify-content: center;
  cursor: default;
  animation: lb-frame-in 360ms cubic-bezier(.2,.8,.2,1) both;
}
@keyframes lb-frame-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
.lb-frame img {
  max-width: 90vw;
  max-height: calc(100vh - 120px);
  display: block;
  border-radius: 6px;
  box-shadow: 0 40px 100px -20px rgba(0,0,0,0.5);
}
.lb-bar {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px;
  padding: 6px;
  background: rgba(20,19,15,0.7);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  z-index: 101;
}
.lb-info {
  padding: 0 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: rgba(255,255,255,0.65);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-right: 1px solid rgba(255,255,255,0.1);
  height: 28px;
  display: flex; align-items: center;
}
.lb-info b { color: white; font-weight: 500; }
.lb-btn {
  height: 28px;
  padding: 0 10px;
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.85);
  font-family: var(--mono);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-radius: 6px;
  display: inline-flex; align-items: center; gap: 6px;
  transition: all 120ms ease;
}
.lb-btn:hover { background: rgba(255,255,255,0.1); color: white; }
.lb-btn.danger:hover { background: oklch(55% 0.13 25 / 0.4); }
.lb-close {
  position: fixed;
  top: 24px; right: 24px;
  width: 40px; height: 40px;
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 50%;
  color: white;
  display: inline-flex; align-items: center; justify-content: center;
  z-index: 101;
  transition: all 120ms ease;
}
.lb-close:hover { background: rgba(255,255,255,0.15); transform: rotate(90deg); }
.lb-nav {
  position: fixed;
  top: 50%; transform: translateY(-50%);
  width: 44px; height: 44px;
  background: rgba(255,255,255,0.06);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 50%;
  color: white;
  display: inline-flex; align-items: center; justify-content: center;
  z-index: 101;
  transition: all 120ms ease;
}
.lb-nav:hover { background: rgba(255,255,255,0.12); }
.lb-nav.prev { left: 24px; }
.lb-nav.next { right: 24px; }
.lb-nav:disabled { opacity: 0.2; cursor: not-allowed; }

/* Toast — bottom-anchored above the composer (departure from the original
   top-24 placement, which sat directly on top of the topmost batch's prompt
   header at every scroll position). Composer publishes its viewport-top
   offset as --composer-top; toast adds a 16px gap. */
.toast {
  --toast-anchor-x: 50%;
  --toast-anchor-y: calc(var(--composer-top, 116px) + 16px);

  position: fixed;
  bottom: var(--toast-anchor-y); left: var(--toast-anchor-x);
  transform: translateX(-50%) translateY(20px);
  background: var(--ink);
  color: var(--bg);
  padding: 9px 16px;
  border-radius: 7px;
  font-size: 12.5px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  z-index: var(--z-toast);
  display: flex; align-items: center; gap: 8px;
  opacity: 0;
  pointer-events: none;
  transition: transform 240ms cubic-bezier(.2,.8,.2,1), opacity 240ms cubic-bezier(.2,.8,.2,1);
}
.toast.show {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
.toast.leaving {
  transform: translateX(-50%) translateY(8px);
  opacity: 0;
  transition: transform 160ms cubic-bezier(.2,.8,.2,1), opacity 160ms cubic-bezier(.2,.8,.2,1);
}
.toast svg { color: oklch(78% 0.14 145); }

@media (min-width: 768px) {
  .toast {
    --toast-anchor-x: calc(50% + 120px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast {
    transform: translateX(-50%);
    transition: opacity 80ms linear;
  }
  .toast.leaving {
    transform: translateX(-50%);
    transition: opacity 60ms linear;
  }
  .move-popover {
    animation-duration: 80ms;
    animation-timing-function: linear;
  }
}

@media (max-width: 767px) {
  .batch-h { flex-wrap: wrap; row-gap: 8px; align-items: flex-start; }
  .batch-prompt { flex: 0 0 100%; white-space: normal; }
  .batch-actions { margin-left: auto; }
  .move-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    border: 0;
    background: rgba(20,19,15,0.4);
    backdrop-filter: blur(8px);
    z-index: var(--z-popover);
  }
  .move-popover {
    top: auto !important;
    left: 0 !important;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 60vh;
    overflow-y: auto;
    border-width: 1px 0 0;
    border-radius: 14px 14px 0 0;
    padding: 10px 10px 18px;
    animation: sheet-in 240ms cubic-bezier(.2,.8,.2,1);
  }
  .move-row { min-height: 44px; }
}

@keyframes popover-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes sheet-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

/* Backend pill */
.backend-pill {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--mono); font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-left: auto;
}
.backend-pill.local { background: oklch(94% 0.04 145); color: oklch(40% 0.10 145); }
.backend-pill.cloud { background: oklch(94% 0.03 240); color: oklch(40% 0.10 240); }

/* Scrollbar */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: var(--ink-3); }

/* Tile expanding to lightbox FLIP transition handled by element animations above */
`;

// ──────────────────────────────────────────────────────────────────────────────
// Components
// ──────────────────────────────────────────────────────────────────────────────

function ModelOption({ model, selected }) {
  return (
    <span className="chip-val" title={`${model.backend} · ${model.tag} · ${model.latency}`}>
      {model.name}
    </span>
  );
}

function Composer({ value, setValue, modelId, setModelId, ratio, setRatio, count, setCount, onSubmit, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [value]);

  const handleKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!busy && value.trim()) onSubmit();
    }
  };

  const model = MODELS.find(m => m.id === modelId);
  const ratioDef = RATIOS.find(r => r.id === ratio);

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          placeholder="Describe an image…"
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          autoFocus
          rows={1}
        />
        <div className="composer-row">
          <label className="chip">
            <I.chip />
            <span className="chip-label">Model</span>
            <ModelOption model={model} />
            <select value={modelId} onChange={e => setModelId(e.target.value)}>
              <optgroup label="Local">
                {MODELS.filter(m => m.backend === 'local').map(m =>
                  <option key={m.id} value={m.id}>{m.name} — {m.tag}</option>
                )}
              </optgroup>
              <optgroup label="Cloud">
                {MODELS.filter(m => m.backend === 'cloud').map(m =>
                  <option key={m.id} value={m.id}>{m.name} — {m.tag}</option>
                )}
              </optgroup>
            </select>
          </label>

          <label className="chip">
            <span className="chip-label">Ratio</span>
            <span className="chip-val">{ratioDef.id}</span>
            <select value={ratio} onChange={e => setRatio(e.target.value)}>
              {RATIOS.map(r => <option key={r.id} value={r.id}>{r.id} — {r.label}</option>)}
            </select>
          </label>

          <label className="chip">
            <span className="chip-label">Count</span>
            <span className="chip-val">{count}</span>
            <select value={count} onChange={e => setCount(parseInt(e.target.value, 10))}>
              {COUNTS.map(c => <option key={c} value={c}>{c} {c === 1 ? 'image' : 'images'}</option>)}
            </select>
          </label>

          <div className="spacer" />

          <span className="shortcut">
            <kbd>⌘</kbd><kbd>↵</kbd>
          </span>
          <button
            className="btn-go"
            onClick={onSubmit}
            disabled={busy || !value.trim()}
          >
            Generate <I.arrow />
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingTile({ ratioDef, modelName, elapsed }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = ((Date.now() - elapsed) / 1000).toFixed(1);
  return (
    <div className="tile" style={{ cursor: 'default' }}>
      <div className="tile-frame" style={{ aspectRatio: `${ratioDef.w} / ${ratioDef.h}` }}>
        <div className="loading">
          <div className="loading-noise" />
          <div className="loading-text">
            <div className="loading-bar" />
            <span>{modelName} · {elapsedSec}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function queuedLabel(queueLengthAhead) {
  return queueLengthAhead && queueLengthAhead > 0
    ? `QUEUED · ${queueLengthAhead} AHEAD`
    : 'QUEUED';
}

function QueuedTile({ ratioDef, queueLengthAhead }) {
  return (
    <div className="tile" style={{ cursor: 'default' }}>
      <div className="tile-frame" style={{ aspectRatio: `${ratioDef.w} / ${ratioDef.h}` }}>
        <div className="queued">
          <div className="queued-sheen" />
          <div className="queued-text">{queuedLabel(queueLengthAhead)}</div>
        </div>
      </div>
    </div>
  );
}

function FailedTile({ message, onDismiss, onRetry, modelName }) {
  return (
    <div className="tile failed">
      <div className="tile-frame" style={{ aspectRatio: '1 / 1' }}>
        <div className="failed-body">
          <div className="failed-icon"><I.alert /></div>
          <div className="failed-title">Generation failed</div>
          <div className="failed-msg">{message}</div>
          <div className="failed-actions">
            <button className="btn-mini" onClick={onRetry}><I.reroll />Retry</button>
            <button className="btn-mini" onClick={onDismiss}><I.close />Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageTile({ image, index, ratioDef, onOpen, onDownload, onDelete }) {
  return (
    <div className="tile" onClick={() => onOpen(index)}>
      <div className="tile-frame" style={{ aspectRatio: `${ratioDef.w} / ${ratioDef.h}` }}>
        <img src={image.url} alt="" draggable={false} />
        <div className="tile-overlay">
          <div className="tile-actions">
            <span className="tile-num">{String(index + 1).padStart(2, '0')} · {ratioDef.id}</span>
            <div className="tile-btns">
              <button className="tile-btn" title="Download" onClick={(e) => { e.stopPropagation(); onDownload(); }}>
                <I.download />
              </button>
              <button className="tile-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
                <I.trash />
              </button>
              <button className="tile-btn" title="Expand" onClick={(e) => { e.stopPropagation(); onOpen(index); }}>
                <I.expand />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ batch, index, onClose, onNav, onDownload, onDelete, models }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onNav(-1);
      else if (e.key === 'ArrowRight') onNav(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onNav]);

  const tile = batch.tiles[index];
  const ratioDef = RATIOS.find(r => r.id === batch.ratio);
  const model = models.find(m => m.id === tile.modelId);

  return (
    <div className="lb-backdrop" onClick={onClose}>
      <button className="lb-close" onClick={onClose} aria-label="Close"><I.close /></button>
      <button className="lb-nav prev" onClick={(e) => { e.stopPropagation(); onNav(-1); }} disabled={index === 0}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <button className="lb-nav next" onClick={(e) => { e.stopPropagation(); onNav(1); }} disabled={index === batch.tiles.length - 1}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div className="lb-frame" onClick={(e) => e.stopPropagation()}>
        <img src={tile.url} alt="" />
      </div>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <div className="lb-info">
          <span><b>{model?.name}</b> · {ratioDef.id} · {ratioDef.w}×{ratioDef.h} · {String(index + 1).padStart(2, '0')}/{String(batch.tiles.length).padStart(2, '0')}</span>
        </div>
        <button className="lb-btn" onClick={() => onDownload()}><I.download />Download</button>
        <button className="lb-btn danger" onClick={() => onDelete()}><I.trash />Delete</button>
      </div>
    </div>
  );
}

function HistorySidebar({ batches, onSelect, activeBatchId, onClear }) {
  return (
    <aside className="sb">
      <div className="sb-h">
        <div className="sb-mark" />
        <div className="sb-title">Atelier</div>
        <div className="sb-sub">v0.4</div>
      </div>
      <div className="sb-section">
        <span>History</span>
        {batches.length > 0 && (
          <button className="icon-btn" onClick={onClear} title="Clear history" style={{ width: 22, height: 22 }}>
            <I.trash />
          </button>
        )}
      </div>
      <div className="sb-list">
        {batches.length === 0 ? (
          <div className="sb-empty">Nothing here yet. Your generations will appear here.</div>
        ) : batches.map(batch => {
          const firstReady = batch.tiles.find(t => t.status === 'done');
          return (
            <div
              key={batch.id}
              className={`hist-item ${batch.id === activeBatchId ? 'active' : ''}`}
              onClick={() => onSelect(batch.id)}
            >
              <div className={`hist-thumb ${firstReady ? '' : 'empty'}`}>
                {firstReady && <img src={firstReady.url} alt="" />}
              </div>
              <div className="hist-text">
                <div className="hist-prompt">{batch.prompt}</div>
                <div className="hist-meta">
                  {batch.tiles.length}× · {batch.ratio} · {batch.modelLabel}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="sb-footer">
        <span className="dot" />
        <span>{MODELS.length} models · 2 backends</span>
      </div>
    </aside>
  );
}

function MovePopoverMock({ batch, position, onClose, onMove }) {
  if (!batch || !position) return null;
  return (
    <>
      <button className="move-backdrop" type="button" aria-label="Close move popover" onClick={onClose} />
      <div className="move-popover" role="dialog" aria-label="Move to collection" style={{ top: position.top, left: position.left }}>
        <div className="move-popover-h">Move to collection</div>
        <ul role="list">
          <li>
            <button className="move-row" type="button" data-current={batch.collectionId == null ? 'true' : 'false'} onClick={() => onMove(batch.id, null)}>
              <span>(Unsorted)</span>
              {batch.collectionId == null && <I.check />}
            </button>
          </li>
          {COLLECTIONS.map(col => (
            <li key={col.id}>
              <button className="move-row" type="button" data-current={batch.collectionId === col.id ? 'true' : 'false'} onClick={() => onMove(batch.id, col.id)}>
                <span>{col.name}</span>
                {batch.collectionId === col.id && <I.check />}
              </button>
            </li>
          ))}
        </ul>
        <div className="move-divider" />
        <button className="move-row move-new" type="button" onClick={() => onMove(batch.id, COLLECTIONS[0].id)}>+ New collection</button>
      </div>
    </>
  );
}

function EmptyCanvas() {
  return (
    <div className="canvas-empty">
      <div className="glyph">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="9" cy="9" r="2"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
      </div>
      <h2>What would you like to make?</h2>
      <p>Pick a model, write a prompt, and press <kbd>⌘</kbd> <kbd>↵</kbd>. Local and cloud backends are unified — you don't need to think about where the work runs.</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
}
function timeLabel(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ──────────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────────
function App() {
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [ratio, setRatio] = useState('1:1');
  const [count, setCount] = useState(2);
  const [batches, setBatches] = useState(() => loadHistory());
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { batchId, index }
  const [movePopover, setMovePopover] = useState(null);
  const [toast, setToast] = useState(null);
  const canvasRef = useRef(null);

  // Persist
  useEffect(() => { saveHistory(batches); }, [batches]);

  // Inject styles
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  const submit = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    const model = MODELS.find(m => m.id === modelId);
    const batchId = 'b_' + Math.random().toString(36).slice(2, 10);
    const tiles = Array.from({ length: count }, (_, i) => ({
      id: 't_' + Math.random().toString(36).slice(2, 10),
      status: 'loading',
      modelId,
      seed: Math.floor(Math.random() * 1e9),
      startedAt: Date.now(),
      url: null,
      error: null,
    }));
    const batch = {
      id: batchId,
      prompt: text,
      ratio,
      modelId,
      modelLabel: model.name,
      createdAt: Date.now(),
      collectionId: null,
      pinned: false,
      status: 'running',
      tiles,
    };
    setBatches(prev => [batch, ...prev]);
    setActiveBatchId(batchId);

    // Kick off each tile
    tiles.forEach(tile => {
      generateImage({ prompt: text, modelId, ratio, seed: tile.seed })
        .then(url => {
          setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
            ...b,
            tiles: b.tiles.map(t => t.id !== tile.id ? t : ({
              ...t,
              status: 'done',
              url,
              completedAt: Date.now(),
            })),
          })));
        })
        .catch(err => {
          setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
            ...b,
            tiles: b.tiles.map(t => t.id !== tile.id ? t : ({
              ...t,
              status: 'failed',
              error: err.message || String(err),
              completedAt: Date.now(),
            })),
          })));
        });
    });

    // Scroll to top of canvas to show new batch
    setTimeout(() => {
      if (canvasRef.current) canvasRef.current.scrollTop = 0;
    }, 50);
  }, [prompt, modelId, ratio, count]);

  const dismissTile = (batchId, tileId) => {
    setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
      ...b,
      tiles: b.tiles.filter(t => t.id !== tileId),
    })).filter(b => b.tiles.length > 0));
    showToast('Removed');
  };

  const retryTile = (batchId, tileId) => {
    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;
    const tile = batch.tiles.find(t => t.id === tileId);
    if (!tile) return;
    const newSeed = Math.floor(Math.random() * 1e9);
    setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
      ...b,
      tiles: b.tiles.map(t => t.id !== tileId ? t : ({
        ...t, status: 'loading', error: null, startedAt: Date.now(), seed: newSeed,
      })),
    })));
    generateImage({ prompt: batch.prompt, modelId: tile.modelId, ratio: batch.ratio, seed: newSeed })
      .then(url => {
        setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
          ...b,
          tiles: b.tiles.map(t => t.id !== tileId ? t : ({
            ...t, status: 'done', url, completedAt: Date.now(),
          })),
        })));
      })
      .catch(err => {
        setBatches(prev => prev.map(b => b.id !== batchId ? b : ({
          ...b,
          tiles: b.tiles.map(t => t.id !== tileId ? t : ({
            ...t, status: 'failed', error: err.message, completedAt: Date.now(),
          })),
        })));
      });
  };

  const downloadTile = (batch, tileIndex) => {
    const tile = batch.tiles[tileIndex];
    if (!tile || !tile.url) return;
    const ratioDef = RATIOS.find(r => r.id === batch.ratio);
    const fname = `atelier_${slugify(batch.prompt)}_${batch.modelId}_${ratioDef.id.replace(':','x')}_${tile.seed}.svg`;
    downloadDataUrl(tile.url, fname);
    showToast('Downloaded');
  };

  const copyPrompt = (text) => {
    navigator.clipboard?.writeText(text);
    showToast('Prompt copied');
  };

  const reroll = (batch) => {
    setPrompt(batch.prompt);
    setModelId(batch.modelId);
    setRatio(batch.ratio);
    setCount(batch.tiles.length);
    setTimeout(submit, 0);
  };

  const clearHistory = () => {
    if (confirm('Clear all generations? This cannot be undone.')) {
      setBatches([]);
      setActiveBatchId(null);
    }
  };

  const deleteBatch = (batchId) => {
    setBatches(prev => prev.filter(b => b.id !== batchId));
  };

  const togglePin = (batchId) => {
    setBatches(prev => prev.map(b => b.id === batchId ? { ...b, pinned: !b.pinned } : b));
  };

  const moveBatch = (batchId, collectionId) => {
    setBatches(prev => prev.map(b => b.id === batchId ? { ...b, collectionId } : b));
    setMovePopover(null);
  };

  const openLightbox = (batchId, index) => {
    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;
    if (batch.tiles[index]?.status !== 'done') return;
    setLightbox({ batchId, index });
  };

  const lightboxNav = (delta) => {
    if (!lightbox) return;
    const batch = batches.find(b => b.id === lightbox.batchId);
    if (!batch) return;
    const readyIndices = batch.tiles.map((t, i) => t.status === 'done' ? i : -1).filter(i => i >= 0);
    const cur = readyIndices.indexOf(lightbox.index);
    const next = cur + delta;
    if (next < 0 || next >= readyIndices.length) return;
    setLightbox({ ...lightbox, index: readyIndices[next] });
  };

  const sortedBatches = useMemo(() => batches, [batches]);
  const lightboxBatch = lightbox ? batches.find(b => b.id === lightbox.batchId) : null;

  return (
    <div className="app">
      <HistorySidebar
        batches={sortedBatches}
        activeBatchId={activeBatchId}
        onSelect={(id) => {
          setActiveBatchId(id);
          // scroll to that batch
          setTimeout(() => {
            const el = document.querySelector(`[data-batch-id="${id}"]`);
            if (el && canvasRef.current) {
              const top = el.offsetTop - 24;
              canvasRef.current.scrollTo({ top, behavior: 'smooth' });
            }
          }, 0);
        }}
        onClear={clearHistory}
      />

      <main className="main">
        <div className="canvas" ref={canvasRef}>
          {batches.length === 0 ? <EmptyCanvas /> : sortedBatches.map(batch => {
            const ratioDef = RATIOS.find(r => r.id === batch.ratio);
            const collectionId = batch.collectionId ?? null;
            const currentCollection = collectionId ? COLLECTIONS.find(col => col.id === collectionId) : null;
            const pinned = Boolean(batch.pinned);
            const openMove = (target) => {
              const trigger = target.closest('.batch-h').querySelector('[data-move-trigger]');
              const rect = trigger.getBoundingClientRect();
              setMovePopover({ batchId: batch.id, top: rect.bottom + 8, left: Math.max(12, rect.right - 220) });
            };
            return (
              <section key={batch.id} className="batch" data-batch-id={batch.id}>
                <header className="batch-h">
                  <div className="batch-prompt" title={batch.prompt}>{batch.prompt}</div>
                  <div className="batch-meta">
                    <span><b>{batch.modelLabel}</b></span>
                    <span>{batch.ratio}</span>
                    {batch.status === 'queued' && <span className="queue-badge">{queuedLabel(batch.queueLengthAhead)}</span>}
                    <span>{timeLabel(batch.createdAt)}</span>
                    {currentCollection && (
                      <button className="batch-meta-col" type="button" onClick={(event) => openMove(event.currentTarget)}>
                        <I.folder /> {currentCollection.name.toUpperCase()}
                      </button>
                    )}
                  </div>
                  <button className="batch-pin" type="button" data-pinned={pinned ? 'true' : 'false'} title={pinned ? 'Unpin batch' : 'Pin batch'} onClick={() => togglePin(batch.id)}>
                    <I.star />
                  </button>
                  <div className="batch-actions">
                    <button className="icon-btn" title="Copy prompt" onClick={() => copyPrompt(batch.prompt)}><I.copy /></button>
                    <button className="icon-btn" title="Generate again" onClick={() => reroll(batch)}><I.reroll /></button>
                    <button className="icon-btn" title="Move" data-move-trigger data-in-collection={collectionId ? 'true' : 'false'} onClick={(event) => openMove(event.currentTarget)}><I.folderPlus /></button>
                    <button className="icon-btn" title="Archive batch" onClick={() => deleteBatch(batch.id)}><I.archive /></button>
                  </div>
                </header>
                <div className="grid">
                  {batch.tiles.map((tile, i) => {
                    if (tile.status === 'loading') {
                      const model = MODELS.find(m => m.id === tile.modelId);
                      if (batch.status === 'queued') {
                        return <QueuedTile key={tile.id} ratioDef={ratioDef} queueLengthAhead={batch.queueLengthAhead} />;
                      }
                      return <LoadingTile key={tile.id} ratioDef={ratioDef} modelName={model.name} elapsed={tile.startedAt} />;
                    }
                    if (tile.status === 'failed') {
                      return <FailedTile
                        key={tile.id}
                        message={tile.error}
                        modelName={MODELS.find(m => m.id === tile.modelId)?.name}
                        onDismiss={() => dismissTile(batch.id, tile.id)}
                        onRetry={() => retryTile(batch.id, tile.id)}
                      />;
                    }
                    return <ImageTile
                      key={tile.id}
                      image={tile}
                      index={i}
                      ratioDef={ratioDef}
                      onOpen={(idx) => openLightbox(batch.id, idx)}
                      onDownload={() => downloadTile(batch, i)}
                      onDelete={() => dismissTile(batch.id, tile.id)}
                    />;
                  })}
                </div>
              </section>
            );
          })}
          <MovePopoverMock
            batch={movePopover ? batches.find(b => b.id === movePopover.batchId) : null}
            position={movePopover}
            onClose={() => setMovePopover(null)}
            onMove={moveBatch}
          />
        </div>

        <Composer
          value={prompt}
          setValue={setPrompt}
          modelId={modelId}
          setModelId={setModelId}
          ratio={ratio}
          setRatio={setRatio}
          count={count}
          setCount={setCount}
          onSubmit={submit}
          busy={false}
        />
      </main>

      {lightbox && lightboxBatch && (
        <Lightbox
          batch={lightboxBatch}
          index={lightbox.index}
          models={MODELS}
          onClose={() => setLightbox(null)}
          onNav={lightboxNav}
          onDownload={() => downloadTile(lightboxBatch, lightbox.index)}
          onDelete={() => {
            const tile = lightboxBatch.tiles[lightbox.index];
            dismissTile(lightboxBatch.id, tile.id);
            setLightbox(null);
          }}
        />
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>
        <I.check />{toast}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
