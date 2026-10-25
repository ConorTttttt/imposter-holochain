/**
 * A local PeerKit relay/bootstrap node. Peers find each other through it: each
 * registers its dialable addresses, and the relay hands that list to everyone
 * else. It never sees a position packet or a chat line.
 *
 *   npm run relay                              any room
 *   npm run relay -- --room LOBBY-DEMO         only that room (or just `-- LOBBY-DEMO`)
 *   npm run relay -- --listen 0.0.0.0:9123     another port
 *
 * Serving any room is safe: a player's node only connects to peers presenting
 * the same room key, so rooms never mix — the relay just introduces them.
 *
 * It writes its addresses to ui/.relay.json, which the Vite dev server serves
 * at /relay.json (see vite.config.ts), so game windows fill in the relay box
 * by themselves. A packaged
 * build has no dev server: paste one of the printed addresses there instead.
 *
 * Ported from the blackjack `src/relay.ts`.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PeerkitRelayBuilder } from "@peerkit/peerkit";
import { localDevRelayListenAddr } from "@peerkit/transport-libp2p";
import { sha256 } from "@noble/hashes/sha2.js";

// libp2p calls `Promise.withResolvers` (Node 22+). `nix develop` provides Node
// 22, but a plain shell often has an older Node (e.g. nvm's 20), where the
// relay died with "Promise.withResolvers is not a function". libp2p only calls
// it once the node is built, so defining it here, after the imports, is early
// enough.
if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const RELAY_ACCESS_BYTES = new TextEncoder().encode("imposter-relay");

/** Where the game's dev server picks the relay's addresses up from. */
const DISCOVERY_FILE = fileURLToPath(new URL("../.relay.json", import.meta.url));

function networkKeyFor(code: string): Uint8Array {
  return sha256(new TextEncoder().encode(`imposter:${code}`));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `--name value`, or else the `n`th plain argument (the old positional form). */
function arg(name: string, n: number): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const plain = process.argv.slice(2).filter((a, j, all) => !a.startsWith("--") && !all[j - 1]?.startsWith("--"));
  return plain[n];
}

async function main(): Promise<void> {
  const room = arg("room", 0) ?? null;
  const listen = arg("listen", 1) ?? localDevRelayListenAddr;
  const key = room ? networkKeyFor(room) : null;

  const relay = await new PeerkitRelayBuilder(
    async (_id: string, bytes: Uint8Array) => bytes.length > 32 && (!key || bytesEqual(bytes.subarray(32), key)),
  )
    .withNetworkAccessBytes(RELAY_ACCESS_BYTES)
    .withAddresses([listen])
    .build();

  const addresses = relay.transport.getListenAddresses().map(String);
  writeFileSync(DISCOVERY_FILE, JSON.stringify({ addresses, room, pid: process.pid, startedAt: Date.now() }, null, 2));

  console.log(`\n  Imposter relay for ${room ? `lobby "${room}"` : "any room"}`);
  console.log("  Game windows served by the Vite dev server find it by themselves.");
  console.log("  For anything else, paste one of these into the relay box:\n");
  for (const a of addresses) console.log(`    ${a}`);
  console.log("\n  Ctrl-C to stop.\n");

  const stop = () => {
    try {
      unlinkSync(DISCOVERY_FILE); // so windows stop finding a relay that's gone
    } catch {
      /* already gone */
    }
    void relay.shutDown().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error("relay failed to start:", e);
  process.exit(1);
});
