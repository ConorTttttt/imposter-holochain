# Browser gameplay candidate

Build this candidate on the browser gameplay branch. It uses the same pinned game, HWC extensions, gateway, and host-bound hApp as the browser alpha.

## Build and start

Use Node v22.22.0, the pinned game and HWC checkouts, and the accepted gateway binary from the [browser alpha operator instructions](installed-hwc-browser-alpha.md). Use the approved unused host-bound network for a new round.

```sh
npm --prefix ui ci
bash release/browser-alpha/build-gameplay.sh /path/to/pinned-game /path/to/new-gameplay-output
(cd /path/to/new-gameplay-output && sha256sum --check SHA256SUMS)

BROWSER_ALPHA_GAMEPLAY=1 bash release/browser-alpha/build.sh \
  /path/to/pinned-game /path/to/pinned-HWC "$HOST_PUBLIC_KEY" "$NETWORK_SEED" \
  /path/to/accepted-gateway /path/to/new-release
```

The first command builds the frontend and standalone movement relay. The second produces the verified, host-bound release. The standalone frontend and packaged frontend have identical bytes.

Run the relay on the frontend server with the exact public frontend origin and a free local port such as 8092.

```sh
node /path/to/new-gameplay-output/movement-relay.cjs https://your-frontend.example 8092
```

Render the frontend proxy configuration with `deploy.py render-proxy --movement-port 8092` and the usual `--public` and `--operator` inputs. Publish the new release with the usual `deploy.py publish` command and the gameplay branch commit and release checksum. Keep the relay process running while playing.

## Test the map with Chrome and Firefox

1. In three distinct browser profiles, install the approved HWC builds and follow `/browser-setup.html` to unlock, authorize, and install the exact host-bound hApp. Use Chrome or Chromium for the host and one guest and Firefox Desktop for the other guest.
2. Open `/browser-demo.html`. Give each browser a distinct name, create the lobby in the host profile and join from both guests.
3. Select **Start round** in the host profile. Check that all three clients show the same three seats and phase, and that each displays its own verified role.
4. Focus each ship map and move using WASD or the arrow keys. Check that all three avatars move from their own spawns, the camera follows the local player, and the walls block movement through room boundaries.
5. Reload Firefox. The same seat should resume from its spawn. The movement roster should show that player offline if the interruption lasts more than 3.5 seconds and connected after fresh positions arrive.
6. In this milestone, use the existing **Align Engine Output** demo control in a crewmate profile to check the native shared result.

Movement uses a same-origin WebSocket through the frontend proxy. The relay verifies a fresh, domain-separated signature from the existing HWC identity, then accepts coordinate updates. The map uses native seats for player names, colours and roster membership. Coordinates are transient player-supplied data. If the movement relay is unavailable, local movement and native round status continue.
