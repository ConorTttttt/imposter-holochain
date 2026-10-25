// Lightweight Canvas2D art for the Impossible Hotel. Everything is decorative:
// do not add collision here, and keep all fog-of-war and entity filtering in canvas.ts.
import { BLOCKS, HALLS, ROOMS, type Wall, type Zone } from "./world.js";
import { guestOutfit, hotelRoomName } from "./hotel.js";

type RoomColours = { floor: string; tile: string; border: string; rug: string };
const DECOR: Record<Zone, RoomColours> = {
  forward: { floor: "#26392f", tile: "#31473a", border: "#b18d55", rug: "#57312d" },
  central: { floor: "#402b2b", tile: "#503532", border: "#d4a655", rug: "#702c37" },
  engineering: { floor: "#302923", tile: "#46362c", border: "#9d7946", rug: "#43332b" },
  cargo: { floor: "#332b2b", tile: "#493934", border: "#b99760", rug: "#56353d" },
};

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Draws parquet, marble inlay, carpets and furniture on the map's existing rectangles. */
export function drawHotelScene(ctx: CanvasRenderingContext2D, now: number, lightsOut: boolean): void {
  // Hallways have thin brass edge rails and parquet floorboards.
  for (const h of HALLS) {
    rect(ctx, h.x, h.y, h.w, h.h, "#241e1c");
    ctx.save();
    ctx.beginPath();
    ctx.rect(h.x, h.y, h.w, h.h);
    ctx.clip();
    ctx.strokeStyle = "#463428";
    ctx.lineWidth = 1;
    for (let x = h.x + 22; x < h.x + h.w; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, h.y); ctx.lineTo(x, h.y + h.h); ctx.stroke();
    }
    ctx.strokeStyle = "#947347";
    ctx.lineWidth = 2;
    ctx.strokeRect(h.x + 4, h.y + 4, Math.max(0, h.w - 8), Math.max(0, h.h - 8));
    ctx.restore();
  }

  ROOMS.forEach((r, i) => {
    const p = DECOR[r.zone];
    rect(ctx, r.x, r.y, r.w, r.h, p.floor);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();

    // Staggered decorative flooring, with muted contrast for player readability.
    for (let y = r.y + 12, row = 0; y < r.y + r.h; y += 38, row++) {
      for (let x = r.x + 12 + ((row % 2) * 19); x < r.x + r.w; x += 38) {
        ctx.fillStyle = p.tile;
        ctx.globalAlpha = 0.48;
        ctx.fillRect(x, y, 31, 31);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16);
    ctx.strokeStyle = "rgba(241,218,171,.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 15, r.y + 15, r.w - 30, r.h - 30);

    // Decorative rugs are paint on the floor, not new blocking objects.
    if ([0, 4, 6, 11, 12].includes(i)) {
      const rw = Math.min(185, r.w * 0.55);
      const rh = Math.min(118, r.h * 0.45);
      const rx = r.x + (r.w - rw) / 2, ry = r.y + (r.h - rh) / 2;
      rect(ctx, rx, ry, rw, rh, p.rug);
      ctx.strokeStyle = "#b58b50"; ctx.lineWidth = 3;
      ctx.strokeRect(rx + 8, ry + 8, rw - 16, rh - 16);
      ctx.strokeStyle = "rgba(245,210,155,.55)"; ctx.lineWidth = 1;
      ctx.strokeRect(rx + 15, ry + 15, rw - 30, rh - 30);
      const cx = rx + rw / 2, cy = ry + rh / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 24, 16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 32, cy); ctx.lineTo(cx + 32, cy);
      ctx.moveTo(cx, cy - 25); ctx.lineTo(cx, cy + 25); ctx.stroke();
    }

    // Nonblocking ornamental lamps are anchored against the wall and give off
    // small warm halos. A blackout only changes the decoration, not visibility.
    const lampPositions: [number, number][] = [
      [r.x + 26, r.y + 29], [r.x + r.w - 26, r.y + 29],
      [r.x + 26, r.y + r.h - 29], [r.x + r.w - 26, r.y + r.h - 29],
    ];
    for (const [lx, ly] of lampPositions) {
      if (!lightsOut) {
        const halo = ctx.createRadialGradient(lx, ly, 3, lx, ly, 72);
        halo.addColorStop(0, "rgba(244,185,88,.18)");
        halo.addColorStop(1, "rgba(244,185,88,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(lx - 72, ly - 72, 144, 144);
      }
      ctx.fillStyle = lightsOut ? "#675b50" : "#f6cd79";
      ctx.beginPath(); ctx.arc(lx, ly, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#a27a3c"; ctx.lineWidth = 2; ctx.stroke();
    }

    // The Grand Salon chandelier is only a floor-light projection; it doesn't
    // hide the emergency button or imply a new solid object.
    if (i === 6) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const pulse = 0.7 + Math.sin(now / 1900) * 0.06;
      ctx.strokeStyle = lightsOut ? "#53423b" : `rgba(227,182,99,${pulse})`;
      ctx.lineWidth = 3;
      for (const radius of [46, 54, 76]) {
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
      }
      for (let a = 0; a < 8; a++) {
        const th = a * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(th) * 58, cy + Math.sin(th) * 58);
        ctx.lineTo(cx + Math.cos(th) * 73, cy + Math.sin(th) * 73);
        ctx.stroke();
      }
    }
    ctx.restore();
  });

  // Existing collision blocks become dark timber furniture/machinery. Their
  // exact shapes remain unchanged for collision and line-of-sight.
  for (const b of BLOCKS) {
    rect(ctx, b.x + 3, b.y + 4, b.w, b.h, "rgba(8,10,12,.5)");
    rect(ctx, b.x, b.y, b.w, b.h, "#352722");
    rect(ctx, b.x + 5, b.y + 5, Math.max(0, b.w - 10), Math.max(0, b.h - 10), "#614234");
    ctx.strokeStyle = "#ba9359"; ctx.lineWidth = 2;
    ctx.strokeRect(b.x + 3, b.y + 3, Math.max(0, b.w - 6), Math.max(0, b.h - 6));
  }
}

/** Dark walnut wall outline with brass trim; geometry remains unchanged. */
export function drawHotelWalls(ctx: CanvasRenderingContext2D, walls: Wall[]): void {
  ctx.lineCap = "round";
  for (const w of walls) {
    ctx.beginPath(); ctx.moveTo(w.ax, w.ay); ctx.lineTo(w.bx, w.by);
    ctx.strokeStyle = "#0b1111"; ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = "#69472d"; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = "#a87a45"; ctx.lineWidth = 1.3; ctx.stroke();
  }
  ctx.lineCap = "butt";
}

/** Silhouette extras for the existing coloured bodies and blockie/hNFT heads. */
export function drawHotelGuest(
  ctx: CanvasRenderingContext2D, keyB64: string, x: number, bodyTop: number, headTop: number,
): void {
  const outfit = guestOutfit(keyB64);
  ctx.save();
  // White shirt, waistcoat buttons and tailored lapels.
  ctx.fillStyle = "#f2e4c6";
  ctx.beginPath(); ctx.moveTo(x - 3, bodyTop + 3); ctx.lineTo(x, bodyTop + 10);
  ctx.lineTo(x + 3, bodyTop + 3); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#2b2020"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x - 5, bodyTop + 3); ctx.lineTo(x - 1, bodyTop + 10);
  ctx.moveTo(x + 5, bodyTop + 3); ctx.lineTo(x + 1, bodyTop + 10); ctx.stroke();
  ctx.fillStyle = "#e0ba74";
  for (const by of [bodyTop + 12, bodyTop + 16]) {
    ctx.beginPath(); ctx.arc(x, by, 0.9, 0, Math.PI * 2); ctx.fill();
  }

  // Each player gets a consistent hat shape based on their stable agent key.
  // Hat shapes are cosmetic only; never derived from the secret role.
  const brimY = headTop + 1;
  ctx.fillStyle = ["#6a4534", "#b22f3b", "#e8dfca", "#a1332f", "#6f4d92", "#456044"][outfit];
  ctx.strokeStyle = "#1b1417"; ctx.lineWidth = 1;
  ctx.beginPath();
  if (outfit === 2) { // chef's toque
    ctx.roundRect(x - 6, brimY - 8, 12, 10, 4);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#f3e5c9";
    ctx.fillRect(x - 5, brimY - 2, 10, 4);
  } else if (outfit === 3) { // bellhop cap
    ctx.roundRect(x - 6, brimY - 5, 12, 7, 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#d4a655"; ctx.fillRect(x - 5, brimY - 1, 10, 2);
  } else {
    ctx.ellipse(x, brimY, outfit === 1 ? 10 : 8, 2.5, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(x - 5, brimY - 7, 10, 7, 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "#d4a655";
    ctx.beginPath(); ctx.moveTo(x - 4, brimY - 2); ctx.lineTo(x + 4, brimY - 2); ctx.stroke();
  }
  ctx.restore();
}

export function hotelRoomLabel(legacy: string): string {
  return hotelRoomName(legacy).toUpperCase();
}

