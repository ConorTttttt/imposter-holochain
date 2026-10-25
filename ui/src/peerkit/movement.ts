// Real-time movement over PeerKit — ephemeral, not replicated, not validated.
// Each peer broadcasts its position (~10 Hz) to every connected peer; positions
// carry the sender's Holochain agent key (base64) so the canvas can line a
// moving dot up with an on-chain player. The same connections carry tagged app
// packets (`{ k: ... }`, e.g. meeting chat), handed to `onPacket`.
//
// Trimmed from the blackjack `src/peerkit-client.ts`: no blob store, no Merkle,
// no authored-data sync — throwaway packets only. If the relay is unreachable
// the game still works fully over Holochain; you just don't see others move.

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import type { AgentId } from "@peerkit/api";
import { PeerkitNodeBuilder, type PeerkitNode } from "@peerkit/peerkit";
import { TransportLibp2p, webRtcDirectDnsResolver } from "@peerkit/transport-libp2p-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { createLibp2p, dnsaddrResolver } from "libp2p";
import { LocalStorageAgentKeyStore } from "./keystore.js";

export function networkKeyFor(code: string): Uint8Array {
  return sha256(new TextEncoder().encode(`imposter:${code}`));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * PeerKit's default node (`@peerkit/transport-libp2p-nodejs` `createNode`) with
 * one change for the browser: libp2p's browser build installs a connection
 * gater that refuses every private and loopback address, which is exactly
 * where a dev relay lives (`127.0.0.1`, `192.168.x.x`). Dials to it failed with
 * `DialDeniedError` before a packet was sent. Allow them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function browserNodeFactory(options: any): Promise<TransportLibp2p> {
  const iceServers = (options.iceServerUrls as string[] | undefined)?.map((urls) => ({ urls }));
  const libp2p = await createLibp2p({
    // Defer listening so TransportLibp2p registers its protocol handlers first.
    start: false,
    transports: [webRTC({ rtcConfiguration: { iceServers } }), webRTCDirect(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), dcutr: dcutr() },
    connectionManager: {
      resolvers: { dnsaddr: dnsaddrResolver, webRtcDirect: webRtcDirectDnsResolver },
    },
    connectionGater: { denyDialMultiaddr: () => false },
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
  });
  const transport = new TransportLibp2p(libp2p, options);
  await libp2p.start();
  if (options.bootstrapRelays?.length) void transport.connectToRelays(options.bootstrapRelays);
  return transport;
}

export type Pos = { hc: string; x: number; y: number; t: number; h?: boolean }; // h: hidden in a vent

/** An app packet; the `k` tag tells it apart from a position. */
export type Packet = { k: string };

export class Movement {
  readonly positions = new Map<string, Pos>(); // hcKeyB64 -> latest pos (t = local receive time)
  self: Pos = { hc: "", x: 0, y: 0, t: 0 };
  onPacket: ((data: Packet) => void) | null = null;
  private node!: PeerkitNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly relayIds = new Set<string>();

  private constructor(private readonly myHcKeyB64: string) {
    this.self.hc = myHcKeyB64;
  }

  static async start(
    code: string,
    myHcKeyB64: string,
    relays: string[],
    spawn: { x: number; y: number },
  ): Promise<Movement> {
    const m = new Movement(myHcKeyB64);
    m.self.x = spawn.x;
    m.self.y = spawn.y;
    const key = networkKeyFor(code);

    m.node = await new PeerkitNodeBuilder({
      agentKeyStore: new LocalStorageAgentKeyStore(`imposter-peerkit-${code}`),
      networkAccessHandler: async (_id: string, bytes: Uint8Array) =>
        bytes.length === 0 || bytesEqual(bytes, key),
      messageHandler: async (_from: AgentId, msg: Uint8Array) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(msg));
          if (data && typeof data.k === "string") {
            m.onPacket?.(data as Packet);
          } else if (data && typeof data.hc === "string") {
            // Stamp with our own clock so liveness never depends on clock skew.
            m.positions.set(data.hc, { ...(data as Pos), t: Date.now() });
          }
        } catch {
          /* ignore junk */
        }
      },
    })
      .withNetworkAccessBytes(key)
      .withBootstrapRelays(relays)
      .withTransportFactory(browserNodeFactory)
      .withRelayConnectedObserver((relayId) => void m.relayIds.add(relayId))
      .withAgentsReceivedObserver((ids: AgentId[]) => void m.dial(ids))
      .build();

    m.timer = setInterval(() => m.broadcast(), 100);
    // Agent discovery only fires when new agent info arrives, so a dial that
    // failed once would never be retried. Sweep known agents every few seconds,
    // as the blackjack browser client does.
    m.sweepTimer = setInterval(
      () => void m.dial(m.node.agentStore.getAll().map((a) => a.agentId)),
      3000,
    );
    return m;
  }

  setPos(x: number, y: number): void {
    this.self.x = x;
    this.self.y = y;
  }

  /** Hiding in a vent: peers stop drawing me, and hearing me. */
  setHidden(hidden: boolean): void {
    this.self.h = hidden;
  }

  /** True while at least one bootstrap relay connection is open. */
  relayUp(): boolean {
    for (const id of this.relayIds) if (this.node.transport.isConnected(id)) return true;
    return false;
  }

  /** Holochain keys (b64) of players we've had a position from within `maxAgeMs`. */
  liveKeys(maxAgeMs: number): string[] {
    const now = Date.now();
    return [...this.positions.values()]
      .filter((p) => p.hc !== this.myHcKeyB64 && now - p.t < maxAgeMs)
      .map((p) => p.hc);
  }

  /** Send an app packet to every connected peer (best effort, no retry). */
  sendJson(data: Packet): void {
    this.sendToAll(data);
  }

  private async dial(ids: AgentId[]): Promise<void> {
    for (const id of ids) {
      if (id === this.node.ownAgentId || this.node.isConnected(id)) continue;
      const info = this.node.agentStore.get(id);
      if (!info || info.addresses.length === 0) continue;
      try {
        await this.node.transport.connect(info.addresses);
      } catch {
        /* peers come and go; the next sweep retries */
      }
    }
  }

  private sendToAll(data: unknown): void {
    const msg = new TextEncoder().encode(JSON.stringify(data));
    for (const id of this.node.getConnectedAgents()) {
      if (id === this.node.ownAgentId) continue;
      this.node.send(id, msg).catch(() => {});
    }
  }

  private broadcast(): void {
    this.self.t = Date.now();
    this.sendToAll(this.self);
    // drop stale peers so ghosts don't linger
    const now = Date.now();
    for (const [k, p] of this.positions) {
      if (k !== this.myHcKeyB64 && now - p.t > 5000) this.positions.delete(k);
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      await this.node.shutDown();
    } catch {
      /* already down */
    }
  }
}
