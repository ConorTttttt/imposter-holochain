# Repeatable browser lobbies

## Root cause in the operator alpha

The operator release packages game source `0f7b17592e682a7b7d77e9346528cba69a096cdc`. Its browser hApp has a single host-bound cell and a clone limit of zero. The page pre-fills the cell's `g1.<host>.<id>` deployment seed, requires that same value for both controls, and sends it to `create_lobby` on every click. The native coordinator recovers the existing local Lobby action when the inputs match. It rejects a different configuration and reads the single game index for joins, task processing, and phase. The restricted native role view also requires exactly one Lobby in that index.

The extension records the resulting Lobby action in an irreversible per-DNA, per-agent IndexedDB pin. The same pin holds the one accepted RoleCommit. Closing a browser ends its connection. The signed PlayerJoin action remains, and the RoleCommit fixes the original three seats. The ended round and its roster are therefore recovered on the next connection.

The replacement needs coordinated native, browser, and extension changes. The wire already authenticates the DNA, exact RoleCommit action, seat, sender, recipient, and recipient-key epoch. A native-validated RoleCommit already cites its Lobby and the exact signed joins. Native result validation also needs to bind the reveal and task evidence to the game's Lobby now that several games share a DHT.
