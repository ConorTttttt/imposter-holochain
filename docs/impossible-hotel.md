# Impossible Hotel — first playable visual pass

**Theme:** Art Deco / supernatural mystery. The hotel looks luxurious by candlelight and
unsettling during a blackout. All visual work lives in the UI; core game logic is unchanged.

## Built on this branch

- Velvet/emerald/brass CSS for menus, lobby, voting, chat, HUD and mini-games.
- Guest check-in hero; themed assembly screen, task ledger and crisis labels.
- Procedural Canvas2D floors, marble-inlay style borders, rugs, lamps, Grand Salon medallion
  and walnut furniture, using the **existing** room and collision geometry.
- Deterministic cosmetic guest headwear and lapels above the existing blockie/hNFT socket.
- All 14 hotel room names, all 18 task descriptions and all three crisis identities are
  display-only (see `ui/src/game/hotel.ts`); the Holochain IDs and raw names do not change.
- Tests for room, task, service-passage and crisis mappings.

## Layout

| Existing world name | Guest-facing name |
| --- | --- |
| Navigator Bridge | Grand Entrance |
| Communications Array | Reception & Switchboard |
| Shields Control | Doorman's Station |
| Weapons Control | Trophy Gallery |
| Medical Bay | Spa & Infirmary |
| Life Support | Conservatory |
| Commons | Grand Salon |
| Core Engine | Boiler & Lift Machinery |
| Security & Network | Surveillance Office |
| Reactor Core | The Great Furnace |
| Electrical Systems | Fuse Room |
| Cargo Control | Kitchen & Service Office |
| Storage Bay | Wine Cellar & Stores |
| Decontamination | Steam Laundry |

The Steam Laundry still runs the two-door timed airlock. The Mirror of Truth is still
the original cryptographically provable medical scan. Staff passages are the original
12-entrance maintenance network.

## Why this is a visual layer

`world.ts` uses room names and stable array indices for some local lookups; other
values are transmitted through Holochain and PeerKit. Renaming them in-place could
break navigation, emergency resolution or validation. `hotelRoomName`,
`hotelTaskName` and `hotelCrisisName` deliberately translate only visible labels.

Likewise, the map renderer draws flooring and furniture before entities and the
existing fog/occlusion pass. Cosmetics neither add collisions nor reveal hidden
players. Player outfits derive from public agent keys and never from secret roles.

## Run it

```bash
cd ui
npm ci
npm run typecheck
npm run test
npm run build
npm run dev
```

To play a real round with Holochain, follow the root README's `npm run demo` instructions.

## Follow-on art production

This branch is a **first playable theme implementation**, not finished hand-illustrated
assets. Next milestones:

1. Replace procedural floor/furniture textures with a cohesive atlas/sprite set.
2. Add independent character walking/idle/interaction sprites and an outfit picker.
3. Commission/pipeline room-specific props and directional shadows, while retaining
   the world collision map and ensuring adequate visibility at any vision radius.
4. Build hotel-specific minigame illustrations and sound design.
5. Improve meeting portraits, ejection animation and result sequence.
6. Profile frame rate and check colour contrast / screen sizes in a multi-client demo.

## Guardrails

Do not change `ROOMS` ordering, `TASKS` IDs, `VENTS` links, `CRISES` keys
or crisis-panel ordering as part of an art pass. Run `npm run test:ui` and
`npm run test:round` from the root before a gameplay-sensitive change.
