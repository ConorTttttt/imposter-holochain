// Finding the PeerKit relay without pasting its address. `npm run relay` writes
// its listen addresses to ui/public/relay.json, which the Vite dev server serves
// next to the game; a window picks the one it can reach.

/** What the relay writes. `room` is the only room it serves, or null for any. */
export type RelayInfo = { addresses: string[]; room: string | null };

/**
 * The relay address this window should dial, or null if there's none for it:
 * the relay serves another room, or has no addresses. A page loaded from this
 * machine uses loopback; one loaded over the LAN uses the address on the host
 * it came from, or else any non-loopback one.
 */
export function pickRelayAddress(info: RelayInfo, pageHost: string, room: string): string | null {
  if (info.room && info.room !== room) return null;
  const addresses = info.addresses ?? [];
  const onHost = addresses.find((a) => a.startsWith(`/ip4/${pageHost}/`));
  if (onHost) return onHost;
  const loopback = addresses.find((a) => a.startsWith("/ip4/127.0.0.1/"));
  const fromHere = pageHost === "localhost" || pageHost === "127.0.0.1";
  return (fromHere ? loopback : addresses.find((a) => a !== loopback)) ?? addresses[0] ?? null;
}
