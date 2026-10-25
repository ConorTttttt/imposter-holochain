// A player's equipped head, if they own one: read from a separate Holochain
// app — hNFT, a sibling P2P NFT marketplace hApp — rather than from
// imposter-holochain's own DNA. This only means anything when both apps are
// installed under the same agent key, which `hc-spin` can't do (it always
// mints a fresh key per launch); `npm run linked-conductor`
// (scripts/shared-conductor.mjs) sets up a conductor where they share one,
// and writes the connection details this module reads.
//
// Entirely best-effort: no shared conductor running (the normal solo demo),
// a mismatched agent key, or owning nothing at all all fall back to the same
// place — draw the blockie (game/blockie.ts) instead. Nothing here is ever
// awaited by the render loop; `equippedHead` returns synchronously from
// whatever's already been loaded.

import { AdminWebsocket, AppWebsocket, decodeHashFromBase64, type AppClient, type CellId } from "@holochain/client";
import { decode } from "@msgpack/msgpack";

type ConnectionInfo = {
  adminPort: number;
  appPort: number;
  agentKeyB64: string;
  hnftToken: number[];
  headsCloneId: string;
  headsCellId: [number[], number[]];
};

/** Mirrors hNFT's `NftPayload` (client/src/types.ts) just enough to read an
 *  image out of a revealed head — see that project for the full shape. */
type NftManifest = { payload: { status: "sealed" } | { status: "revealed"; image_uri: string } };

function decodeManifest(record: any): NftManifest {
  const entry = record?.entry?.Present?.entry;
  return decode(entry) as NftManifest;
}

let app: AppClient | null = null;
let cloneId: string | null = null;
let loaded: Promise<void> | null = null;
const equipped = new Map<string, string>(); // keyB64 -> image_uri, once loaded

/** Try to connect to the shared conductor and load owned heads for `myKeyB64`.
 *  Safe to call every time the entry screen mounts; it only does real work
 *  once. Never throws — a failure here just means everyone sees blockies. */
export function tryLoadHeads(myKeyB64: string): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    const res = await fetch("/shared-conductor.json", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return; // no linked-conductor running: the normal solo demo
    const info: ConnectionInfo = await res.json();
    if (info.agentKeyB64 !== myKeyB64) return; // this window isn't the shared identity

    // Signing credentials are per-process, in-memory only — authorizing them
    // in scripts/shared-conductor.mjs's process does nothing for this one.
    // Every fresh window/tab needs its own, once, before its first call.
    const cellId: CellId = [new Uint8Array(info.headsCellId[0]), new Uint8Array(info.headsCellId[1])];
    const admin = await AdminWebsocket.connect({
      url: new URL(`ws://127.0.0.1:${info.adminPort}`),
      wsClientOptions: { origin: "imposter-ui" },
    });
    await admin.authorizeSigningCredentials(cellId);

    app = await AppWebsocket.connect({
      url: new URL(`ws://127.0.0.1:${info.appPort}`),
      token: info.hnftToken as unknown as number[],
      wsClientOptions: { origin: "imposter-ui" },
    });
    cloneId = info.headsCloneId;

    // `get_nfts_for_agent` returns mint records, not their current (possibly
    // revealed) state — each needs a follow-up `get_nft` for that, same as
    // hNFT's own client does.
    const minted: any[] = await app.callZome({
      role_name: cloneId,
      zome_name: "nft",
      fn_name: "get_nfts_for_agent",
      payload: { agent: decodeHashFromBase64(myKeyB64) },
    });
    for (const mint of minted) {
      const identity = mint.signed_action.hashed.hash;
      const current = await app.callZome({ role_name: cloneId, zome_name: "nft", fn_name: "get_nft", payload: identity });
      const manifest = current && decodeManifest(current);
      if (manifest?.payload.status === "revealed") {
        equipped.set(myKeyB64, manifest.payload.image_uri);
        break; // v1: whichever owned head comes back first; picking one comes later
      }
    }
  })().catch((e) => {
    console.warn("heads: shared conductor unavailable, using blockies:", e);
  });
  return loaded;
}

const images = new Map<string, HTMLImageElement | "loading" | "error">();

/** A player's equipped head, ready to `drawImage`, or null for the blockie
 *  default (game/blockie.ts) — no shared conductor, nothing owned, or (the
 *  first time only) the image is still loading. Never blocks the render
 *  loop: a still-loading or missing image just means one more blockie frame. */
export function equippedHeadImage(keyB64: string): HTMLImageElement | null {
  const uri = equipped.get(keyB64);
  if (!uri) return null;
  const cached = images.get(uri);
  if (cached instanceof HTMLImageElement) return cached;
  if (!cached) {
    images.set(uri, "loading");
    const img = new Image();
    img.onload = () => images.set(uri, img);
    img.onerror = () => images.set(uri, "error");
    img.src = uri;
  }
  return null;
}
