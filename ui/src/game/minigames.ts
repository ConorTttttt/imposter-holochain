// Task mini-games. Using a console opens its game in a card over the map, and
// winning it finishes the task. Impostors play the very same games; only what
// happens after differs (main.ts: recorded for the crew, faked for impostors).
// The games live entirely in the player's own window, so each one is just its
// rules plus a little markup — testable without a page.

export type MiniGame = {
  readonly taskId: number;
  readonly title: string;
  /** The card's markup. Clickable parts carry data-act="mg" and data-mg. */
  html(now: number): string;
  /** A click on a data-act="mg" element; true once the game is won. */
  act(data: DOMStringMap, now: number): boolean;
  /** The slider moved (games that have one). */
  input?(value: number): void;
  /** Each frame, for moving parts; updates the card in place. */
  frame?(root: HTMLElement, now: number): void;
};

type Rng = () => number;

const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function shuffled<T>(items: T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A console's game. Unknown consoles (a map with new tasks) get a plain confirm. */
export function startMiniGame(taskId: number, title: string, now: number, rng: Rng = Math.random): MiniGame {
  switch (taskId) {
    case 0:
      return alignGame(taskId, title, rng);
    case 1:
      return fuelGame(taskId, title);
    case 2:
      return calibrateGame(taskId, title, now, rng);
    case 3:
      return shieldsGame(taskId, title, rng);
    case 4:
      return courseGame(taskId, title, rng);
    case 5:
      return scanGame(taskId, title, now);
    default:
      return confirmGame(taskId, title);
  }
}

// --- Align Engine Output: slide onto the marker, then lock --------------------

/** How close (percent of the track) counts as lined up. */
export const ALIGN_TOLERANCE = 3;

export function alignGame(taskId: number, title: string, rng: Rng): MiniGame {
  const target = between(rng, 15, 85);
  let value = target > 50 ? 5 : 95;
  let note = "";
  return {
    taskId,
    title,
    html: () => `<p class="muted">Slide the output onto the yellow marker, then lock it.</p>
      <div class="mg-track"><div class="mg-target" style="left:${target}%"></div></div>
      <input id="mg-slider" type="range" min="0" max="100" value="${value}" style="width:100%" />
      <div class="row"><button class="primary" data-act="mg" data-mg="lock">Lock</button><span class="muted">${note}</span></div>`,
    input: (v) => {
      value = v;
    },
    act: (data) => {
      if (data.mg !== "lock") return false;
      if (Math.abs(value - target) <= ALIGN_TOLERANCE) return true;
      note = "Not lined up yet.";
      return false;
    },
  };
}

// --- Fuel Lower Engine: pump until full ----------------------------------------

export const PUMPS_NEEDED = 6;

export function fuelGame(taskId: number, title: string): MiniGame {
  let pumps = 0;
  return {
    taskId,
    title,
    html: () => `<p class="muted">Pump fuel into the engine.</p>
      <div class="mg-gauge"><div class="mg-fill" style="width:${(pumps / PUMPS_NEEDED) * 100}%"></div></div>
      <button class="primary" data-act="mg" data-mg="pump">Pump (${pumps}/${PUMPS_NEEDED})</button>`,
    act: (data) => {
      if (data.mg === "pump") pumps++;
      return pumps >= PUMPS_NEEDED;
    },
  };
}

// --- Calibrate Distributor: stop the needle in the green zone ------------------

/** Needle speed: a full turn every 1.44 s. */
export const DIAL_DEG_PER_MS = 0.25;
export const ZONE_WIDTH = 50;
export const HITS_NEEDED = 3;

/** Where the needle points (degrees clockwise from the top). */
export function needleAngle(startedAt: number, now: number): number {
  return ((now - startedAt) * DIAL_DEG_PER_MS) % 360;
}

/** Whether an angle falls in the zone starting at `start` and `width` degrees wide. */
export function inZone(angle: number, start: number, width: number): boolean {
  return (((angle - start) % 360) + 360) % 360 <= width;
}

export function calibrateGame(taskId: number, title: string, now: number, rng: Rng): MiniGame {
  const startedAt = now;
  let zone = between(rng, 0, 359);
  let hits = 0;
  let note = "";
  return {
    taskId,
    title,
    html: () => `<p class="muted">Stop the needle in the green zone (${hits}/${HITS_NEEDED}).</p>
      <div class="mg-dial" style="background:conic-gradient(from ${zone}deg, #238636 0deg ${ZONE_WIDTH}deg, #0d1524 ${ZONE_WIDTH}deg 360deg)">
        <div class="mg-needle" id="mg-needle"></div>
      </div>
      <div class="row"><button class="primary" data-act="mg" data-mg="stop">Stop</button><span class="muted">${note}</span></div>`,
    frame: (root, now) => {
      const needle = root.querySelector<HTMLElement>("#mg-needle");
      if (needle) needle.style.transform = `rotate(${needleAngle(startedAt, now)}deg)`;
    },
    act: (data, now) => {
      if (data.mg !== "stop") return false;
      if (inZone(needleAngle(startedAt, now), zone, ZONE_WIDTH)) {
        hits++;
        note = "Good!";
        zone = between(rng, 0, 359);
      } else {
        note = "Missed — try again.";
      }
      return hits >= HITS_NEEDED;
    },
  };
}

// --- Prime Shields: click every red cell ----------------------------------------

export function shieldsGame(taskId: number, title: string, rng: Rng): MiniGame {
  const red = Array.from({ length: 8 }, () => false);
  for (const i of shuffled([...red.keys()], rng).slice(0, between(rng, 3, 5))) red[i] = true;
  return {
    taskId,
    title,
    html: () => `<p class="muted">Prime every red shield.</p>
      <div class="mg-cells">${red
        .map((r, i) => `<button class="mg-cell${r ? " red" : ""}" data-act="mg" data-mg="cell" data-i="${i}"></button>`)
        .join("")}</div>`,
    act: (data) => {
      if (data.mg === "cell") red[Number(data.i)] = false;
      return red.every((r) => !r);
    },
  };
}

// --- Chart Course: click the waypoints in order ------------------------------------

export const WAYPOINTS = 5;

export function courseGame(taskId: number, title: string, rng: Rng): MiniGame {
  // five spots spread across the chart, numbered in a random order
  const spots = Array.from({ length: WAYPOINTS }, (_, i) => ({ x: 12 + (i * 76) / (WAYPOINTS - 1), y: between(rng, 18, 82) }));
  const points = shuffled(spots, rng).map((spot, i) => ({ n: i + 1, ...spot }));
  let next = 1;
  let note = "";
  return {
    taskId,
    title,
    html: () => `<p class="muted">Chart the course: click the waypoints in order.</p>
      <div class="mg-map">${points
        .map(
          (p) =>
            `<button class="mg-point${p.n < next ? " done" : ""}" style="left:${p.x}%;top:${p.y}%" data-act="mg" data-mg="point" data-n="${p.n}">${p.n}</button>`,
        )
        .join("")}</div>
      <span class="muted">${note}</span>`,
    act: (data) => {
      if (data.mg !== "point") return false;
      if (Number(data.n) === next) {
        next++;
        note = "";
      } else {
        next = 1;
        note = "Wrong waypoint — start again from 1.";
      }
      return next > WAYPOINTS;
    },
  };
}

// --- Medbay Scan: hold still while it reads you --------------------------------

export const SCAN_HOLD_MS = 2200;

export function scanGame(taskId: number, title: string, now: number): MiniGame {
  const startedAt = now;
  const pct = (n: number) => Math.min(100, ((n - startedAt) / SCAN_HOLD_MS) * 100);
  const ready = (n: number) => n - startedAt >= SCAN_HOLD_MS;
  return {
    taskId,
    title,
    html: (now) => `<p class="muted">Stand still in the scanner. This shows everyone your role — for good.</p>
      <div class="mg-gauge"><div class="mg-fill" style="width:${pct(now)}%"></div></div>
      <button class="primary" data-act="mg" data-mg="scan" ${ready(now) ? "" : "disabled"}>${
        ready(now) ? "Confirm scan" : "Scanning…"
      }</button>`,
    frame: (root, now) => {
      const fill = root.querySelector<HTMLElement>(".mg-fill");
      if (fill) fill.style.width = `${pct(now)}%`;
      const btn = root.querySelector<HTMLButtonElement>('[data-mg="scan"]');
      if (btn) btn.disabled = !ready(now);
    },
    act: (data, now) => data.mg === "scan" && ready(now),
  };
}

// --- any other console -----------------------------------------------------------

export function confirmGame(taskId: number, title: string): MiniGame {
  return {
    taskId,
    title,
    html: () => `<p class="muted">Run the task.</p><button class="primary" data-act="mg" data-mg="confirm">Run</button>`,
    act: (data) => data.mg === "confirm",
  };
}
