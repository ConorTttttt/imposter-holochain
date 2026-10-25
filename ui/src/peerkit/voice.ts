// Voice chat: a WebRTC audio connection to every other player, set up by
// sending offers and answers over the PeerKit connections the game already has
// (`{ k: "rtc" }` packets). Audio goes straight between browsers — never over
// Holochain or the relay. Who hears whom, and how loud, is the game's call
// (main.ts `hearing`), applied here per peer; like text chat, only honest
// clients enforce it.
//
// The mic stays off until the player turns it on, and is released when off.

import { audioContext } from "../game/sound.js";
import type { Packet } from "./movement.js";

/** The public STUN servers PeerKit's own WebRTC transport uses (it doesn't
 *  export them). On one machine or a LAN, host candidates are enough. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.services.mozilla.com:3478" },
];
const GATHER_TIMEOUT_MS = 1500; // send what we have: an unreachable STUN server can't stall a call
const RETRY_MS = 8000; // a call that isn't up by then (a lost offer or answer) is placed again
const TALKING_LEVEL = 0.02; // RMS above which a peer counts as talking

export type VoiceSignal = {
  k: "rtc";
  from: string; // sender's Holochain agent key (b64)
  to: string;
  kind: "offer" | "answer";
  id: string; // one per call attempt, so a stale answer is never applied
  sdp: string;
};

export function isVoiceSignal(v: unknown): v is VoiceSignal {
  const s = v as VoiceSignal;
  return (
    !!s &&
    s.k === "rtc" &&
    typeof s.from === "string" &&
    typeof s.to === "string" &&
    (s.kind === "offer" || s.kind === "answer") &&
    typeof s.id === "string" &&
    typeof s.sdp === "string"
  );
}

type Peer = {
  pc: RTCPeerConnection;
  id: string;
  since: number; // when this call started, or last dropped
  gain: GainNode;
  target: number;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode | null;
  sink: HTMLAudioElement | null;
};

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class Voice {
  micError: string | null = null;
  private readonly peers = new Map<string, Peer>();
  private wanted = new Set<string>();
  private readonly bus: GainNode;
  private track: MediaStreamTrack | null = null;
  private micPending = false;
  private deafened = false;
  private readonly samples = new Float32Array(512);

  constructor(
    private readonly myKey: string,
    private readonly send: (msg: Packet) => void,
  ) {
    const c = audioContext();
    this.bus = c.createGain();
    this.bus.connect(c.destination);
    setInterval(() => this.retry(), 2000);
  }

  micOn(): boolean {
    return !!this.track;
  }

  isDeafened(): boolean {
    return this.deafened;
  }

  setDeafened(on: boolean): void {
    this.deafened = on;
    this.bus.gain.value = on ? 0 : 1;
  }

  /** Turn the mic on (asking for it) or off (releasing it). */
  async setMic(on: boolean): Promise<void> {
    if (on === this.micOn() || this.micPending) return;
    if (on) {
      this.micPending = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.track = stream.getAudioTracks()[0] ?? null;
        this.micError = this.track ? null : "no audio input";
      } catch (e: any) {
        this.micError = String(e?.message ?? e);
        return;
      } finally {
        this.micPending = false;
      }
    } else {
      this.track?.stop();
      this.track = null;
    }
    for (const p of this.peers.values()) void audioSender(p.pc)?.replaceTrack(this.track);
  }

  /** The players to keep a voice connection with; anyone else is hung up on. */
  setPeers(keys: string[]): void {
    this.wanted = new Set(keys);
    for (const key of [...this.peers.keys()]) if (!this.wanted.has(key)) this.hangUp(key);
    for (const key of keys) if (!this.peers.has(key) && this.calls(key)) void this.call(key);
  }

  /** How loud this player is for me, 0..1 (eased, so distance changes don't click). */
  setGain(key: string, gain: number): void {
    const p = this.peers.get(key);
    if (!p || Math.abs(p.target - gain) < 0.01) return;
    p.target = gain;
    p.gain.gain.setTargetAtTime(gain, p.gain.context.currentTime, 0.08);
  }

  isTalking(key: string): boolean {
    const p = this.peers.get(key);
    if (!p?.source) return false;
    p.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const x of this.samples) sum += x * x;
    return Math.sqrt(sum / this.samples.length) > TALKING_LEVEL;
  }

  async onSignal(msg: VoiceSignal): Promise<void> {
    if (msg.to !== this.myKey || !this.wanted.has(msg.from)) return;
    if (msg.kind === "answer") {
      const p = this.peers.get(msg.from);
      if (p?.id !== msg.id || p.pc.signalingState !== "have-local-offer") return;
      await p.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      return;
    }
    // An offer. Only the lower key places calls, so two peers never offer at once.
    if (this.calls(msg.from) || this.peers.get(msg.from)?.id === msg.id) return;
    this.hangUp(msg.from);
    const p = this.open(msg.from, msg.id);
    await p.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    const tx = p.pc.getTransceivers().find((t) => t.receiver.track.kind === "audio");
    if (tx) {
      tx.direction = "sendrecv";
      await tx.sender.replaceTrack(this.track);
    }
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    const sdp = await gathered(p.pc);
    if (this.peers.get(msg.from) === p) {
      this.send({ k: "rtc", from: this.myKey, to: msg.from, kind: "answer", id: msg.id, sdp } as VoiceSignal);
    }
  }

  /** Whether I place the call to this peer (they answer). */
  private calls(key: string): boolean {
    return this.myKey < key;
  }

  private async call(key: string): Promise<void> {
    const p = this.open(key, randomId());
    try {
      const tx = p.pc.addTransceiver("audio", { direction: "sendrecv" });
      await tx.sender.replaceTrack(this.track);
      await p.pc.setLocalDescription(await p.pc.createOffer());
      const sdp = await gathered(p.pc);
      if (this.peers.get(key) === p) {
        this.send({ k: "rtc", from: this.myKey, to: key, kind: "offer", id: p.id, sdp } as VoiceSignal);
      }
    } catch (e) {
      console.warn("voice call failed:", e); // left in place: `retry` places it again
    }
  }

  /** Packets are best effort, so an offer or answer can be lost; a connection
   *  can also drop. Place our calls again when they aren't up in time. */
  private retry(): void {
    const now = Date.now();
    for (const [key, p] of this.peers) {
      if (!this.calls(key)) continue;
      const state = p.pc.connectionState;
      if (state === "connected") continue;
      if (state !== "failed" && state !== "closed" && now - p.since < RETRY_MS) continue;
      this.hangUp(key);
      void this.call(key);
    }
  }

  private open(key: string, id: string): Peer {
    const c = audioContext();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const gain = c.createGain();
    gain.connect(this.bus);
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    const p: Peer = { pc, id, since: Date.now(), gain, target: 1, analyser, source: null, sink: null };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== "connected") p.since = Date.now();
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      // Chromium only feeds a remote WebRTC stream into Web Audio while a media
      // element is playing it too — so play it there, muted.
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      void sink.play().catch(() => {});
      p.source?.disconnect();
      p.source = c.createMediaStreamSource(stream);
      p.source.connect(analyser);
      p.source.connect(gain);
      p.sink = sink;
    };
    this.peers.set(key, p);
    return p;
  }

  private hangUp(key: string): void {
    const p = this.peers.get(key);
    if (!p) return;
    this.peers.delete(key);
    p.pc.close();
    p.source?.disconnect();
    p.gain.disconnect();
    if (p.sink) p.sink.srcObject = null;
  }
}

function audioSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === "audio")?.sender;
}

/** The local description once ICE gathering finishes, or after a short wait. */
async function gathered(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          done();
        }
      });
    });
  }
  return pc.localDescription?.sdp ?? "";
}
