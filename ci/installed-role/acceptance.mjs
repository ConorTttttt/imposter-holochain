import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

function raw(hash) {
  return Buffer.from(hash.slice(1), 'base64url');
}

function hash(value) {
  const bytes = value && Array.from(value.length === undefined ? Object.values(value) : value);
  assert.equal(bytes?.length, 39, 'Expected a native action or agent hash');
  return 'u' + Buffer.from(bytes).toString('base64url');
}

async function gameCall(page, fn, payload) {
  return page.evaluate(({fn, payload}) => {
    // Chrome IPC will serialize these typed arrays as dense number objects.
    // HWC restores them before serializing the native input as MessagePack.
    for (const field of ['expected_lobby', 'expected_role_commit', 'expected_recipient']) {
      if (payload?.[field]) payload[field] = Uint8Array.from(payload[field]);
    }
    return window.holochain.callZome({zome_name:'game', fn_name:fn, payload});
  }, {fn, payload});
}

async function observe(profile) {
  const worker = profile.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
    ?? await profile.waitForEvent('serviceworker', {timeout:15000});
  return worker.evaluate(() => globalThis.__imposterInstalledRoleEvidence());
}

async function until(check, reason, timeout = 120000) {
  const end = Date.now() + timeout;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Native gossip, registration and extension initialization are asynchronous.
    }
    await delay(1200);
  } while (Date.now() < end);
  throw Error(reason);
}

export async function verifyInstalledRole({profiles, pages, agents, dna, lobby, seats, output}) {
  const evidence = {dna, lobby, host:agents[0], guestB:agents[1], guestC:agents[2]};
  const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  const seatB = seats.guest_b.my_seat;
  assert(Number.isInteger(seatB));
  assert(Number.isInteger(seats.guest_c.my_seat) && seats.guest_c.my_seat !== seatB);
  save();

  for (const page of [pages[0], pages[2]]) {
    await assert.rejects(() => gameCall(page, 'host_role_opening', null), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  }
  const result = await gameCall(pages[0], 'commit_roles_only', null);
  const commit = hash(result?.role_commit);
  assert.match(commit, /^uhCkk/);
  assert.deepEqual(result.seats.map(hash), seats.host.agents);
  evidence.roleCommit = commit;
  save();

  const query = {
    expected_lobby:[...raw(lobby)], expected_role_commit:[...raw(commit)],
    expected_recipient:[...raw(agents[1])], expected_seat:seatB,
  };
  for (const page of pages) {
    await until(async () => {
      const view = await gameCall(page, 'get_authoritative_game_view', query);
      return view.schema_version === 1 && view.phase === 'playing'
        && hash(view.dna) === dna && hash(view.lobby_action) === lobby
        && hash(view.host) === agents[0] && hash(view.role_commit_action) === commit
        && hash(view.seats[seatB].agent) === agents[1];
    }, 'Browser did not read the exact native-valid committed seat');
  }
  evidence.independentNativeViews = 3;
  save();

  const commitHex = raw(commit).toString('hex');
  async function metadata() {
    return Promise.all(profiles.map(async (profile, index) => {
      const agent = raw(agents[index]).toString('hex');
      return (await observe(profile)).find(row => row.installedAgent === agent) ?? null;
    }));
  }
  const [host, guestB, guestC] = await until(async () => {
    const rows = await metadata();
    // Keep progress eligible for artifact upload even if one gate times out.
    evidence.progress = rows.map(row => row && ({
      lobbyPinned:row.pinnedLobby === raw(lobby).toString('hex'),
      commitPinned:row.pinnedRoleCommit === commitHex,
      sessionBound:row.sessionBound, nativeEnrollment:row.nativeEnrollmentPublished,
      requestAcks:row.gatewayRoleRequestQueued, deliveryAcks:row.gatewayRoleDeliveryQueued,
      recipientReceipts:row.decryptedRoleReceipts,
    }));
    save();
    if (!rows.every(row => row?.pinnedRoleCommit === commitHex && row.sessionBound)) return;
    if (!rows[0].nativeEnrollmentPublished || !rows[1].nativeEnrollmentPublished) return;
    if (rows[0].gatewayRoleDeliveryQueued < 1 || rows[1].gatewayRoleRequestQueued < 1) return;
    if (!rows[1].receipt) return;
    return rows;
  }, 'Timed out waiting for a gateway enqueue and independent Guest B extension receipt', 180000);
  assert.deepEqual(guestB.receipt, {
    seat:seatB, roleCommit:commitHex,
    recipient:raw(agents[1]).toString('hex'), coordinatorInvoked:false,
  });
  assert.equal(host.decryptedRoleReceipts, 0);
  assert.equal(guestC.decryptedRoleReceipts, 0);
  assert.equal(guestC.gatewayRoleRequestQueued, 0);
  // The protected opener stays inaccessible even on the Host's authorized page.
  await assert.rejects(() => gameCall(pages[0], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  await assert.rejects(() => gameCall(pages[2], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  evidence.gatewayEnqueue = {requests:guestB.gatewayRoleRequestQueued, deliveries:host.gatewayRoleDeliveryQueued};
  evidence.guestBExtensionReceipt = guestB.receipt;
  evidence.guestCReceipts = guestC.decryptedRoleReceipts;
  evidence.protectedOpeningDenied = true;
  save();
}
