import { scanGame, startMiniGame, type MiniGame } from "../game/minigames.js";
import { dist, lineOfSight, TASKS, USE_RADIUS, type TaskDef, type Wall } from "../game/world.js";
import type { Point } from "./movement-wire.js";

type TaskState = {
  scope: string;
  role: 0 | 1 | null;
  assigned: TaskDef[];
  done: number[];
  submit?: (id: number) => Promise<void>;
};

export const BROWSER_TASK_COUNTS = [1, 3, 6, TASKS.length];
export const BROWSER_DEFAULT_TASK_COUNT = 6;

export function browserTaskList(target: number, crew: number) {
  const count = Math.ceil(target / crew);
  if (!BROWSER_TASK_COUNTS.includes(count)) throw Error("Unexpected browser task count");
  return TASKS.slice(0, count).map(({ id, name, x, y }) => ({ id, name, x, y }));
}

/** The native allocator samples without replacement. When the published pool
 * contains at most the native per-seat quota, every seat gets the whole pool. */
export function browserAssignments(published: { id: number }[], target: number, crew: number) {
  if (crew < 1 || published.length > Math.ceil(target / crew)) return [];
  const ids = new Set(published.map(({ id }) => id));
  return TASKS.filter((task) => ids.has(task.id));
}

export function nearbyTask(point: Point, tasks: TaskDef[], done: ReadonlySet<number>, walls: Wall[]) {
  let nearest: TaskDef | undefined;
  let distance = USE_RADIUS;
  for (const task of tasks) {
    if (done.has(task.id)) continue;
    const candidate = dist(point.x, point.y, task.x, task.y);
    if (candidate < distance && lineOfSight(point.x, point.y, task.x, task.y, walls)) {
      nearest = task;
      distance = candidate;
    }
  }
  return nearest;
}

export function mountBrowserTasks(panel: HTMLElement, canvas: HTMLCanvasElement) {
  const use = panel.querySelector<HTMLButtonElement>("#use-console")!;
  const list = panel.querySelector<HTMLElement>("#console-tasks")!;
  const dialog = panel.querySelector<HTMLDialogElement>("#console-game")!;
  const heading = dialog.querySelector("h3")!;
  const body = dialog.querySelector<HTMLElement>(".console-body")!;
  const status = panel.querySelector<HTMLElement>("#console-status")!;
  let state: TaskState | null = null;
  let game: MiniGame | null = null;
  let nearby: TaskDef | undefined;
  let sending = false;
  let done = new Set<number>();
  const pending = new Set<number>();
  let listLabel = "";

  function renderGame() {
    if (!game) return;
    body.innerHTML = game.html(performance.now());
  }

  function open() {
    if (!nearby || game || sending || state?.role == null) return;
    const now = performance.now();
    game = nearby.scan ? scanGame(nearby.id, nearby.name, now, false) : startMiniGame(nearby.id, nearby.name, now);
    heading.textContent = game.title;
    status.textContent = "";
    renderGame();
    dialog.showModal();
  }

  async function act(button: HTMLButtonElement) {
    if (!game || !state?.submit || state.role == null || sending) return;
    const now = performance.now();
    if (!game.act(button.dataset, now)) {
      renderGame();
      body.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    const { taskId, title } = game;
    const { scope, role, submit } = state;
    sending = true;
    dialog.close();
    status.textContent = "Completing " + title + "…";
    try {
      if (role === 0) await submit(taskId);
      if (state?.scope === scope && state.role === role) {
        pending.add(taskId);
        status.textContent = title + " complete.";
      }
    } catch {
      status.textContent = "Task submission failed. Check the connection and use the console again.";
    } finally {
      sending = false;
    }
  }

  use.addEventListener("click", open);
  canvas.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "e" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    open();
  });
  dialog.addEventListener("close", () => {
    game = null;
    body.replaceChildren();
    if (!panel.hidden) canvas.focus({ preventScroll: true });
  });
  body.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement) game?.input?.(Number(event.target.value));
  });
  body.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-act="mg"]');
    if (button) void act(button);
  });

  return {
    get active() {
      return dialog.open;
    },
    get done() {
      return [...done];
    },
    update(next: TaskState | null) {
      if (!next || (state && next.scope !== state.scope)) pending.clear();
      if (next?.role !== state?.role || next?.scope !== state?.scope) {
        if (dialog.open) dialog.close();
        nearby = undefined;
      }
      state = next;
    },
    tick(self: Point, walls: Wall[], now: number) {
      const assigned = state?.role != null ? state.assigned : [];
      for (const id of state?.done ?? []) pending.delete(id);
      done = new Set([...(state?.done ?? []), ...pending]);
      nearby = assigned.length ? nearbyTask(self, assigned, done, walls) : undefined;
      use.disabled = !nearby || sending;
      const label = nearby ? "Use " + nearby.name + " (E)" : "Use console (E)";
      if (use.textContent !== label) use.textContent = label;
      const nextLabel = JSON.stringify(assigned.map((task) => [task.id, done.has(task.id)]));
      if (listLabel !== nextLabel) {
        listLabel = nextLabel;
        list.replaceChildren(...assigned.map((task) => {
          const item = document.createElement("li");
          item.textContent = task.name + (done.has(task.id) ? " · Complete" : "");
          return item;
        }));
      }
      game?.frame?.(body, now);
    },
  };
}
