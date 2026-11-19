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
2. Open `/browser-demo.html`. Give each browser a distinct name. Choose 1, 3, 6 or 18 tasks per player, create the lobby in the host profile, and join from both guests.
3. Select **Start round** after all players have joined. Check that all three clients show the same three seats and phase, and that each displays its own verified role.
4. Focus each ship map and move using WASD or the arrow keys. Check that all three avatars move from their own spawns, the camera follows the local player, and the walls block movement through room boundaries.
5. Reload Firefox. The same seat should resume from its spawn. The movement roster should show that player offline if the interruption lasts more than 3.5 seconds and connected after fresh positions arrive.
6. For a short task test, choose one task when creating the lobby. Walk from the Navigator Bridge through Communications and Commons to Core Engine. Approach the marked **Align Engine Output** console and press **E** or choose **Use Align Engine Output**. Align the slider with its marker and choose **Lock**. Check that the count updates to 1/2 in all profiles. When both crewmates finish, all profiles should show 2/2 and **Crew wins**.

The browser task pool is sized to the native per-seat quota, so every seat receives the same consoles. This works without desktop private task assignment calls. Impostors can play the console games as cover. Crewmate completions go through the native coordinator and count toward the native result. Medical Scan uses the original timed mini-game and records ordinary task completion.

Movement uses a same-origin WebSocket through the frontend proxy. The relay verifies a fresh, domain-separated signature from the existing HWC identity, then accepts coordinate updates. The map uses native seats for player names, colours and roster membership. Coordinates are transient player-supplied data. If the movement relay is unavailable, local movement and native round status continue.

## Test a meeting

After the emergency cooldown, approach the red emergency button in Commons and choose **Call emergency meeting**. All browsers should show the discussion timer, followed by the ballot. Choose **Skip** in all three profiles. After the native coordinator resolves the meeting, each browser should show three skip votes and **No player ejected**. Choose **Back to the game** to resume walking and completing consoles.

With a fresh disposable lobby, vote for a player instead to verify ejection and ghost visibility. The **Report body** action appears when the native state contains a body position and is enabled in reach of it. Creating a kill from a browser requires a native kill path compatible with the verified-role receiver.

Lobby and meeting chat use the same frontend relay as movement and keep messages in memory. Send a message from Chrome and Firefox and check that the other profiles receive it while they are in the same lobby or meeting. During meetings, ghost profiles can read the chat. Chat reconnects independently of the native ballot.
