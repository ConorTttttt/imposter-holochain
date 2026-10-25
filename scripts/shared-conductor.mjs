#!/usr/bin/env node
// One conductor, one agent key, both apps: imposter-holochain and hNFT
// installed side by side under the same identity, so "my heads" in one app
// means the same agent as "my XP" in the other. `hc-spin` can't do this — it
// always mints a fresh random key per launch, in its own separate sandbox —
// so this drives the conductor directly over the admin API instead, the way
// hc-spin itself does under the hood (same `hc sandbox` invocation, same
// piped "pass" passphrase; see its `spawnSandboxes` for the reference this
// was checked against).
//
// Needs the Holochain toolchain (`hc`, `holochain`) on PATH — run inside
// `nix develop`, e.g.:
//
//   sh scripts/in-nix.sh node scripts/shared-conductor.mjs
//
// Idempotent: a second run reuses the existing sandbox, agent key and Head
// Skins collection instead of recreating them, and just refreshes the
// connection tokens (they expire) and the file the UI reads them from.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SANDBOX_DIR = `${ROOT}.shared-sandbox`;
const ADMIN_PORT = Number(process.argv[2] ?? 4444);
const ORIGIN = "imposter-shared-conductor";
const IMPOSTER_HAPP = `${ROOT}workdir/imposter.happ`;
const HNFT_HAPP = "/home/sf/hNFT/workdir/p2p_art_marketplace.happ";
const HEADS_SEED = "imposter-head-skins-v1";
// Discovered by the UI the same way relay.ts's address is (a small JSON file
// the Vite dev server serves) — see ui/vite.config.ts's `local-relay` plugin,
// which this mirrors.
const CONNECTION_FILE = `${ROOT}ui/.shared-conductor.json`;

// @holochain/client isn't a root dependency (only the UI needs it at
// runtime) — reach into the UI's copy rather than duplicate the install.
const { AdminWebsocket, AppWebsocket, encodeHashToBase64 } = await import(
  `${ROOT}ui/node_modules/@holochain/client/lib/index.js`
);

function run(cmd, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "inherit", "inherit"] });
    if (input != null) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on("error", reject);
  });
}

/** The long-running conductor process, piped "pass" the same way `create`
 *  was — resolves once the admin port is actually accepting connections.
 *  `detached: true` makes it its own process group leader, so `stop()` below
 *  can kill the whole tree at once: `hc sandbox run` spawns `holochain` as
 *  its own child, and a plain SIGTERM to just the `hc` process leaves that
 *  grandchild running (orphaned, still holding the admin port) rather than
 *  shutting it down with it. */
function spawnConductor() {
  const child = spawn(
    "hc",
    ["sandbox", "--force-admin-ports", String(ADMIN_PORT), "--piped", "run", "--all"],
    { cwd: SANDBOX_DIR, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  child.stdin.write("pass");
  child.stdin.end();
  child.stdout.on("data", (d) => process.stdout.write(`[conductor] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[conductor] ${d}`));
  return child;
}

async function waitForAdmin(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await AdminWebsocket.connect({ url: new URL(`ws://127.0.0.1:${ADMIN_PORT}`), wsClientOptions: { origin: ORIGIN } });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`admin interface on :${ADMIN_PORT} never came up`);
}

async function ensureApp(admin, apps, id, happPath, agentKey) {
  const existing = apps.find((a) => a.installed_app_id === id);
  if (existing) return existing.agent_pub_key;
  await admin.installApp({ source: { type: "path", value: happPath }, agent_key: agentKey, installed_app_id: id });
  await admin.enableApp({ installed_app_id: id });
  return agentKey;
}

async function ensureAppInterface(admin) {
  const existing = await admin.listAppInterfaces();
  if (existing.length > 0) return existing[0].port;
  const attached = await admin.attachAppInterface({ port: 0, allowed_origins: "*" });
  return attached.port;
}

/** Finds (or creates) the Head Skins clone and returns both ids `createCloneCell`
 *  already hands back directly — no second `appInfo()` lookup, so there's no
 *  risk of a shape mismatch there silently skipping authorization below. */
async function ensureHeadsCollection(app, agentKeyB64) {
  const info = await app.appInfo();
  const cells = info.cell_info?.nft ?? [];
  const found = cells
    .map((c) => c?.cloned ?? (c?.type === "cloned" ? (c.value ?? c) : undefined))
    .find((c) => c?.dna_modifiers?.network_seed === HEADS_SEED);
  if (found) return { cloneId: found.clone_id, cellId: found.cell_id };

  const clone = await app.createCloneCell({
    role_name: "nft",
    modifiers: {
      network_seed: HEADS_SEED,
      properties: {
        name: "Imposter Heads",
        symbol: "HEAD",
        max_supply: 0, // dev: no cap yet — a real drop sets one before minting starts
        minter_pubkey: agentKeyB64,
        royalty_bps: 0,
        transfer_window_secs: 3600,
      },
    },
    name: "Imposter Heads",
  });
  return { cloneId: clone.clone_id, cellId: clone.cell_id };
}

mkdirSync(SANDBOX_DIR, { recursive: true });
if (!existsSync(`${SANDBOX_DIR}/.hc`)) {
  console.log("creating the sandbox (first run)...");
  await run("hc", ["sandbox", "--piped", "create"], { cwd: SANDBOX_DIR, input: "pass" });
}

const conductor = spawnConductor();
const stop = () => {
  // So a stopped conductor never leaves a stale connection file behind —
  // the UI falls back to its normal hc-spin connection when this is gone.
  try {
    unlinkSync(CONNECTION_FILE);
  } catch {
    /* never written, or already gone */
  }
  try {
    process.kill(-conductor.pid, "SIGTERM"); // the whole group: hc, and the holochain it spawned
  } catch {
    /* already gone */
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const admin = await waitForAdmin();
console.log("admin connected on", ADMIN_PORT);

const apps = await admin.listApps({});
const sharedKey = apps[0]?.agent_pub_key ?? (await admin.generateAgentPubKey());
await ensureApp(admin, apps, "imposter", IMPOSTER_HAPP, sharedKey);
await ensureApp(admin, apps, "hnft", HNFT_HAPP, sharedKey);
console.log("both apps installed under", encodeHashToBase64(sharedKey));

const appPort = await ensureAppInterface(admin);
// Long-lived, reusable: this is a local dev tool, not a production auth
// boundary, and the default token otherwise expires quickly enough that a
// browser window opened a while after this script started (or reloaded
// later) would find its stored token already dead.
const tokenOpts = (installed_app_id) => ({ installed_app_id, expiry_seconds: 60 * 60 * 24, single_use: false });
const [imposterToken, hnftToken] = await Promise.all([
  admin.issueAppAuthenticationToken(tokenOpts("imposter")),
  admin.issueAppAuthenticationToken(tokenOpts("hnft")),
]);

const hnftApp = await AppWebsocket.connect({
  url: new URL(`ws://127.0.0.1:${appPort}`),
  token: hnftToken.token,
  wsClientOptions: { origin: ORIGIN },
});
const agentKeyB64 = encodeHashToBase64(sharedKey);
const { cloneId: headsCloneId, cellId: headsCellId } = await ensureHeadsCollection(hnftApp, agentKeyB64);
// Needed before any zome call on this cell will sign correctly. Authorizing
// twice (a clone found from a past run already has it) is harmless.
await admin.authorizeSigningCredentials(headsCellId);
console.log("Head Skins collection ready:", headsCloneId);

writeFileSync(
  CONNECTION_FILE,
  JSON.stringify(
    {
      adminPort: ADMIN_PORT,
      appPort,
      agentKeyB64,
      imposterToken: imposterToken.token,
      hnftToken: hnftToken.token,
      headsCloneId,
      // Signing credentials are per-process and in-memory only (see
      // @holochain/client's zome-call-signing.js) — authorizing them here,
      // in this script's process, does nothing for a browser tab calling
      // into the same cell from its own process. game/heads.ts authorizes
      // its own, using this cell id and the admin port above, the first
      // time it needs to.
      headsCellId: [Array.from(headsCellId[0]), Array.from(headsCellId[1])],
      startedAt: Date.now(),
    },
    null,
    2,
  ),
);
console.log(`\n  Shared conductor ready — admin :${ADMIN_PORT}, app :${appPort}`);
console.log(`  Connection info written to ${CONNECTION_FILE}`);
console.log("  Point the UI's dev server at this the same way it finds the relay. Ctrl-C to stop.\n");

// Otherwise nothing keeps the event loop open once setup finishes, this
// process exits, and `hc sandbox run` (holding the admin port) is orphaned
// rather than stopped — the next run then fails with "Address already in
// use" against a conductor nothing is managing anymore.
await new Promise(() => {});
