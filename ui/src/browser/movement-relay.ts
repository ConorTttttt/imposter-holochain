import { serveMovement } from "./movement-server.js";
import { nativeMembership } from "./relay-membership.js";

const [origin, port, adminPort, gatewayDb] = process.argv.slice(2);
if (!gatewayDb || !/^\d+$/.test(adminPort ?? "") || !origin || new URL(origin).origin !== origin || !/^https?:\/\//.test(origin) ||
    !port || !/^\d+$/.test(port) || Number(port) <= 0 || Number(port) > 65535) {
  throw new Error("Usage: node movement-relay.cjs <frontend-origin> <local-port> <authority-admin-port> <gateway-session-db>");
}

nativeMembership(Number(adminPort), gatewayDb).then(membership => serveMovement(origin, Number(port), membership));
