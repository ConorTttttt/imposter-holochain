// Browser stub — the relay/certificate helpers that use `node:crypto` are never
// called on the browser node path. WebCrypto covers what the transport needs.
// See vite.config.ts.
export default (globalThis as unknown as { crypto: Crypto }).crypto;
export const webcrypto = (globalThis as unknown as { crypto: Crypto }).crypto;
