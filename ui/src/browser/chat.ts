import { CHAT_MAX_LEN, ChatLog, chatLogHtml } from "../game/chat.js";
import type { StateV } from "../game/ui.js";
import { BrowserMovement, type SignMovement } from "./movement.js";

type ChatUpdate = {
  identity: string;
  dna: string;
  lobby: string;
  phase: StateV["phase"];
  meeting: string | null;
  players: Pick<StateV["players"][number], "keyB64" | "name" | "dead" | "color">[];
  sign: SignMovement;
};

export function mountBrowserChat() {
  const panel = document.querySelector<HTMLElement>("#browser-chat")!;
  const title = panel.querySelector("h2")!;
  const lines = panel.querySelector<HTMLElement>("#browser-chat-log")!;
  const form = panel.querySelector("form")!;
  const input = form.querySelector("input")!;
  const submit = form.querySelector("button")!;
  const status = panel.querySelector<HTMLElement>("#browser-chat-status")!;
  const log = new ChatLog();
  const peers = new Set<string>();
  let transport: BrowserMovement | null = null;
  let state: ChatUpdate | null = null;
  let key = "";
  let rendered = "";
  let timer: number | null = null;
  let lastSent = 0;
  input.maxLength = CHAT_MAX_LEN;

  function render() {
    if (!state) return;
    const text = chatLogHtml({ myKeyB64: state.identity, state: { players: state.players } }, log);
    if (text !== rendered) {
      rendered = text;
      lines.innerHTML = text;
      lines.scrollTop = lines.scrollHeight;
    }
    const connected = Boolean(transport?.connected);
    const alive = state.players.some((player) => player.keyB64 === state?.identity && !player.dead);
    input.disabled = submit.disabled = !connected || !alive;
    const note = !connected ? "Chat reconnecting…" : !alive ? "Spectating · chat is read-only" : "";
    if (note !== status.textContent) status.textContent = note;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const channel = log.current();
    const text = input.value.trim();
    const now = performance.now();
    if (!state || !transport || !channel || !text || input.disabled || now - lastSent < 450) return;
    const msg = log.compose(state.identity, channel, text);
    if (!transport.sendChat(msg)) return;
    lastSent = now;
    input.value = "";
    log.add(msg);
    render();
  });
  window.addEventListener("pagehide", () => transport?.stop());

  return {
    update(next: ChatUpdate | null) {
      state = next;
      const active = next && (next.phase === "lobby" || (next.phase === "meeting" && next.meeting)) &&
        next.players.some((player) => player.keyB64 === next.identity);
      if (!active || !next) {
        if (timer !== null) window.clearInterval(timer);
        timer = null;
        transport?.stop();
        transport = null;
        log.sync(null);
        panel.hidden = true;
        input.value = "";
        key = "";
        return;
      }

      const nextKey = JSON.stringify([next.dna, next.lobby, next.identity]);
      if (key !== nextKey) {
        key = nextKey;
        transport?.stop();
        transport = new BrowserMovement(next.dna, next.lobby, next.identity, next.sign);
        transport.onChat = (message) => {
          if (message.meeting === log.current() && peers.has(message.hc) && log.add(message)) render();
        };
      }
      log.sync({ phase: next.phase, code: next.lobby, active_meeting: next.meeting ? { meetingB64: next.meeting } : null });
      peers.clear();
      for (const player of next.players) {
        if (!player.dead && player.keyB64 !== next.identity) peers.add(player.keyB64);
      }
      if (timer === null) timer = window.setInterval(() => {
        transport?.tick(performance.now(), null, peers);
        render();
      }, 200);
      title.textContent = next.phase === "lobby" ? "Lobby chat" : "Meeting chat";
      panel.hidden = false;
      render();
    },
  };
}
