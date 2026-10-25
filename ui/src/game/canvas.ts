import { blockieCanvas } from "./blockie.js";
import { equippedHeadImage } from "./heads.js";
import { drawHotelGuest, drawHotelScene, drawHotelWalls, hotelRoomLabel } from "./hotel-art.js";
import {
  BLOCKS,
  CAMERAS,
  COMMS_PANEL,
  CRISES,
  dist,
  EMERGENCY,
  HALLS,
  LIGHTS_PANEL,
  lineOfSight,
  MAP_H,
  MAP_W,
  PLAYER_R,
  ROOMS,
  SECURITY_CONSOLE,
  TASKS,
  TUNING,
  USE_RADIUS,
  VENTS,
  VITALS,
  WALLS,
  type CrisisKind,
  type Wall,
  type Zone,
} from "./world.js";

export type Dot = {
  keyB64: string;
  name: string;
  x: number;
  y: number;
  dead: boolean;
  isMe: boolean;
  hidden: boolean; // me, in a vent: nobody else sees me, and I see myself faintly
  color: string; // the player's color (hex)
  isImpostorView: boolean; // draw a kill-range ring around me if I'm the impostor
};

export type CanvasView = {
  dots: Dot[]; // living players, plus ghosts when I'm a ghost too
  bodies: { name: string; color: string; x: number; y: number }[]; // where victims fell
  atEmergency: boolean; // I'm standing at the emergency button
  lightsOut: boolean; // sabotaged
  atLights: boolean; // I'm at the lights panel
  commsOut: boolean; // sabotaged: task lists and the task bar are dark
  atComms: boolean; // I'm at the comms panel
  atVitals: boolean; // I'm at the vitals panel
  atSecurity: boolean; // I'm at the security console
  crisis: { kind: CrisisKind; panels: boolean[] } | null; // a crisis sabotage under way
  airlockDoors: Wall[]; // the airlock doors shut on me, drawn in amber
  killRadius: number; // the host's kill distance (map px), for an impostor's ring
  walls: Wall[]; // the walls in force, shut doors included
  closedDoors: Wall[]; // shut doorways, drawn in red
  nearVent: number | null; // the vent I (an impostor) can slip into
  myTasks: number[] | null; // my secret task list; null until the host has sent it
  myDone: number[]; // the ones I've finished
  taskHold: { x: number; y: number; progress: number } | null; // Use being held, 0..1
  tasksDoneTotal: number;
  taskTarget: number;
  /** How far I see (map px); null = the whole map (no fog, or I'm a ghost). */
  vision: number | null;
};

// A player's on-screen size: a capsule body plus a flat head plate above it,
// both centered on their (x, y) — the same point walls, vision and every
// distance check already use, so nothing else needs to change.
const BODY_W = 14;
const BODY_H = 19;
const BODY_RADIUS = 5; // less than BODY_W/2, so it reads as a rounded rect, not a circle
const HEAD_SIZE = 12;
const HEAD_GAP = 1;

// The canvas is a fixed-size window onto the map, not the whole map at once —
// the map (MAP_W x MAP_H) is bigger than what fits on screen. `ZOOM` makes
// everything bigger on screen too (a player is ZOOM times the size they'd be
// at 1:1); the camera follows me, clamped so it never shows past the map's
// edge. `VIEW_W`/`VIEW_H` are the canvas element's own pixel size (its
// `width`/`height` attributes, set from these in main.ts) — independent of
// the map's size.
export const VIEW_W = 860;
export const VIEW_H = 520;
export const ZOOM = 1.7;

/** Where the camera centres on one axis: `target` (a player's position),
 *  pulled in so the visible span (`viewSize / zoom`) never runs past
 *  `[0, mapSize]`. A map narrower than the view (won't happen here, but keeps
 *  this safe) just centres it instead of dividing by a negative span. */
export function clampCamera(target: number, viewSize: number, zoom: number, mapSize: number): number {
  const half = viewSize / zoom / 2;
  if (mapSize <= half * 2) return mapSize / 2;
  return Math.max(half, Math.min(mapSize - half, target));
}

export function draw(ctx: CanvasRenderingContext2D, v: CanvasView): void {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  // Only what's within my vision is drawn; the rest isn't drawn at all, so
  // neither a dot nor a name gives anyone away. Also where the camera centres.
  const me = v.dots.find((d) => d.isMe);
  const camX = clampCamera(me?.x ?? MAP_W / 2, VIEW_W, ZOOM, MAP_W);
  const camY = clampCamera(me?.y ?? MAP_H / 2, VIEW_H, ZOOM, MAP_H);
  ctx.save();
  ctx.translate(VIEW_W / 2, VIEW_H / 2);
  ctx.scale(ZOOM, ZOOM);
  ctx.translate(-camX, -camY);

  // Art stays underneath entities and the existing fog/occlusion passes.
  drawHotelScene(ctx, Date.now(), v.lightsOut);
  ctx.lineWidth = 2;

  // emergency button
  ctx.beginPath();
  ctx.arc(EMERGENCY.x, EMERGENCY.y, 14, 0, Math.PI * 2);
  ctx.fillStyle = "#b3341f";
  ctx.fill();
  ctx.strokeStyle = "#ff6b52";
  ctx.stroke();
  if (v.atEmergency) {
    ctx.beginPath();
    ctx.arc(EMERGENCY.x, EMERGENCY.y, 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 107, 82, 0.6)";
    ctx.stroke();
  }

  // the lights panel, flashing while the lights are out
  const flash = Date.now() % 1000 < 500;
  ctx.fillStyle = v.lightsOut ? (flash ? "#ff6b52" : "#8a2d1e") : "#33405a";
  ctx.fillRect(LIGHTS_PANEL.x - 9, LIGHTS_PANEL.y - 7, 18, 14);
  if (v.lightsOut && v.atLights) {
    ctx.strokeStyle = "rgba(208, 167, 44, 0.8)";
    ctx.strokeRect(LIGHTS_PANEL.x - 14, LIGHTS_PANEL.y - 12, 28, 24);
  }

  // the comms panel: an antenna dish, static-flecked while comms are down
  ctx.fillStyle = v.commsOut ? (flash ? "#ff6b52" : "#8a2d1e") : "#33405a";
  ctx.beginPath();
  ctx.arc(COMMS_PANEL.x, COMMS_PANEL.y, 9, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(COMMS_PANEL.x - 1.5, COMMS_PANEL.y - 2, 3, 12);
  if (v.commsOut && v.atComms) {
    ctx.strokeStyle = "rgba(208, 167, 44, 0.8)";
    ctx.strokeRect(COMMS_PANEL.x - 15, COMMS_PANEL.y - 13, 30, 26);
  }

  // the vitals panel: a monitor with a heartbeat trace
  ctx.fillStyle = "#12261c";
  ctx.fillRect(VITALS.x - 12, VITALS.y - 9, 24, 18);
  ctx.strokeStyle = "#3fb950";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(VITALS.x - 9, VITALS.y);
  ctx.lineTo(VITALS.x - 3, VITALS.y);
  ctx.lineTo(VITALS.x - 1, VITALS.y - 6);
  ctx.lineTo(VITALS.x + 2, VITALS.y + 5);
  ctx.lineTo(VITALS.x + 4, VITALS.y);
  ctx.lineTo(VITALS.x + 9, VITALS.y);
  ctx.stroke();
  ctx.lineWidth = 2;
  if (v.atVitals) {
    ctx.strokeStyle = "rgba(63, 185, 80, 0.8)";
    ctx.strokeRect(VITALS.x - 16, VITALS.y - 13, 32, 26);
  }

  // the security console, and the cameras it watches through
  ctx.fillStyle = "#14233a";
  ctx.fillRect(SECURITY_CONSOLE.x - 14, SECURITY_CONSOLE.y - 9, 28, 18);
  ctx.strokeStyle = "#58a6ff";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(SECURITY_CONSOLE.x - 10, SECURITY_CONSOLE.y - 6, 9, 12);
  ctx.strokeRect(SECURITY_CONSOLE.x + 1, SECURITY_CONSOLE.y - 6, 9, 12);
  if (v.atSecurity) {
    ctx.strokeStyle = "rgba(88, 166, 255, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(SECURITY_CONSOLE.x - 18, SECURITY_CONSOLE.y - 13, 36, 26);
  }
  for (const c of CAMERAS) {
    ctx.fillStyle = "#58a6ff";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 2;

  // crisis consoles: every kind's, so routes can be learned; the running
  // crisis's flash red until fixed (green), the rest sit dim
  for (const [kind, c] of Object.entries(CRISES) as [CrisisKind, (typeof CRISES)[CrisisKind]][]) {
    c.panels.forEach((p, i) => {
      const live = v.crisis?.kind === kind;
      const fixed = live && v.crisis!.panels[i];
      ctx.fillStyle = !live ? "#2a2f3a" : fixed ? "#2ea043" : flash ? "#ff6b52" : "#8a2d1e";
      ctx.fillRect(p.x - 9, p.y - 9, 18, 18);
      ctx.strokeStyle = "#0b0f17";
      ctx.strokeRect(p.x - 9, p.y - 9, 18, 18);
    });
  }

  // vents: grates in the floor; the one an impostor stands at is outlined
  for (const vent of VENTS) {
    ctx.fillStyle = "#1c2431";
    ctx.fillRect(vent.x - 12, vent.y - 8, 24, 16);
    ctx.strokeStyle = "#3b4a61";
    ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i += 4) {
      ctx.beginPath();
      ctx.moveTo(vent.x + i, vent.y - 6);
      ctx.lineTo(vent.x + i, vent.y + 6);
      ctx.stroke();
    }
    if (v.nearVent === vent.id) {
      ctx.strokeStyle = "rgba(255, 107, 107, 0.8)";
      ctx.lineWidth = 2;
      ctx.strokeRect(vent.x - 16, vent.y - 12, 32, 24);
    }
  }
  ctx.lineWidth = 2;

  // task consoles: mine to do (yellow), mine done (green), anyone else's (dim).
  // Nobody sees another player's list, or when they finish a task.
  for (const t of TASKS) {
    const mine = v.myTasks?.includes(t.id) ?? false;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = !mine ? "#33405a" : v.myDone.includes(t.id) ? "#2ea043" : "#d0a72c";
    ctx.fill();
    ctx.strokeStyle = "#0b0f17";
    ctx.stroke();
  }

  // bodies, where their victims fell — under the players walking past them
  for (const b of v.bodies) {
    if (!inSight(me, v.vision, b.x, b.y, v.walls)) continue;
    ctx.beginPath();
    ctx.arc(b.x, b.y, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.strokeStyle = "#0b0f17";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "#ff6b6b";
    ctx.beginPath();
    ctx.moveTo(b.x - 6, b.y - 6);
    ctx.lineTo(b.x + 6, b.y + 6);
    ctx.moveTo(b.x + 6, b.y - 6);
    ctx.lineTo(b.x - 6, b.y + 6);
    ctx.stroke();
    label(ctx, b.name, b.x, b.y, "#6b7480");
  }

  // players; a ghost (only ever passed in when I'm one too) is drawn faint.
  // A plain capsule body (tinted the player's color, as the dot used to be)
  // with a flat head plate on top — a socket for a "head", not a sculpted
  // one, so any square image drops in undistorted. Its default is the
  // player's blockie (game/blockie.ts): a deterministic identicon from their
  // agent key, so everyone has a distinct face with no art and no lookup.
  // Later, an owned hNFT head skin draws here instead (game/heads.ts).
  for (const d of v.dots) {
    if (!inSight(me, v.vision, d.x, d.y, v.walls)) continue;
    ctx.globalAlpha = d.dead || d.hidden ? 0.45 : 1;
    if (d.isImpostorView && !d.dead) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, v.killRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,107,107,0.25)";
      ctx.stroke();
    }
    const bodyTop = d.y - BODY_H / 2;
    const headTop = bodyTop - HEAD_GAP - HEAD_SIZE;
    const outline = d.isMe ? "#e6edf3" : "#0b0f17"; // a light outline marks me

    ctx.beginPath();
    ctx.roundRect(d.x - BODY_W / 2, bodyTop, BODY_W, BODY_H, BODY_RADIUS);
    ctx.fillStyle = d.color;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = d.isMe ? 3 : 2;
    ctx.stroke();

    const inset = 1;
    ctx.beginPath();
    ctx.roundRect(d.x - HEAD_SIZE / 2, headTop, HEAD_SIZE, HEAD_SIZE, 3);
    ctx.fillStyle = "#1c2431";
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(d.x - HEAD_SIZE / 2 + inset, headTop + inset, HEAD_SIZE - inset * 2, HEAD_SIZE - inset * 2, 2);
    ctx.clip();
    ctx.drawImage(
      equippedHeadImage(d.keyB64) ?? blockieCanvas(d.keyB64, HEAD_SIZE - inset * 2),
      d.x - HEAD_SIZE / 2 + inset,
      headTop + inset,
      HEAD_SIZE - inset * 2,
      HEAD_SIZE - inset * 2,
    );
    ctx.restore();
    drawHotelGuest(ctx, d.keyB64, d.x, bodyTop, headTop);

    ctx.lineWidth = 2;
    label(ctx, d.name, d.x, d.y, "#f3e5c9", HEAD_SIZE + HEAD_GAP + BODY_H / 2);
    ctx.globalAlpha = 1;
  }

  // Walls block sight: whatever lies behind a wall, seen from me, is in shadow.
  // Each wall casts a quad from its ends out past the edge of the map.
  if (me && v.vision !== null) {
    const far = (x: number, y: number): [number, number] => {
      const k = 2000 / Math.max(1, Math.hypot(x - me.x, y - me.y));
      return [me.x + (x - me.x) * k, me.y + (y - me.y) * k];
    };
    ctx.fillStyle = "rgba(8, 16, 17, 0.94)";
    for (const w of v.walls) {
      const [fax, fay] = far(w.ax, w.ay);
      const [fbx, fby] = far(w.bx, w.by);
      ctx.beginPath();
      ctx.moveTo(w.ax, w.ay);
      ctx.lineTo(w.bx, w.by);
      ctx.lineTo(fbx, fby);
      ctx.lineTo(fax, fay);
      ctx.closePath();
      ctx.fill();
    }
  }
  drawHotelWalls(ctx, WALLS);
  ctx.strokeStyle = "#ff6b52";
  for (const w of v.closedDoors) {
    ctx.beginPath();
    ctx.moveTo(w.ax, w.ay);
    ctx.lineTo(w.bx, w.by);
    ctx.stroke();
  }
  ctx.strokeStyle = "#d0a72c";
  for (const w of v.airlockDoors) {
    ctx.beginPath();
    ctx.moveTo(w.ax, w.ay);
    ctx.lineTo(w.bx, w.by);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  ctx.lineCap = "butt";

  // debug labels: every room's name, over the shadows so it always reads
  ctx.font = "bold 13px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const r of ROOMS) {
    ctx.fillStyle = ZONE_LABEL[r.zone];
    ctx.fillText(hotelRoomLabel(r.name), r.x + r.w / 2, r.y + 22);
  }
  ctx.textAlign = "left";

  // vision fog: clear around me, fading to near-dark at the edge of my vision
  // (the gradient's last stop covers everything beyond it)
  if (me && v.vision !== null) {
    const fog = ctx.createRadialGradient(me.x, me.y, v.vision * 0.75, me.x, me.y, v.vision);
    fog.addColorStop(0, "rgba(6, 9, 17, 0)");
    fog.addColorStop(1, "rgba(6, 9, 17, 0.9)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, MAP_W, MAP_H);
  }

  // a held Use: a progress bar over my head
  if (v.taskHold) {
    const { x, y, progress } = v.taskHold;
    const w = 36;
    const top = y - PLAYER_R - 30;
    ctx.fillStyle = "rgba(6, 9, 17, 0.85)";
    ctx.fillRect(x - w / 2 - 1, top - 1, w + 2, 8);
    ctx.fillStyle = "#d0a72c";
    ctx.fillRect(x - w / 2, top, w * progress, 6);
  }

  ctx.restore(); // back to screen space: the world is done, only the minimap is left
  drawMinimap(ctx, me, camX, camY, v.dots.filter((d) => inSight(me, v.vision, d.x, d.y, v.walls)));
}

// Security/minimap palettes follow the hotel's four visual districts.
const ZONE_FLOOR: Record<Zone, string> = {
  forward: "#26392f",
  central: "#402b2b",
  engineering: "#302923",
  cargo: "#332b2b",
};
const ZONE_LABEL: Record<Zone, string> = {
  forward: "#c1a474",
  central: "#d4a655",
  engineering: "#a68d70",
  cargo: "#a99491",
};
const HALL_FLOOR = "#241e1c";
const BLOCK_FILL = "#614234";

// --- security cameras -------------------------------------------------------
// The security console's card: the whole ship small, each camera's view, and
// whoever those cameras can see right now. A camera sees like a player does —
// out to its range, never through a wall.

export const CAMS_W = 440;
export const CAMS_H = Math.round((CAMS_W * MAP_H) / MAP_W);

export function drawCameras(
  ctx: CanvasRenderingContext2D,
  dots: { x: number; y: number; color: string }[],
  walls: Wall[],
): number {
  const k = CAMS_W / MAP_W;
  ctx.clearRect(0, 0, CAMS_W, CAMS_H);
  ctx.fillStyle = "#060911";
  ctx.fillRect(0, 0, CAMS_W, CAMS_H);
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = HALL_FLOOR;
  for (const h of HALLS) ctx.fillRect(h.x, h.y, h.w, h.h);
  for (const r of ROOMS) {
    ctx.fillStyle = ZONE_FLOOR[r.zone];
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  ctx.fillStyle = BLOCK_FILL;
  for (const b of BLOCKS) ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = "rgba(88, 166, 255, 0.35)";
  ctx.lineWidth = 6;
  for (const c of CAMERAS) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, TUNING.cameraRange, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "#3b4a61";
  ctx.lineWidth = 8;
  for (const w of walls) {
    ctx.beginPath();
    ctx.moveTo(w.ax, w.ay);
    ctx.lineTo(w.bx, w.by);
    ctx.stroke();
  }
  let seen = 0;
  for (const d of dots) {
    const onCamera = CAMERAS.some(
      (c) => dist(c.x, c.y, d.x, d.y) <= TUNING.cameraRange && lineOfSight(c.x, c.y, d.x, d.y, walls),
    );
    if (!onCamera) continue;
    seen++;
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 26, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#58a6ff";
  for (const c of CAMERAS) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return seen;
}

// --- minimap ----------------------------------------------------------------
// Fixed in the top-right corner, in screen space (drawn after `ctx.restore()`,
// so it doesn't pan or zoom with the camera). Shows room outlines, the
// emergency button, task consoles (just their layout — not which are mine or
// done, which stays secret) and the current camera viewport, plus every dot
// this frame's main view already drew: nothing appears here that fog-of-war
// wouldn't already let me see, so it can't leak a hidden position through a
// wall the way a live tracker would.
const MINI_W = 180;
const MINI_H = (MINI_W * MAP_H) / MAP_W;
const MINI_MARGIN = 10;
const MINI_SCALE = MINI_W / MAP_W;

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  me: { x: number; y: number } | undefined,
  camX: number,
  camY: number,
  visibleDots: Dot[],
): void {
  const ox = VIEW_W - MINI_W - MINI_MARGIN;
  const oy = MINI_MARGIN;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.fillStyle = "rgba(6, 9, 17, 0.85)";
  ctx.fillRect(0, 0, MINI_W, MINI_H);
  ctx.strokeStyle = "#d4a655";
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, MINI_W, MINI_H);

  ctx.fillStyle = "#2a211e";
  for (const h of HALLS) ctx.fillRect(h.x * MINI_SCALE, h.y * MINI_SCALE, h.w * MINI_SCALE, h.h * MINI_SCALE);
  for (const r of ROOMS) {
    ctx.fillStyle = ZONE_LABEL[r.zone] + "55";
    ctx.fillRect(r.x * MINI_SCALE, r.y * MINI_SCALE, r.w * MINI_SCALE, r.h * MINI_SCALE);
  }

  ctx.fillStyle = "#5a3a2a";
  for (const t of TASKS) {
    ctx.beginPath();
    ctx.arc(t.x * MINI_SCALE, t.y * MINI_SCALE, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#b3341f";
  ctx.beginPath();
  ctx.arc(EMERGENCY.x * MINI_SCALE, EMERGENCY.y * MINI_SCALE, 2, 0, Math.PI * 2);
  ctx.fill();

  for (const d of visibleDots) {
    ctx.fillStyle = d.isMe ? "#e6edf3" : d.color;
    ctx.beginPath();
    ctx.arc(d.x * MINI_SCALE, d.y * MINI_SCALE, d.isMe ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // the camera viewport, so the big view's edges make sense on the minimap
  if (me) {
    ctx.strokeStyle = "rgba(230, 237, 243, 0.5)";
    ctx.strokeRect(
      (camX - VIEW_W / ZOOM / 2) * MINI_SCALE,
      (camY - VIEW_H / ZOOM / 2) * MINI_SCALE,
      (VIEW_W / ZOOM) * MINI_SCALE,
      (VIEW_H / ZOOM) * MINI_SCALE,
    );
  }
  ctx.restore();
}

/** Whether a spot is visible from `me`: within my vision radius and not behind
 *  a wall — or anywhere, with no fog or as a ghost. The one place visibility is
 *  decided: bodies and players both go through it. */
function inSight(
  me: { x: number; y: number } | undefined,
  vision: number | null,
  x: number,
  y: number,
  walls: Wall[],
): boolean {
  return vision === null || !me || (dist(me.x, me.y, x, y) <= vision && lineOfSight(me.x, me.y, x, y, walls));
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, topOffset = PLAYER_R): void {
  ctx.fillStyle = color;
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y - topOffset - 5);
  ctx.textAlign = "left";
}

export { USE_RADIUS };
