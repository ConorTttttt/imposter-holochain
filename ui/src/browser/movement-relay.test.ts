import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { MOVEMENT_PATH, movementChallenge, movementDigest } from "./movement-wire.js";

const origin = "https://game.example.test";
const dna = "u" + Buffer.concat([Buffer.from("842d24", "hex"), randomBytes(36)]).toString("base64url");
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const agent = "u" + Buffer.concat([Buffer.from("842024", "hex"), raw, randomBytes(4)]).toString("base64url");
  return { agent, privateKey };
}

test("movement relay binds coordinates to a signed agent and rejects replay and invalid coordinates", { timeout: 12000 }, async (t) => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("Missing loopback test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const relay = spawn(process.execPath, ["--import", "tsx", "src/browser/movement-relay.ts", origin, String(address.port)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const sockets: WebSocket[] = [];
  t.after(() => {
    for (const socket of sockets) socket.terminate();
    relay.kill();
  });
  const http = `http://127.0.0.1:${address.port}`;
  for (let tries = 0; ; tries++) {
    try {
      assert.equal((await fetch(http)).status, 404);
      break;
    } catch (error) {
      if (tries >= 60 || relay.exitCode !== null) throw error;
      await delay(100);
    }
  }
  const url = http.replace("http:", "ws:") + MOVEMENT_PATH;
  async function open() {
    const socket = new WebSocket(url, { origin });
    sockets.push(socket);
    const [frame] = await once(socket, "message");
    const { nonce } = JSON.parse(frame.toString());
    assert.match(nonce, /^[a-f0-9]{64}$/);
    return { socket, nonce };
  }
  async function connect(user: ReturnType<typeof identity>) {
    const { socket, nonce } = await open();
    const digest = await movementDigest(movementChallenge(origin, dna, user.agent, nonce));
    const proof = { dna, agent: user.agent, signature: sign(null, digest, user.privateKey).toString("base64") };
    const ack = once(socket, "message");
    socket.send(JSON.stringify(proof));
    assert.deepEqual(JSON.parse((await ack)[0].toString()), { ready: true });
    return { socket, proof };
  }
  const alice = identity();
  const bob = identity();
  const { socket: sender, proof } = await connect(alice);
  const { socket: recipient } = await connect(bob);
  const updates = once(recipient, "message");
  sender.send(JSON.stringify([1200, 200]));
  assert.deepEqual(JSON.parse((await updates)[0].toString()), [alice.agent, 1200, 200]);

  const { socket: replay } = await open();
  const rejected = once(replay, "close");
  replay.send(JSON.stringify(proof));
  assert.equal((await rejected)[0], 1008);

  const badPosition = once(sender, "close");
  sender.send(JSON.stringify([0, 200]));
  assert.equal((await badPosition)[0], 1008);
  const resumed = await connect(alice);
  const next = once(recipient, "message");
  resumed.socket.send(JSON.stringify([1200, 210]));
  assert.deepEqual(JSON.parse((await next)[0].toString()), [alice.agent, 1200, 210]);
});
