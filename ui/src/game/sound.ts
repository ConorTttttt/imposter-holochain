// Sound effects, synthesized with Web Audio — no audio files to ship. The page
// has one AudioContext, shared with voice chat (peerkit/voice.ts). Muting is
// per window and remembered across reloads.

export type Sfx =
  | "task"
  | "kill"
  | "body"
  | "emergency"
  | "voted"
  | "start-crew"
  | "start-impostor"
  | "win"
  | "lose"
  | "lights"
  | "vent"
  | "doors"
  | "comms"
  | "scan"
  | "alarm";

/** One note: starts `at` seconds in, lasts `dur`, optionally sliding to `to` Hz. */
type Tone = { at: number; dur: number; freq: number; to?: number; wave?: OscillatorType; vol?: number };

const SFX: Record<Sfx, Tone[]> = {
  // rising two-note chime
  task: [
    { at: 0, dur: 0.12, freq: 660 },
    { at: 0.1, dur: 0.22, freq: 990 },
  ],
  // low falling thud
  kill: [{ at: 0, dur: 0.4, freq: 220, to: 45, wave: "sawtooth", vol: 0.7 }],
  // alternating alarm
  body: [0, 0.2, 0.4, 0.6].map((at, i) => ({ at, dur: 0.17, freq: i % 2 ? 520 : 780, wave: "square" as const, vol: 0.35 })),
  // siren, up and back down
  emergency: [
    { at: 0, dur: 0.45, freq: 440, to: 900, wave: "triangle" },
    { at: 0.45, dur: 0.45, freq: 900, to: 440, wave: "triangle" },
  ],
  // three falling notes
  voted: [
    { at: 0, dur: 0.2, freq: 523 },
    { at: 0.2, dur: 0.2, freq: 392 },
    { at: 0.4, dur: 0.45, freq: 262 },
  ],
  "start-crew": [
    { at: 0, dur: 0.18, freq: 392 },
    { at: 0.16, dur: 0.18, freq: 523 },
    { at: 0.32, dur: 0.35, freq: 659 },
  ],
  "start-impostor": [
    { at: 0, dur: 0.7, freq: 196, to: 98, wave: "sawtooth", vol: 0.5 },
    { at: 0.05, dur: 0.7, freq: 233, to: 117, wave: "sawtooth", vol: 0.3 },
  ],
  win: [523, 659, 784, 1047].map((freq, i) => ({ at: i * 0.12, dur: i === 3 ? 0.5 : 0.14, freq })),
  lose: [392, 311, 262].map((freq, i) => ({ at: i * 0.22, dur: i === 2 ? 0.6 : 0.22, freq, wave: "triangle" as const })),
  // power dying away
  lights: [
    { at: 0, dur: 0.6, freq: 600, to: 90, wave: "sawtooth", vol: 0.4 },
    { at: 0.05, dur: 0.6, freq: 450, to: 70, wave: "square", vol: 0.2 },
  ],
  // a metal hatch
  vent: [
    { at: 0, dur: 0.12, freq: 180, to: 90, wave: "square", vol: 0.35 },
    { at: 0.1, dur: 0.1, freq: 120, to: 60, wave: "square", vol: 0.25 },
  ],
  // doors slamming shut
  doors: [
    { at: 0, dur: 0.25, freq: 110, to: 40, wave: "sawtooth", vol: 0.6 },
    { at: 0.12, dur: 0.25, freq: 90, to: 35, wave: "sawtooth", vol: 0.5 },
  ],
  // a burst of static, cutting out
  comms: [
    { at: 0, dur: 0.15, freq: 340, wave: "square", vol: 0.3 },
    { at: 0.08, dur: 0.2, freq: 210, to: 55, wave: "square", vol: 0.3 },
  ],
  // a clean electronic sweep, confirming the scan
  scan: [
    { at: 0, dur: 0.5, freq: 300, to: 1200, wave: "sine", vol: 0.35 },
    { at: 0.45, dur: 0.2, freq: 1200, wave: "sine", vol: 0.3 },
  ],
  // a crisis klaxon: low, slow, insistent
  alarm: [0, 0.35, 0.7].map((at) => ({ at, dur: 0.3, freq: 330, to: 220, wave: "sawtooth" as const, vol: 0.45 })),
};

let ctx: AudioContext | null = null;

/** The page's one AudioContext, created on first use. A browser may start it
 *  suspended until the player interacts with the page, so any click or key
 *  press resumes it. */
export function audioContext(): AudioContext {
  if (!ctx) {
    const c = (ctx = new AudioContext());
    const resume = () => {
      if (c.state === "running") {
        window.removeEventListener("pointerdown", resume);
        window.removeEventListener("keydown", resume);
      } else {
        void c.resume();
      }
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    void c.resume();
  }
  return ctx;
}

const MUTE_KEY = "imposter-sound-muted";
const VOLUME = 0.3;

export class Sounds {
  private readonly out: GainNode;
  private muted: boolean;

  constructor() {
    const c = audioContext();
    this.out = c.createGain();
    this.out.connect(c.destination);
    this.muted = localStorage.getItem(MUTE_KEY) === "1";
    this.out.gain.value = this.muted ? 0 : VOLUME;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    this.out.gain.value = muted ? 0 : VOLUME;
  }

  play(name: Sfx): void {
    const c = audioContext();
    // Until the page is unlocked, skip: a sound that plays late is worse than none.
    if (this.muted || c.state !== "running") return;
    const t0 = c.currentTime + 0.01;
    for (const tone of SFX[name]) this.tone(c, t0, tone);
  }

  private tone(c: AudioContext, t0: number, { at, dur, freq, to, wave = "sine", vol = 0.5 }: Tone): void {
    const start = t0 + at;
    const end = start + dur;
    const osc = c.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, end);
    const env = c.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(vol, start + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(env).connect(this.out);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
