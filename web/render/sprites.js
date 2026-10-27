// Procedural pixel-art characters. No image assets: every villager is built
// from a fill template + species features + genome colours, then auto-shaded
// and auto-outlined. That keeps the project 100% open-source (no paid
// tilesets) and lets every familiar look unique.
//
// Sprite canvas: 20×22 px. The 16×16 "body box" sits at (2,5), leaving room
// for ears, halos, tails and tools.

export const SPRITE_W = 20;
export const SPRITE_H = 22;
const OX = 2, OY = 5;

const cache = new Map();

// ---------------------------------------------------------------- palettes

const SPECIES_TONE = {
  owl: (h) => ({ h: 18 + (h % 36), s: 42, l: 52 }),
  fox: (h) => ({ h: 14 + (h % 18), s: 78, l: 57 }),
  bot: (h) => ({ h: 180 + (h % 70), s: 22, l: 68 }),
  bunny: (h) => ({ h, s: 50, l: 82 }),
  cat: (h) => ({ h, s: 30, l: 58 }),
  egg: () => ({ h: 42, s: 70, l: 92 }),
};

export function paletteFor(d) {
  const g = d.genome || { hue: 30, accentHue: 200 };
  let { h, s, l } = (SPECIES_TONE[d.species] || SPECIES_TONE.cat)(g.hue);
  let ah = g.accentHue;
  if (d.shiny) { h = (h + 150) % 360; s = Math.min(90, s + 25); ah = (ah + 150) % 360; }
  const c = Math.min(1, d.corruption || 0);
  if (c >= 0.5) { h = Math.round(h + (280 - h) * (c - 0.3)); s = Math.max(10, s - 25); l = Math.max(30, l - 12); }
  const hsl = (H, S, L) => `hsl(${Math.round(((H % 360) + 360) % 360)} ${Math.round(S)}% ${Math.round(L)}%)`;
  return {
    b: hsl(h, s, l),
    B: hsl(h, s - 6, l - 14),
    h: hsl(h, s - 10, Math.min(96, l + 12)),
    O: hsl(h, Math.min(40, s), Math.max(12, l - 42)),
    l: hsl(h, Math.max(15, s - 25), Math.min(96, l + 30)),
    a: hsl(ah, 62, 58),
    A: hsl(ah, 55, 42),
    e: '#1b1a2b', w: '#ffffff', p: '#ff8fa3', k: '#f4a73b', d: '#2c2638',
    f: hsl(h, Math.min(35, s), Math.max(22, l - 28)),
    g: '#62f3ff', G: '#2f3142', n: '#8a5a34', m: '#cfd6de', S: hsl(ah, 70, 50), C: hsl(ah + 180, 55, 40),
    Y: '#ffd34d', y: '#d9a21b', v: '#59d36b', E: '#fff1d0', e2: '#e4cfa4',
  };
}

// ---------------------------------------------------------------- grid helpers

function makeGrid() { return Array.from({ length: SPRITE_H }, () => new Array(SPRITE_W).fill(null)); }

class Builder {
  constructor() { this.g = makeGrid(); this.dy = 0; }
  set(x, y, c, raw = false) {
    const gx = x + OX, gy = y + OY + (raw ? 0 : this.dy);
    if (gx >= 0 && gx < SPRITE_W && gy >= 0 && gy < SPRITE_H) this.g[gy][gx] = c;
  }
  under(x, y, c, raw = false) {
    const gx = x + OX, gy = y + OY + (raw ? 0 : this.dy);
    if (gx >= 0 && gx < SPRITE_W && gy >= 0 && gy < SPRITE_H && !this.g[gy][gx]) this.g[gy][gx] = c;
  }
  rows(y0, strs) {
    strs.forEach((row, i) => [...row].forEach((ch, x) => { if (ch !== '.') this.set(x, y0 + i, ch); }));
  }
  each(points, c) { for (const [x, y] of points) this.set(x, y, c); }
  mirror(points, c) { for (const [x, y] of points) { this.set(x, y, c); this.set(15 - x, y, c); } }
}

// ---------------------------------------------------------------- body parts

const HEAD = [
  '....bbbbbbbb....',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '...bbbbbbbbbb...',
  '....bbbbbbbb....',
];
const BODY = [
  '.....bbbbbb.....',
  '....bbllllbb....',
  '.....bbbbbb.....',
];

function eyes(b, style, state) {
  if (state === 'blink' || state === 'sleep') { b.each([[5, 7], [6, 7], [9, 7], [10, 7]], 'e'); return; }
  if (state === 'dizzy') { b.each([[5, 6], [6, 7], [10, 6], [9, 7]], 'e'); return; }
  if (state === 'happy' || style === 'happy') { b.each([[4, 7], [5, 6], [6, 7], [9, 7], [10, 6], [11, 7]], 'e'); return; }
  if (style === 'dot') { b.each([[6, 6], [6, 7], [9, 6], [9, 7]], 'e'); return; }
  b.each([[5, 6], [6, 6], [5, 7], [6, 7], [9, 6], [10, 6], [9, 7], [10, 7]], 'e');
  b.each([[5, 6], [9, 6]], 'w');
  if (style === 'sparkle') b.each([[6, 7], [10, 7]], 'w');
}

function pattern(b, kind, species) {
  if (species === 'bot') return;
  switch (kind) {
    case 'spots': b.each([[5, 4], [10, 3], [11, 5], [4, 9]], 'a'); break;
    case 'stripes': b.each([[6, 3], [7, 3], [8, 3], [9, 3], [7, 4], [8, 4]], 'a'); break;
    case 'mask': b.each([[4, 6], [4, 7], [7, 6], [8, 6], [11, 6], [11, 7]], 'A'); break;
    case 'belly': b.each([[6, 13], [7, 13], [8, 13], [9, 13]], 'l'); break;
  }
}

const SPECIES = {
  owl(b) {
    b.mirror([[3, 1], [3, 2], [4, 2]], 'b');                   // ear tufts
    b.mirror([[4, 5], [5, 5], [6, 5], [4, 6], [4, 7], [4, 8], [5, 8], [6, 8], [7, 6]], 'l'); // face disc
    b.each([[7, 8], [8, 8], [7, 9], [8, 9]], 'k');             // beak
    b.mirror([[4, 11], [3, 12], [4, 13]], 'B');                // wings
  },
  fox(b) {
    b.mirror([[3, 0], [3, 1], [4, 1], [3, 2], [4, 2], [5, 2]], 'b'); // ears
    b.mirror([[4, 2]], 'p');
    b.mirror([[5, 8], [6, 8], [5, 9], [6, 9], [7, 9], [6, 10], [7, 10], [2, 8]], 'l'); // muzzle + cheek fur
    b.each([[7, 8], [8, 8]], 'd');                             // nose
    b.each([[12, 12], [13, 12], [12, 11], [13, 11], [14, 11], [13, 10], [14, 10], [15, 10]], 'b'); // tail
    b.each([[14, 9], [15, 9], [16, 10], [16, 9]], 'l');        // tail tip
  },
  bot(b) {
    b.mirror([[3, 3], [3, 10]], 'b');                          // square head
    b.each([[7, 2], [8, 2]], 'd');                             // antenna stick
    b.each([[7, 0], [8, 0], [7, 1], [8, 1]], 'a');             // antenna ball
    for (let x = 4; x <= 11; x++) { b.set(x, 6, 'd'); b.set(x, 7, 'd'); } // visor
    b.each([[6, 9], [7, 9], [8, 9], [9, 9]], 'd');             // mouth grill
    b.each([[7, 12], [8, 12]], 'a');                           // chest light
  },
  bunny(b) {
    for (let y = -2; y <= 2; y++) { b.mirror([[3, y], [4, y], [5, y]], 'b'); b.mirror([[4, y]], y > -2 ? 'p' : 'b'); }
    b.each([[7, 8], [8, 8]], 'p');
    b.each([[7, 9], [8, 9]], 'w');                             // buck teeth
    b.each([[12, 12], [13, 12], [12, 13], [13, 11]], 'l');     // puff tail
  },
  cat(b) {
    b.mirror([[4, 1], [3, 2], [4, 2], [5, 2]], 'b');           // ears
    b.mirror([[4, 2]], 'p');
    b.each([[7, 8], [8, 8]], 'p');
    b.mirror([[1, 8], [1, 9]], 'd');                           // whiskers
    b.each([[12, 12], [13, 12], [14, 11], [14, 10], [15, 9], [15, 8]], 'b'); // curly tail
    b.each([[14, 10], [15, 8]], 'a');
  },
};

const ACCESSORIES = {
  glasses(b) {
    for (const x0 of [4, 9]) {
      b.each([[x0, 5], [x0 + 1, 5], [x0 + 2, 5], [x0, 8], [x0 + 1, 8], [x0 + 2, 8]], 'G');
      b.each([[x0 - (x0 === 4 ? 0 : 0), 6], [x0, 7], [x0 + 2, 6], [x0 + 2, 7]], 'G');
    }
    b.each([[7, 6], [8, 6]], 'G');
  },
  hammer(b) {
    b.each([[14, 10], [14, 11], [14, 12], [14, 13]], 'n');
    b.each([[13, 8], [14, 8], [15, 8], [13, 9], [14, 9], [15, 9]], 'm');
  },
  antenna(b) { b.mirror([[2, 6], [2, 7]], 'a'); b.each([[12, 9], [11, 10]], 'G'); },
  scarf(b) {
    for (let x = 4; x <= 11; x++) b.set(x, 11, 'S');
    b.each([[11, 12], [12, 12], [12, 13]], 'S');
  },
  cape(b) { b.mirror([[3, 11], [3, 12], [3, 13], [4, 13], [4, 14]], 'C'); },
};

function feet(b, pose, frame, species) {
  const c = species === 'bot' ? 'd' : 'f';
  let L = 14, R = 14;
  if (pose === 'walk') { if (frame === 0) R = 15; if (frame === 2) L = 15; }
  b.set(5, L, c, true); b.set(6, L, c, true); b.set(9, R, c, true); b.set(10, R, c, true);
}

function arms(b, pose, frame) {
  if (pose === 'work') { const y = frame ? 11 : 12; b.set(3, y, 'b'); b.set(12, frame ? 12 : 11, 'b'); }
  if (pose === 'cheer' || pose === 'cast') { b.mirror([[3, 10], [2, 9]], 'b'); if (pose === 'cast') b.mirror([[2, 8]], 'g'); }
  if (pose === 'attack') { b.each([[12, 11], [13, 10], [14, 9]], 'b'); b.each([[15, 8], [16, 7]], 'm'); }
}

// ---------------------------------------------------------------- post-processing

function shadeAndOutline(g) {
  const H = g.length, W = g[0].length;
  const empty = (x, y) => x < 0 || y < 0 || x >= W || y >= H || !g[y][x];
  const out = g.map((r) => r.slice());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = g[y][x];
    if (c === 'b') {
      if (empty(x + 1, y) || empty(x, y + 1)) out[y][x] = 'B';
      else if (empty(x, y - 1) || empty(x - 1, y)) out[y][x] = 'h';
    }
  }
  const NO_OUTLINE = new Set(['g', 'Y', 'v']);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (g[y][x]) continue;
    const n = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    if (n.some(([nx, ny]) => !empty(nx, ny) && !NO_OUTLINE.has(g[ny][nx]))) out[y][x] = 'O';
  }
  return out;
}

function paint(g, pal) {
  const cv = typeof OffscreenCanvas !== 'undefined' && !globalThis.__noOffscreen
    ? new OffscreenCanvas(SPRITE_W, SPRITE_H)
    : Object.assign(document.createElement('canvas'), { width: SPRITE_W, height: SPRITE_H });
  const ctx = cv.getContext('2d');
  for (let y = 0; y < SPRITE_H; y++) for (let x = 0; x < SPRITE_W; x++) {
    const c = g[y][x];
    if (!c) continue;
    ctx.fillStyle = pal[c] || pal.b;
    ctx.fillRect(x, y, 1, 1);
  }
  return cv;
}

// ---------------------------------------------------------------- public API

/**
 * @param {object} d familiar description from core/evolution.js describe()
 * @param {string} pose idle | walk | work | sleep | cheer | cast | attack
 * @param {number} frame animation frame
 * @param {string} eyeState '' | blink | sleep | dizzy | happy
 */
export function getSprite(d, pose = 'idle', frame = 0, eyeState = '') {
  const key = `${d.key}|${d.stage}|${d.species}|${d.branch}|${d.accessory}|${d.shiny}|${d.corruption >= 0.5}|${pose}|${frame}|${eyeState}`;
  let cv = cache.get(key);
  if (cv) return cv;
  const b = new Builder();
  const species = d.species || 'egg';
  const g = d.genome || {};

  if (species === 'egg') {
    b.dy = pose === 'walk' && frame % 2 ? -1 : 0;
    const egg = [[6, 9, 4], [5, 10, 5], [4, 11, 6], [4, 11, 7], [3, 12, 8], [3, 12, 9], [3, 12, 10], [3, 12, 11], [4, 11, 12], [4, 11, 13], [5, 10, 14]];
    for (const [x0, x1, y] of egg) for (let x = x0; x <= x1; x++) b.set(x, y, (x + y) % 7 === 0 && g.pattern !== 'plain' ? 'a' : 'E');
    b.each([[5, 6], [10, 9], [6, 12], [9, 13]], 'a');
    for (let y = 10; y <= 14; y++) b.set(11 - (y > 12 ? 1 : 0), y, 'e2');
    if (eyeState !== 'sleep' && eyeState !== 'blink') b.each([[6, 9], [9, 9]], 'e'); else b.each([[6, 9], [9, 9]], 'e2');
    if (pose === 'walk') { b.set(5, 15, 'f', true); b.set(10, frame % 2 ? 15 : 14, 'f', true); }
    const pal = paletteFor({ ...d, species: 'egg' });
    pal.f = '#c58b4d';
    cv = paint(shadeAndOutline(b.g), pal);
    cache.set(key, cv);
    return cv;
  }

  const bob = pose === 'idle' ? (frame % 2) : pose === 'walk' ? (frame % 2 ? -1 : 0) : pose === 'sleep' ? 1 : pose === 'cheer' ? -1 : 0;
  b.dy = bob;
  if (d.accessory === 'cape' || d.stage >= 4) ACCESSORIES.cape(b);
  b.rows(3, HEAD);
  if (d.stage === 1) {
    // Hatchling: still wearing the bottom half of its egg.
    for (let x = 3; x <= 12; x++) { if (x % 2) b.set(x, 11, 'E'); for (let y = 12; y <= 14; y++) b.set(x, y, 'E'); }
    for (let x = 4; x <= 11; x++) b.set(x, 15, 'E');
    b.each([[12, 12], [12, 13], [11, 14], [11, 15]], 'e2');
  } else {
    b.rows(11, BODY);
  }
  SPECIES[species]?.(b);
  pattern(b, g.pattern, species);
  if (species !== 'bot') b.each([[4, 8], [11, 8]], 'p');
  if (species === 'bot') {
    if (eyeState === 'blink' || eyeState === 'sleep') b.each([[5, 7], [6, 7], [9, 7], [10, 7]], 'A');
    else b.each([[5, 6], [6, 6], [9, 6], [10, 6], [5, 7], [10, 7]], 'g');
  } else {
    eyes(b, g.eyes, eyeState);
  }
  if (d.stage >= 2 && d.accessory && d.accessory !== 'cape' && ACCESSORIES[d.accessory]) ACCESSORIES[d.accessory](b);
  if (d.stage >= 3 && d.branch === 'zen') {
    if (species === 'bot') b.each([[7, 0], [8, 0], [7, 1], [8, 1]], 'v');
    else b.each([[7, 2], [7, 1], [6, 0], [8, 1], [9, 0]], 'v');
  }
  if (d.stage >= 3 && d.branch === 'alchemist' && d.stage !== 1) b.each([[7, 12], [8, 12], [7, 13], [8, 13]], 'Y');
  if (d.stage >= 4) {
    b.each([[6, -4], [7, -4], [8, -4], [9, -4], [5, -3], [10, -3], [6, -2], [7, -2], [8, -2], [9, -2]], 'Y');
  }
  if (d.stage >= 2) arms(b, pose, frame);
  if (d.stage !== 1) feet(b, pose, frame, species);
  cv = paint(shadeAndOutline(b.g), paletteFor(d));
  cache.set(key, cv);
  if (cache.size > 1500) cache.delete(cache.keys().next().value);
  return cv;
}

/** A data: URL portrait for DOM use (party cards, bestiary). */
const portraitCache = new Map();
export function getPortrait(d, pose = 'idle') {
  const key = `${d.key}|${d.stage}|${d.species}|${d.branch}|${d.accessory}|${d.shiny}|${d.corruption >= 0.5}|${pose}`;
  let url = portraitCache.get(key);
  if (url) return url;
  const sp = getSprite(d, pose, 0, d.stage >= 1 ? 'happy' : '');
  const cv = document.createElement('canvas');
  cv.width = SPRITE_W; cv.height = SPRITE_H;
  cv.getContext('2d').drawImage(sp, 0, 0);
  url = cv.toDataURL();
  portraitCache.set(key, url);
  return url;
}
