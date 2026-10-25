import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// PeerKit's libp2p transport is isomorphic, but `@peerkit/transport-libp2p`
// re-exports relay/certificate helpers that reach for `node:net` / `node:crypto`.
// Nothing on the browser node path calls them; the aliases below satisfy the
// imports. Same seam the blackjack `web/` build handles.
const shims = resolve(__dirname, "src/shims");

// `npm run relay` writes its addresses to ui/.relay.json; the dev server hands
// them to game windows at /relay.json so nobody pastes a relay address. It's a
// dev-server route rather than a public/ file so a build never ships a stale one.
const localRelay: Plugin = {
  name: "local-relay",
  configureServer(server) {
    server.middlewares.use("/relay.json", async (_req, res) => {
      try {
        const body = await readFile(resolve(__dirname, ".relay.json"));
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
  },
};

// `npm run linked-conductor` (scripts/shared-conductor.mjs) writes connection
// info for the shared imposter+hNFT conductor to ui/.shared-conductor.json;
// served the same way as /relay.json, and absent (404) when that script isn't
// running — the normal solo-imposter demo never needs it.
const localSharedConductor: Plugin = {
  name: "local-shared-conductor",
  configureServer(server) {
    server.middlewares.use("/shared-conductor.json", async (_req, res) => {
      try {
        const body = await readFile(resolve(__dirname, ".shared-conductor.json"));
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
  },
};

export default defineConfig({
  resolve: {
    alias: [
      { find: /^node:net$/, replacement: resolve(shims, "node-net.ts") },
      { find: /^node:crypto$/, replacement: resolve(shims, "node-crypto.ts") },
    ],
  },
  plugins: [
    nodePolyfills({
      exclude: ["crypto", "net"],
      globals: { Buffer: true, global: true, process: true },
    }),
    localRelay,
    localSharedConductor,
  ],
  server: { port: 5173 },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
