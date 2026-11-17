import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketNetworkService, type ServerMessage } from "./websocket-service";

function url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function holoHash(kind: number, core: Uint8Array): string {
  const full = new Uint8Array(39);
  full.set([0x84, kind, 0x24], 0);
  full.set(core, 3);
  return "u" + url(full);
}
function info(core: Uint8Array, space: Uint8Array) {
  const now = BigInt(Date.now()) * 1000n;
  return {
    agent: url(core),
    space: url(space),
    createdAt: now.toString(),
    expiresAt: (now + 1200000000n).toString(),
    isTombstone: false,
    url: "ws://127.0.0.1:8090/ws",
    storageArc: null,
  };
}
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: Array<any> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(_url: string) { sockets.push(this); }
  send(json: string) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" } as CloseEvent); }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  message(payload: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  closed() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "dropped" } as CloseEvent);
  }
}
let sockets: FakeWebSocket[] = [];
let services: WebSocketNetworkService[] = [];

function start(core: number, space: number) {
  const agentCore = new Uint8Array(32).fill(core);
  const dnaCore = new Uint8Array(32).fill(space);
  const agent = holoHash(0x20, agentCore);
  const dna = holoHash(0x2d, dnaCore);
  const wsService = new WebSocketNetworkService({
    linkerWsUrl: "ws://127.0.0.1:8090/ws",
    heartbeatInterval: 30000,
    reconnectBaseDelay: 5,
    reconnectMaxDelay: 5,
  });
  services.push(wsService);
  const tokenEvents: string[] = [];
  wsService.onSessionToken((token) => tokenEvents.push(token));
  wsService.registerAgent(dna, agent);
  wsService.connect();
  const socket = sockets[sockets.length - 1];
  socket.open();
  expect(socket.sent).toContainEqual({ type: "auth", agent_pubkey: agent });
  return { wsService, socket, agent, agentCore, dnaCore, dna, tokenEvents };
}
afterEach(() => {
  for (const service of services) service.disconnect();
  services = [];
  sockets = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Imposter HWC session and signing lifecycle", () => {
  it("reflects a signed session, drops it on disconnect and reauthenticates", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const session = start(3, 11);
    const states: Array<{ state: string; auth: boolean }> = [];
    session.wsService.onStateChange((state) => states.push({
      state, auth: session.wsService.isAuthenticated(),
    }));
    expect(session.wsService.isConnected()).toBe(false);
    session.socket.message({ type: "auth_ok", session_token: "first-secret" });
    expect(session.wsService.isConnected()).toBe(true);
    expect(session.tokenEvents).toEqual(["first-secret"]);
    session.socket.closed();
    expect(session.wsService.isConnected()).toBe(false);
    expect(session.wsService.getState()).toBe("reconnecting");
    vi.advanceTimersByTime(30);
    const renewed = sockets[sockets.length - 1];
    expect(renewed).not.toBe(session.socket);
    renewed.open();
    renewed.message({ type: "auth_ok", session_token: "renewed-secret" });
    expect(session.tokenEvents).toEqual(["first-secret", "renewed-secret"]);
    expect(session.wsService.isConnected()).toBe(true);
    expect(states.some((s) => s.state === "reconnecting" && !s.auth)).toBe(true);
  });

  it("denies unregistered, foreign and other-agent AgentInfo before signing", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const a = start(7, 12);
    const signer = vi.fn(async () => new Uint8Array(64).fill(3));
    a.wsService.onSign(signer);
    a.socket.message({ type: "auth_ok", session_token: "token-identity-A" });
    const otherSpace = new Uint8Array(32).fill(13);
    a.socket.message({
      type: "sign_agent_info", request_id: "foreign-space",
      agent_pubkey: a.agent, agent_info: info(a.agentCore, otherSpace),
    });
    a.socket.message({
      type: "sign_agent_info", request_id: "other-agent",
      agent_pubkey: holoHash(0x20, new Uint8Array(32).fill(9)),
      agent_info: info(new Uint8Array(32).fill(9), a.dnaCore),
    });
    expect(signer).not.toHaveBeenCalled();
    expect(a.socket.sent.find((m) => m.request_id === "foreign-space")?.error).toContain("not registered");
    expect(a.socket.sent.find((m) => m.request_id === "other-agent")?.error).toContain("authenticated");
    a.socket.message({
      type: "sign_agent_info", request_id: "own-space",
      agent_pubkey: a.agent, agent_info: info(a.agentCore, a.dnaCore),
    });
    await vi.waitFor(() => expect(signer).toHaveBeenCalledTimes(1));
    expect(a.socket.sent.find((m) => m.request_id === "own-space")?.signature).toBeTruthy();
    a.wsService.unregisterAgent(a.dna, a.agent);
    a.socket.message({
      type: "sign_agent_info", request_id: "after-unregister",
      agent_pubkey: a.agent, agent_info: info(a.agentCore, a.dnaCore),
    });
    expect(a.socket.sent.find((m) => m.request_id === "after-unregister")?.error).toContain("not registered");
  });

  it("keeps two independent authenticated identities separate", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const a = start(21, 4);
    const b = start(22, 5);
    const signedA = vi.fn(async () => new Uint8Array(64).fill(1));
    const signedB = vi.fn(async () => new Uint8Array(64).fill(2));
    a.wsService.onSign(signedA);
    b.wsService.onSign(signedB);
    a.socket.message({ type: "auth_ok", session_token: "A-only" });
    b.socket.message({ type: "auth_ok", session_token: "B-only" });
    b.socket.message({
      type: "sign_agent_info", request_id: "wrong-A",
      agent_pubkey: a.agent, agent_info: info(a.agentCore, a.dnaCore),
    });
    expect(signedB).not.toHaveBeenCalled();
    a.socket.message({
      type: "sign_agent_info", request_id: "right-A",
      agent_pubkey: a.agent, agent_info: info(a.agentCore, a.dnaCore),
    });
    b.socket.message({
      type: "sign_agent_info", request_id: "right-B",
      agent_pubkey: b.agent, agent_info: info(b.agentCore, b.dnaCore),
    });
    await vi.waitFor(() => {
      expect(signedA).toHaveBeenCalledTimes(1);
      expect(signedB).toHaveBeenCalledTimes(1);
    });
    expect(a.tokenEvents).toEqual(["A-only"]);
    expect(b.tokenEvents).toEqual(["B-only"]);
  });
});
