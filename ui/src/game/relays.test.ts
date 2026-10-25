import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRelayAddress } from "./relays.js";

const loopback = "/ip4/127.0.0.1/udp/9000/webrtc-direct/certhash/uEiA/p2p/12D3KooW";
const lan = "/ip4/192.168.0.49/udp/9000/webrtc-direct/certhash/uEiA/p2p/12D3KooW";
const relay = (room: string | null = null) => ({ addresses: [loopback, lan], room });

test("a window loaded from this machine dials the relay over loopback", () => {
  assert.equal(pickRelayAddress(relay(), "localhost", "LOBBY-DEMO"), loopback);
  assert.equal(pickRelayAddress(relay(), "127.0.0.1", "LOBBY-DEMO"), loopback);
});

test("a window loaded over the LAN dials the relay's LAN address", () => {
  assert.equal(pickRelayAddress(relay(), "192.168.0.49", "LOBBY-DEMO"), lan);
  assert.equal(pickRelayAddress(relay(), "some-laptop.local", "LOBBY-DEMO"), lan);
});

test("a relay for another room, or with no addresses, isn't used", () => {
  assert.equal(pickRelayAddress(relay("OTHER"), "localhost", "LOBBY-DEMO"), null);
  assert.equal(pickRelayAddress(relay("LOBBY-DEMO"), "localhost", "LOBBY-DEMO"), loopback);
  assert.equal(pickRelayAddress({ addresses: [], room: null }, "localhost", "LOBBY-DEMO"), null);
});
