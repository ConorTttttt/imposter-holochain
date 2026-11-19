import {
  MOVEMENT_PATH, POSITION_INTERVAL_MS, POSITION_TIMEOUT_MS,
  movementChallenge, movementDigest, validPosition, type Point,
} from "./movement-wire.js";

export type SignMovement = (message: Uint8Array) => Promise<Uint8Array>;

export class BrowserMovement {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private retryAt = 0;
  private openedAt = 0;
  private sentAt = 0;
  private readonly positions = new Map<string, Point & { received: number }>();

  constructor(
    private readonly dna: string,
    private readonly agent: string,
    private readonly sign: SignMovement,
  ) {}

  get connected() {
    return this.authenticated;
  }

  position(agent: string, now: number): Point | undefined {
    const point = this.positions.get(agent);
    if (point && now - point.received < POSITION_TIMEOUT_MS) return point;
    this.positions.delete(agent);
  }

  tick(now: number, point: Point, peers: ReadonlySet<string>) {
    if (!this.socket && now >= this.retryAt) {
      const url = new URL(MOVEMENT_PATH, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      this.openedAt = now;
      socket.addEventListener("message", (event) => {
        if (socket === this.socket) void this.receive(socket, event.data, peers);
      });
      socket.addEventListener("close", () => {
        if (socket === this.socket) this.stop();
      });
    }
    if (!this.authenticated) {
      if (this.socket && now - this.openedAt > 8000) this.stop();
      return;
    }
    if (now - this.sentAt >= POSITION_INTERVAL_MS && this.socket?.readyState === WebSocket.OPEN &&
        this.socket.bufferedAmount < 1024) {
      this.socket.send(JSON.stringify([point.x, point.y]));
      this.sentAt = now;
    }
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.positions.clear();
    this.retryAt = performance.now() + 1000;
    socket?.close();
  }

  private async receive(socket: WebSocket, raw: unknown, peers: ReadonlySet<string>) {
    if (typeof raw !== "string" || raw.length > 512) return;
    try {
      const packet = JSON.parse(raw);
      if (!this.authenticated) {
        if (typeof packet?.nonce === "string" && /^[a-f0-9]{64}$/.test(packet.nonce)) {
          const digest = await movementDigest(movementChallenge(location.origin, this.dna, this.agent, packet.nonce));
          const signature = await this.sign(digest);
          if (socket === this.socket && socket.readyState === WebSocket.OPEN && signature.length === 64) {
            socket.send(JSON.stringify({
              dna: this.dna, agent: this.agent, signature: btoa(String.fromCharCode(...signature)),
            }));
          }
        } else if (packet?.ready === true) {
          this.authenticated = true;
        }
        return;
      }
      // Native state owns the roster, names, seats, roles and deaths. Positions
      // can still be falsified by the player who sends them.
      if (Array.isArray(packet) && packet.length === 3 && peers.has(packet[0]) && validPosition(packet.slice(1))) {
        const [agent, x, y] = packet;
        this.positions.set(agent, { x, y, received: performance.now() });
      }
    } catch {
      // Failure to sign a challenge or parse a packet affects only movement.
    }
  }
}
