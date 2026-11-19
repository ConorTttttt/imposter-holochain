// Lobby and meeting chat over PeerKit — ephemeral text, never on the DHT, never
// validated. Lines ride the same PeerKit connections as movement. Each line is
// tagged with its channel — `lobby:<game seed>` in the lobby, the meeting hash in
// a meeting — so a line that arrives before this window has polled its way there
// is held and shown once it does.
//
// One discussion can span several Meeting entries: a tied vote opens a runoff as
// a new Meeting (new hash) while the phase stays "meeting". The chat keeps every
// meeting hash seen since the phase entered "meeting" and resets when it leaves.
//
// Muting is enforced by every honest client, not by the network: a dead player's
// input is disabled, and receivers drop any line whose sender is dead on-chain.

import type { Model, StateV } from "./ui.js";
import { colorHex } from "./colors.js";

type ChatRoster = { state: { players: Pick<StateV["players"][number], "keyB64" | "dead" | "name" | "color">[] } | null };

export const CHAT_MAX_LEN = 200;
const MAX_LINES_PER_MEETING = 200;

export type ChatMsg = {
  k: "chat";
  id: string; // random, for de-duplication across re-sends
  hc: string; // sender's Holochain agent key (b64)
  meeting: string; // meeting action hash (b64)
  text: string;
  t: number; // sender clock, ms
};

export function isChatMsg(v: unknown): v is ChatMsg {
  const c = v as ChatMsg;
  return (
    !!c &&
    c.k === "chat" &&
    typeof c.id === "string" &&
    typeof c.hc === "string" &&
    typeof c.meeting === "string" &&
    typeof c.text === "string" &&
    typeof c.t === "number"
  );
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class ChatLog {
  private readonly byMeeting = new Map<string, Map<string, ChatMsg>>();
  private session: string[] = []; // meeting hashes (b64) of the current discussion

  /** Follow the on-chain phase; call after every state refresh. */
  sync(s: (Pick<StateV, "phase" | "code"> & {
    active_meeting: Pick<NonNullable<StateV["active_meeting"]>, "meetingB64"> | null;
  }) | null): void {
    if (s?.phase === "lobby" && s.code) {
      const lobby = `lobby:${s.code}`;
      if (this.session.length !== 1 || this.session[0] !== lobby) {
        this.clear();
        this.session = [lobby];
      }
      return;
    }
    const meeting = s?.phase === "meeting" ? s.active_meeting?.meetingB64 : undefined;
    if (meeting) {
      if (this.session[0]?.startsWith("lobby:")) this.clear();
      if (!this.session.includes(meeting)) this.session.push(meeting);
      return;
    }
    this.clear();
  }

  private clear(): void {
    for (const h of this.session) this.byMeeting.delete(h);
    this.session = [];
  }

  /** The meeting new lines are tagged with, or null outside a meeting. */
  current(): string | null {
    return this.session.at(-1) ?? null;
  }

  /** Store a line; returns false if it was a duplicate or empty. */
  add(msg: ChatMsg): boolean {
    const text = msg.text.trim().slice(0, CHAT_MAX_LEN);
    if (!text) return false;
    let lines = this.byMeeting.get(msg.meeting);
    if (!lines) this.byMeeting.set(msg.meeting, (lines = new Map()));
    if (lines.has(msg.id) || lines.size >= MAX_LINES_PER_MEETING) return false;
    lines.set(msg.id, { ...msg, text });
    return true;
  }

  compose(hc: string, meeting: string, text: string): ChatMsg {
    return { k: "chat", id: randomId(), hc, meeting, text: text.slice(0, CHAT_MAX_LEN), t: Date.now() };
  }

  private sessionLines(): ChatMsg[] {
    return this.session.flatMap((h) => [...(this.byMeeting.get(h)?.values() ?? [])]);
  }

  /** My own lines in this discussion — re-sent periodically so peers that
   *  connect mid-meeting still get the conversation. */
  mine(hc: string): ChatMsg[] {
    return this.sessionLines().filter((c) => c.hc === hc);
  }

  /** Lines to show: senders must be players in this lobby and alive on-chain
   *  (dead players are muted). */
  visible(m: ChatRoster): ChatMsg[] {
    const alive = new Set((m.state?.players ?? []).filter((p) => !p.dead).map((p) => p.keyB64));
    return this.sessionLines()
      .filter((c) => alive.has(c.hc))
      .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  }
}

export type ChatView = { visible: boolean; canType: boolean; placeholder: string; title: string };

export function chatView(m: Model): ChatView {
  const s = m.state;
  const inLobby = s?.phase === "lobby";
  const visible = m.entered && (inLobby || s?.phase === "meeting");
  const title = inLobby ? "Lobby chat" : "Meeting chat";
  const iAmDead = s?.players.find((p) => p.keyB64 === m.myKeyB64)?.dead ?? false;
  if (iAmDead) return { visible, title, canType: false, placeholder: "You're dead — you can read the chat but not speak" };
  if (!m.peerkit.enabled || m.peerkit.startError) {
    return { visible, title, canType: false, placeholder: "Chat needs PeerKit — join with a relay address" };
  }
  return { visible, title, canType: true, placeholder: inLobby ? "Say hi… (Enter to send)" : "Discuss… (Enter to send)" };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function chatLogHtml(m: ChatRoster & Pick<Model, "myKeyB64">, log: ChatLog): string {
  const lines = log.visible(m);
  if (lines.length === 0) return `<p class="muted">No messages yet.</p>`;
  const players = new Map((m.state?.players ?? []).map((p) => [p.keyB64, p]));
  return lines
    .map((c) => {
      const p = players.get(c.hc);
      return `<div class="chat-line${c.hc === m.myKeyB64 ? " mine" : ""}"><strong style="color:${colorHex(
        p?.color ?? 0,
      )}">${esc(p?.name ?? "?")}</strong> ${esc(c.text)}</div>`;
    })
    .join("");
}
