import { meetingClock, voteGroups, type StateV } from "../game/ui.js";
import { randomSalt, voteCommitment } from "../vote.js";

type Meeting = Omit<NonNullable<StateV["active_meeting"]>, "meetingB64" | "committed" | "revealed"> & {
  meeting: unknown;
  committed: unknown[];
  revealed: unknown[];
};

export type MeetingState = Pick<StateV, "phase" | "is_host" | "my_seat"> & {
  active_meeting: Meeting | null;
  settings: Pick<StateV["settings"], "discussion_s" | "voting_s">;
  players: Pick<StateV["players"][number], "key" | "name" | "seat" | "dead">[];
};

export type MeetingAction = "press_emergency" | "report_body" | "commit_vote" | "reveal_vote" | "resolve_meeting";
export type CallMeeting = (name: MeetingAction, payload: unknown) => Promise<void>;

type MeetingUpdate = {
  state: MeetingState;
  dna: string;
  agent: string;
  call: CallMeeting;
  hash: (value: unknown) => string;
  toBytes: (value: unknown) => Uint8Array;
};

const REVEAL_LEAD_MS = 3000;
const TALLY_GRACE_MS = 3000;

type BallotOpening = { choice: number[] | null; salt: number[] };

function savedOpening(key: string): BallotOpening | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const bytes = (data: unknown, length: number): data is number[] =>
      Array.isArray(data) && data.length === length &&
      data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256);
    if (value && (value.choice === null || bytes(value.choice, 39)) && bytes(value.salt, 32)) return value;
  } catch {
    // Browser storage can be disabled. The current tab still holds the opening.
  }
  return null;
}

export function mountBrowserMeetings(onDismiss: () => void) {
  const panel = document.querySelector<HTMLElement>("#browser-meeting")!;
  const title = panel.querySelector("h2")!;
  const timer = panel.querySelector<HTMLElement>("#meeting-timer")!;
  const status = panel.querySelector<HTMLElement>("#meeting-vote-status")!;
  const choices = panel.querySelector<HTMLElement>("#meeting-ballot")!;
  const back = panel.querySelector<HTMLButtonElement>("#meeting-back")!;
  let update: MeetingUpdate | null = null;
  let key = "";
  let opening: BallotOpening | null = null;
  let sent = false;
  let tallySent = false;
  let processing = false;
  let dismissed = "";
  let lastBallot = "";
  let failed = false;

  back.addEventListener("click", () => {
    dismissed = key;
    panel.hidden = true;
    onDismiss();
    document.querySelector<HTMLCanvasElement>("#gameplay-map canvas")?.focus({ preventScroll: true });
  });

  async function act(name: MeetingAction, payload: unknown) {
    if (!update || processing) return false;
    const current = key;
    processing = true;
    failed = false;
    try {
      await update.call(name, payload);
      return current === key;
    } catch {
      if (current === key) failed = true;
      return false;
    } finally {
      processing = false;
    }
  }

  async function commit(choice: unknown) {
    if (!update || opening || processing) return;
    const salt = randomSalt();
    const bytes = choice === null ? null : update.toBytes(choice);
    opening = { choice: bytes && Array.from(bytes), salt: Array.from(salt) };
    try { sessionStorage.setItem(key, JSON.stringify(opening)); } catch { /* use memory */ }
    const meetingKey = key;
    const mt = update.state.active_meeting!;
    const success = await act("commit_vote", {
      meeting: update.toBytes(mt.meeting), commitment: Array.from(voteCommitment(bytes, salt)),
    });
    if (!success && key === meetingKey) {
      // Keep the opening for a write whose response was lost. The same
      // commitment can be retried while the native state catches up.
      failed = true;
    }
  }

  return {
    render(next: MeetingUpdate | null) {
      update = next;
      const state = next?.state;
      const mt = state?.active_meeting;
      if (!next || !state || state.my_seat == null || !mt) {
        panel.hidden = true;
        return false;
      }
      const scopedKey = "imposter-browser-vote:" + JSON.stringify([next.dna, next.agent, next.hash(mt.meeting)]);
      if (key !== scopedKey) {
        key = scopedKey;
        opening = savedOpening(key);
        failed = Boolean(opening);
        sent = false;
        tallySent = false;
        lastBallot = "";
      }
      if (state.phase !== "meeting" && (!mt.resolved || mt.resolved.kind === "tie" || dismissed === key)) {
        panel.hidden = true;
        return false;
      }
      panel.hidden = false;
      const living = state.players.filter((p) => p.seat != null && !p.dead);
      const committed = new Set(mt.committed.map(next.hash));
      const revealed = new Set(mt.revealed.map(next.hash));
      const myVote = committed.has(next.agent);
      const subject = (seat: number | null) =>
        seat == null ? "Skip" : (state.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`);
      const now = Date.now();
      const clock = meetingClock({ ...state, active_meeting: { ...mt, opened_at_ms: Number(mt.opened_at_ms) } }, now);
      title.textContent = mt.candidates ? "Tie-breaker" : mt.trigger === "body_report" ? "Body reported" : "Emergency meeting";
      timer.textContent = clock.text;
      back.hidden = !mt.resolved || mt.resolved.kind === "tie";
      const past = mt.resolved;
      if (past) {
        const text = past.kind === "tie" ? "Tie. Waiting for the tie-breaker." :
          past.kind === "no_ejection" ? "No player ejected." : subject(past.seat) + " was ejected.";
        status.textContent = [text, ...voteGroups(state).map(({ choice, voters }) =>
          subject(choice) + " · " + voters.length)].join(" ");
        choices.replaceChildren();
        opening = null;
        try { sessionStorage.removeItem(key); } catch { /* use memory */ }
        return state.phase === "playing";
      }

      const close = clock.votingEndsAt;
      const outOfTime = close !== null && now >= close;
      const mineLiving = living.some((player) => next.hash(player.key) === next.agent);
      const options = mt.candidates ? state.players.filter((p) => p.seat !== null && mt.candidates!.includes(p.seat)) : living;
      const canVote = mineLiving && !myVote && !opening && !processing && !clock.discussing && !outOfTime;
      const ballot = JSON.stringify([canVote, options.map((p) => p.seat), mt.candidates]);
      if (ballot !== lastBallot) {
        lastBallot = ballot;
        choices.replaceChildren();
        if (canVote) {
          for (const option of [...options, ...(!mt.candidates || mt.candidates.includes(null) ? [null] : [])]) {
            const button = document.createElement("button");
            button.type = "button";
            button.id = option ? "vote-seat-" + option.seat : "vote-skip";
            button.textContent = subject(option?.seat ?? null);
            button.addEventListener("click", () => void commit(option?.key ?? null));
            choices.append(button);
          }
        }
      }
      const allVoted = living.every((player) => committed.has(next.hash(player.key)));
      const allRevealed = living.every((player) => revealed.has(next.hash(player.key)));
      status.textContent = (failed ? "Waiting to synchronize your action. " : "") +
        `Votes cast: ${committed.size}/${living.length} · Revealed: ${revealed.size}/${living.length}` +
        (!mineLiving ? " · Spectating" : "");

      if (opening && !myVote && !processing && !clock.discussing && !outOfTime && failed) {
        const vote = opening;
        void act("commit_vote", {
          meeting: next.toBytes(mt.meeting),
          commitment: Array.from(voteCommitment(vote.choice && Uint8Array.from(vote.choice), Uint8Array.from(vote.salt))),
        });
      } else if (myVote && !revealed.has(next.agent) && opening && !sent && !processing &&
          (allVoted || (close !== null && now >= close - REVEAL_LEAD_MS))) {
        const vote = opening;
        sent = true;
        void act("reveal_vote", { meeting: next.toBytes(mt.meeting), choice: vote.choice && Uint8Array.from(vote.choice), salt: vote.salt })
          .then((ok) => { if (!ok && key === scopedKey) sent = false; });
      } else if (state.is_host && !tallySent && !processing && (allRevealed || (close !== null && now >= close + TALLY_GRACE_MS))) {
        tallySent = true;
        void act("resolve_meeting", next.toBytes(mt.meeting))
          .then((ok) => { if (!ok && key === scopedKey) tallySent = false; });
      }
      return false;
    },
  };
}
