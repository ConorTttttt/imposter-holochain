// Browser stub — the relay helpers that use `node:net` are never called on the
// browser node path. See vite.config.ts.
//
// `@peerkit/transport-libp2p-nodejs` also imports `isIP` at module top level
// (address.js / relay.js) for multiaddr parsing, so that one needs a real
// implementation even though the browser path never hits the code that calls it.
export default {};
export class Server {}
export function createServer(): never {
  throw new Error("node:net is not available in the browser build");
}

const V4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Covers full, compressed (::), and IPv4-mapped forms.
const V6 =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))$/;

export function isIPv4(input: string): boolean {
  return V4.test(input);
}
export function isIPv6(input: string): boolean {
  return V6.test(input);
}
export function isIP(input: string): 0 | 4 | 6 {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}
