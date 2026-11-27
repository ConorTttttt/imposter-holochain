# Unified browser integration contract

The authoritative starting point is 41b8572fb768189f551749881466070dc9f16625. The gameplay donor is 88632f15a76491706b261c238c65e8c4ea3cf89f. Both descend from the Firefox baseline 968c6e1c4d66d852faeb534c9486019deadbadfb. Keep the repeatable release's native integrity, extension selection and dependency pins as the starting point.

## Identity and round selection

Use the installed DNA and exact native Lobby action to identify a round. Resolve its public code and confirm the player's signed join. After start, resolve the exact RoleCommit and its roster. Every gameplay write must carry or reference evidence that resolves to that Lobby. Queries, task evidence, meeting actions, vote openings, ejection and result must follow the same ancestry. Opening history selects one explicit game. A browser operation that began under a previous selection must never update the current view.

## Browser and extension

Bind map, task, meeting and chat controllers to the selected native snapshot. Dispose of sockets, pending callbacks and local vote state on selection change. HWC owns Lair signing, recipient keys, encrypted deliveries, immutable per-Lobby pins and Merkle verification. Only expose the player's authorized role view. Require exact DNA, agent, Lobby, RoleCommit, key epoch and authenticated lease before confidential operations. Preserve durable replay reservations across games and process restarts.

## Native and relay authorization

Retain the accepted restricted coordinator and gateway interfaces. Add only narrowly typed round-scoped operations after native validation and PR review. Relay admission requires a fresh challenge bound to origin, DNA, Lobby and agent, plus independent native evidence of membership. Signature verification alone proves key possession. A lobby code is public. Resolve membership before subscribing a socket or sending it frames. Bind meeting chat to its exact meeting.

## Parallel development

Integration owns release assembly, extension selection hooks, native round selection and validation, relay admission and shared acceptance drivers. Gameplay contributors can implement feature-specific rendering and controls against an explicit selected snapshot. Propose new writes and confidential authorization evidence on this PR before changing shared interfaces. Kill, sabotage, vent and related feature branches are outside this candidate.

## Open contracts

The gameplay donor keys relay rooms by DNA and its page builder assumes the deployment seed identifies the game. Neither behavior satisfies this contract. The relay membership evidence source, meeting/result validation path and recovery behavior require implementation and genuine mixed-browser acceptance before operator use.
