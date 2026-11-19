import { randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { MOVEMENT_PATH, movementChallenge, movementDigest, validPosition } from "./movement-wire.js";

const [origin, port] = process.argv.slice(2);
if (!origin || new URL(origin).origin !== origin || !/^https?:\/\//.test(origin) ||
    !port || !/^\d+$/.test(port) || Number(port) <= 0 || Number(port) > 65535) {
  throw new Error("Usage: node movement-relay.cjs <frontend-origin> <local-port>");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function rawHash(value: unknown, prefix: string) {
  if (typeof value !== "string" || !/^u[A-Za-z0-9_-]{52}$/.test(value)) return null;
  const raw = Buffer.from(value.slice(1), "base64url");
  return raw.subarray(0, 3).toString("hex") === prefix ? raw : null;
}

const http = createServer((_request, response) => response.writeHead(404).end());
const server = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
const rooms = new Map<string, Map<string, WebSocket>>();

http.on("upgrade", (request, socket, head) => {
  if (request.url !== MOVEMENT_PATH || request.headers.origin !== origin || server.clients.size >= 128) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  server.handleUpgrade(request, socket, head, (connection) => server.emit("connection", connection));
});

server.on("connection", (connection) => {
  const nonce = randomBytes(32).toString("hex");
  let seat: { dna: string; agent: string; room: Map<string, WebSocket> } | null = null;
  let verifying = false;
  let last = 0;
  let alive = true;
  const deadline = setTimeout(() => connection.close(1008), 7000);
  const heartbeat = setInterval(() => {
    if (alive) {
      alive = false;
      connection.ping();
    } else {
      connection.terminate();
    }
  }, 10000);
  connection.on("error", () => connection.terminate());
  connection.on("pong", () => { alive = true; });
  connection.on("close", () => {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (!seat || seat.room.get(seat.agent) !== connection) return;
    seat.room.delete(seat.agent);
    if (!seat.room.size) rooms.delete(seat.dna);
  });
  connection.send(JSON.stringify({ nonce }));

  connection.on("message", async (bytes, binary) => {
    if (binary) return connection.close(1003);
    let packet;
    try {
      packet = JSON.parse(bytes.toString());
    } catch {
      return connection.close(1007);
    }
    if (seat) {
      if (!validPosition(packet)) return connection.close(1008);
      const now = Date.now();
      if (now - last < 50) return;
      last = now;
      const frame = JSON.stringify([seat.agent, ...packet]);
      for (const peer of seat.room.values()) {
        if (peer !== connection && peer.readyState === WebSocket.OPEN && peer.bufferedAmount < 4096) peer.send(frame);
      }
      return;
    }
    if (verifying) return connection.close(1008);
    verifying = true;
    try {
      const { dna, agent, signature } = packet;
      const raw = rawHash(agent, "842024");
      if (!raw || !rawHash(dna, "842d24") || typeof signature !== "string" ||
          !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return connection.close(1008);
      const digest = await movementDigest(movementChallenge(origin, dna, agent, nonce));
      const key = Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(3, 35)]);
      if (!verify(null, digest, { key, format: "der", type: "spki" }, Buffer.from(signature, "base64")))
        return connection.close(1008);
      if (connection.readyState !== WebSocket.OPEN) return;
      const room = rooms.get(dna) ?? new Map<string, WebSocket>();
      if (room.has(agent)) return connection.close(1013);
      seat = { dna, agent, room };
      rooms.set(dna, room);
      room.set(agent, connection);
      clearTimeout(deadline);
      connection.send(JSON.stringify({ ready: true }));
    } catch {
      connection.close(1008);
    }
  });
});

http.listen(Number(port), "127.0.0.1");
