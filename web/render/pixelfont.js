// A tiny 3x5 bitmap font for crisp in-canvas labels (names, +XP, $).
// Each glyph is 15 bits, row-major, top-left = highest bit.

const G = {
  A: 0b010101111101101, B: 0b110101110101110, C: 0b011100100100011, D: 0b110101101101110,
  E: 0b111100110100111, F: 0b111100110100100, G: 0b011100101101011, H: 0b101101111101101,
  I: 0b111010010010111, J: 0b001001001101010, K: 0b101101110101101, L: 0b100100100100111,
  M: 0b101111111101101, N: 0b110101101101101, O: 0b010101101101010, P: 0b110101110100100,
  Q: 0b010101101110011, R: 0b110101110101101, S: 0b011100010001110, T: 0b111010010010010,
  U: 0b101101101101111, V: 0b101101101101010, W: 0b101101111111101, X: 0b101101010101101,
  Y: 0b101101010010010, Z: 0b111001010100111,
  0: 0b111101101101111, 1: 0b010110010010111, 2: 0b110001010100111, 3: 0b110001010001110,
  4: 0b101101111001001, 5: 0b111100110001110, 6: 0b011100111101111, 7: 0b111001010010010,
  8: 0b111101111101111, 9: 0b111101111001110,
  '+': 0b000010111010000, '-': 0b000000111000000, '$': 0b011110010011110, '.': 0b000000000000010,
  ':': 0b000010000010000, '!': 0b010010010000010, '?': 0b110001010000010, '%': 0b101001010100101,
  '/': 0b001001010100100, '×': 0b000101010101000, '#': 0b101111101111101, ' ': 0,
  '@': 0b010101111100011, "'": 0b010010000000000, '<': 0b001010100010001, '>': 0b100010001010100,
  '(': 0b010100100100010, ')': 0b010001001001010, '=': 0b000111000111000, '_': 0b000000000000111,
};

const ACCENTS = { À: 'A', Á: 'A', Ả: 'A', Ã: 'A', Ạ: 'A', Ă: 'A', Â: 'A', Đ: 'D', È: 'E', É: 'E', Ê: 'E', Ì: 'I', Í: 'I', Ò: 'O', Ó: 'O', Ô: 'O', Ơ: 'O', Ù: 'U', Ú: 'U', Ư: 'U', Ý: 'Y' };

function norm(ch) {
  const u = ch.toUpperCase();
  if (G[u] !== undefined) return u;
  const base = u.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (G[base] !== undefined) return base;
  return ACCENTS[u] || '?';
}

export function textWidth(text, scale = 1) {
  return Math.max(0, String(text).length * 4 - 1) * scale;
}

/** Draw text at integer coordinates. Optional 1px outline makes it readable on any background. */
export function drawText(ctx, text, x, y, color = '#fff', { outline = null, scale = 1, align = 'left' } = {}) {
  const s = String(text);
  let ox = Math.round(align === 'center' ? x - textWidth(s, scale) / 2 : align === 'right' ? x - textWidth(s, scale) : x);
  const oy = Math.round(y);
  const pass = (col, dx, dy) => {
    ctx.fillStyle = col;
    let cx = ox;
    for (const ch of s) {
      const bits = G[norm(ch)] ?? 0;
      for (let i = 0; i < 15; i++) {
        if (bits & (1 << (14 - i))) ctx.fillRect(cx + (i % 3) * scale + dx, oy + Math.floor(i / 3) * scale + dy, scale, scale);
      }
      cx += 4 * scale;
    }
  };
  if (outline) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [1, -1], [-1, 1]]) pass(outline, dx * scale, dy * scale);
  pass(color, 0, 0);
}
