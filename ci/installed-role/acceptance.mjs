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

async function extensionWorker(profile) {
  return profile.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
    ?? await profile.waitForEvent('serviceworker', {timeout:15000});
}

async function observe(profile) {
  const worker = await extensionWorker(profile);
  return worker.evaluate(() => globalThis.__imposterInstalledRoleEvidence());
}

async function tryCiphertext(profile, frame) {
  const worker = await extensionWorker(profile);
  return worker.evaluate(payload => globalThis.__imposterTryRoleCiphertext(payload), frame);
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

export async function verifyInstalledRole({profiles, pages, agents, dna, lobby, seats, joinB, restartGuestB, output}) {
  const evidence = {dna, lobby, host:agents[0], guestB:agents[1], guestC:agents[2]};
  const save = () => writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  const seatB = seats.guest_b.my_seat;
  assert(Number.isInteger(seatB));
  assert(Number.isInteger(seats.guest_c.my_seat) && seats.guest_c.my_seat !== seatB);
  save();

  for (const page of [pages[0], pages[2]]) {
    await assert.rejects(() => gameCall(page, 'host_role_opening', null), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  }
  await pages[0].evaluate(() => {
    window.addEventListener('imposter:action', event => {
      if (event.detail.kind === 'start') window.ciPublicCommit = event.detail.record;
    });
  });
  await pages[0].locator('#start-round').click();
  const result = await until(() => pages[0].evaluate(() => window.ciPublicCommit),
    'The host Start round button did not author a public RoleCommit', 30000);
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

  const wrongAction = [...raw(joinB)];
  for (const [mutated, expected] of [
    [{...query, expected_lobby:wrongAction}, /wrong lobby action/],
    [{...query, expected_role_commit:wrongAction}, /substituted RoleCommit/],
    [{...query, expected_seat:seats.guest_c.my_seat}, /recipient is not the cited canonical seat/],
  ]) {
    await assert.rejects(() => gameCall(pages[1], 'get_authoritative_game_view', mutated), expected);
  }
  evidence.nativeActionAndSeatSubstitutionDenied = true;
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
    if (!rows.every(row => row.nativeEnrollmentPublished)) return;
    if (rows[0].gatewayRoleDeliveryQueued < 2 ||
        rows[1].gatewayRoleRequestQueued < 1 || rows[2].gatewayRoleRequestQueued < 1) return;
    if (!rows[1].receipt || !rows[2].receipt) return;
    return rows;
  }, 'Timed out waiting for a gateway enqueue and independent Guest B extension receipt', 180000);
  assert.deepEqual(guestB.receipt, {
    seat:seatB, roleCommit:commitHex,
    recipient:raw(agents[1]).toString('hex'), coordinatorInvoked:false,
  });
  assert.equal(host.decryptedRoleReceipts, 0);
  assert.deepEqual(guestC.receipt, {
    seat:seats.guest_c.my_seat, roleCommit:commitHex,
    recipient:raw(agents[2]).toString('hex'), coordinatorInvoked:false,
  });
  // The protected opener stays inaccessible even on the Host's authorized page.
  await assert.rejects(() => gameCall(pages[0], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  await assert.rejects(() => gameCall(pages[2], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  evidence.gatewayEnqueue = {requests:guestB.gatewayRoleRequestQueued, deliveries:host.gatewayRoleDeliveryQueued};
  evidence.guestBExtensionReceipt = guestB.receipt;
  evidence.guestCExtensionReceipt = guestC.receipt;
  evidence.protectedOpeningDenied = true;
  save();

  // Capture a real gateway delivery in memory. Invoke the installed receiver
  // through the CI debugger, with a fresh probe of each real offscreen lease.
  // These probes target extension acceptance after the WS boundary.
  const workerB = await extensionWorker(profiles[1]);
  const frame = await workerB.evaluate(() => globalThis.__imposterRoleCiphertext());
  assert(frame, 'No genuine Guest B ciphertext was captured');
  const delivery = JSON.parse(frame);
  assert(delivery.envelope.recipient_agent === agents[1] && delivery.envelope.role_commit === commit,
    'The captured delivery was for a different recipient or commitment');
  assert.equal(await tryCiphertext(profiles[2], frame), 'wrong-recipient-cell');
  const signature = (delivery.signature[0] === 'A' ? 'B' : 'A') + delivery.signature.slice(1);
  assert.equal(await tryCiphertext(profiles[1], JSON.stringify({...delivery, signature})), 'bad-signature');
  assert.equal(await tryCiphertext(profiles[1], frame), 'uncorrelated');
  evidence.liveCiphertextDenials = {wrongRecipient:true, forgedHostSignature:true, duplicate:true};
  save();

  const restarted = await restartGuestB();
  profiles[1] = restarted.profile;
  pages[1] = restarted.page;
  assert(delivery.envelope.expires_at_ms > Date.now(), 'Restart missed the live ciphertext replay window');
  assert.equal(await tryCiphertext(profiles[1], frame), 'uncorrelated');
  evidence.liveCiphertextReplayDeniedAfterChromiumRestart = true;
  save();

  for (const page of pages) {
    await page.waitForFunction(() => document.querySelector('#my-role')?.textContent
      ?.startsWith('Your verified role:'), null, {timeout:120000});
    await assert.rejects(() => gameCall(page, 'get_verified_browser_role', {recipient:agents[1]}),
      /PRIVATE_ROLE_ORIGIN_OR_PAYLOAD_DENIED/);
  }
  evidence.ownRoleRenderedInAllThreeBrowsers = true;
  save();

  const crew = await until(async () => {
    for (const page of pages) {
      if (await page.locator('#complete-task').isVisible() &&
          await page.locator('#complete-task').isEnabled()) return page;
    }
  }, 'No verified crew profile could play the shared console');
  await crew.locator('#complete-task').click();
  for (const page of pages) {
    await page.waitForFunction(() =>
      document.querySelector('#round-state')?.textContent === 'Phase: Ended · Crew wins' &&
      document.querySelector('#task-progress')?.textContent === 'Task completions: 1/1',
    null, {timeout:120000});
  }
  evidence.nativeCrewWinAndSharedTaskProgress = true;
  save();
}
