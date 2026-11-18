/** Copied into the ephemeral CI extension only. Holds public test metadata. */
import {openRoleStore} from './store.mjs';
import {attestKey} from './wire.mjs';

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
let armed = null;
let sent = null;
let previous = null;

export function armFault(kind, recipient) {
  if (!['merkle', 'expired', 'rollback'].includes(kind) || !/^[0-9a-f]{78}$/.test(recipient))
    throw Error('Invalid CI role fault selection');
  armed = {kind, recipient};
  sent = null;
}

export async function rotateFixtureKey(dnaHex, agentHex) {
  const dna = fromHex(dnaHex), agent = fromHex(agentHex);
  const store = await openRoleStore();
  try {
    const cell = await store.getCell(dna, agent);
    if (cell?.epoch !== 1 || !cell.attestation) throw Error('Expected a real epoch-one enrollment');
    const {keyId, publicKey, epoch} = cell;
    previous = {dna, agent, keyId, publicKey, epoch};
    const next = await store.rotateCell(dna, agent, epoch + 1);
    return next.epoch;
  } finally {
    store.close();
  }
}

export async function fixtureTrustedEpoch(dnaHex, agentHex) {
  const store = await openRoleStore();
  try {
    return (await store.getTrustedFloor(fromHex(dnaHex), fromHex(agentHex)))?.epoch ?? null;
  } finally {
    store.close();
  }
}

export function fixtureRoleOpening(recipient, payload) {
  if (armed?.kind !== 'merkle' || armed.recipient !== hex(recipient)) return payload;
  const corrupt = payload.slice();
  // Preserve the opening encoding and corrupt one sibling after host verification.
  corrupt[corrupt.length - 1] ^= 1;
  return corrupt;
}

export async function fixtureRecipientAttestation(own, sign) {
  if (armed?.recipient !== hex(own.agent) || armed.kind === 'merkle') return own.attestation;
  const {kind} = armed;
  const identity = kind === 'rollback' ? previous : own;
  if (!identity || hex(identity.agent) !== hex(own.agent) || hex(identity.dna) !== hex(own.dna))
    throw Error('No prior key for the installed CI cell');
  const {dna, agent, keyId, publicKey, epoch} = identity;
  // The real Lair signer signs both inputs. A current outer frame carries the
  // expired inner attestation, so expiry is exercised after HPKE and transport auth.
  return attestKey({dna, agent, keyId, publicKey, epoch, sign,
    now:Date.now() - (kind === 'expired' ? 65000 : 0)});
}

export function observeFixtureSend(packet) {
  const kind = armed?.kind;
  if (!kind) return;
  const delivery = packet.operation === 'role_delivery_v1';
  if ((kind === 'merkle') !== delivery ||
      armed.recipient !== hex(delivery ? packet.recipient : packet.sender)) return;
  sent = {kind, messageId:hex(packet.messageId)};
  armed = null;
}

export const lastFixtureSend = () => sent;
