// A player's default "head": a deterministic identicon generated from their
// agent key, in the classic blockies style (an 8x8 grid, left-right mirrored
// so it reads as a face) — same idea as Ethereum blockies/Jazzicons, just
// seeded from a Holochain `AgentPubKey` (its base64 form, `PlayerV.keyB64`)
// instead of an address. No art, no network call: every player has a unique,
// stable head the instant they're seen, and it's swapped out for an owned
// hNFT head skin when one is equipped (see game/heads.ts).
//
// Split into pure grid/color logic (tested directly, no DOM) and a canvas
// renderer with its own cache (drawn once per key+size, reused every frame).

export const BLOCKIE_SIZE = 8;

/** A small, fast, deterministic PRNG (mulberry32) — good enough for a look,
 *  not for anything security-sensitive. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** djb2 over the key string, folded to a 32-bit seed. */
function seedFrom(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return h >>> 0;
}

export type BlockieColors = { bg: string; fg: string; fg2: string };

/** The three colors for a key: a dark background (reads against the map's
 *  near-black floor) and two brighter foreground tones. Independent of
 *  `blockieCells` — reseeded with its own suffix — so neither depends on
 *  call order. */
export function blockieColors(key: string): BlockieColors {
  const rand = mulberry32(seedFrom(`${key}:colors`));
  const hsl = (s: number, l: number) => `hsl(${Math.floor(rand() * 360)}, ${s}%, ${l}%)`;
  return { bg: hsl(35, 16), fg: hsl(65, 55), fg2: hsl(55, 42) };
}

/** An 8x8 grid, 0 = background / 1 = fg / 2 = fg2. Columns 4-7 mirror columns
 *  3-0, so the result reads as a symmetric face rather than noise. */
export function blockieCells(key: string): number[][] {
  const rand = mulberry32(seedFrom(`${key}:cells`));
  const cells: number[][] = [];
  for (let row = 0; row < BLOCKIE_SIZE; row++) {
    const left: number[] = [];
    for (let col = 0; col < BLOCKIE_SIZE / 2; col++) {
      const v = rand();
      left.push(v < 0.4 ? 0 : v < 0.75 ? 1 : 2);
    }
    cells.push([...left, ...[...left].reverse()]);
  }
  return cells;
}

const cache = new Map<string, HTMLCanvasElement>();

/** A key's blockie, rendered once at `size` px and cached — later calls with
 *  the same key and size return the same canvas, ready to `drawImage`. */
export function blockieCanvas(key: string, size: number): HTMLCanvasElement {
  const cacheKey = `${key}|${size}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const colors = blockieColors(key);
  const cells = blockieCells(key);
  const cell = size / BLOCKIE_SIZE;
  const palette = [colors.bg, colors.fg, colors.fg2];
  for (let row = 0; row < BLOCKIE_SIZE; row++) {
    for (let col = 0; col < BLOCKIE_SIZE; col++) {
      ctx.fillStyle = palette[cells[row][col]];
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
  }
  cache.set(cacheKey, canvas);
  return canvas;
}
