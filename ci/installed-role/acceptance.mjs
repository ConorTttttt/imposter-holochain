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

async function replayRecorded(profile, delivery) {
  const envelope = delivery.envelope;
  const id = [envelope.dna_hash, envelope.recipient_agent, envelope.sender_agent]
    .map(value => raw(value).toString('hex')).concat(envelope.message_id).join(':');
  const worker = await extensionWorker(profile);
  return worker.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open('hwc-imposter-private-role-v1');
    open.onerror = () => reject(Error('Extension role database unavailable'));
    open.onsuccess = () => {
      const db = open.result;
      const record = db.transaction('replay').objectStore('replay').count(key);
      record.onsuccess = () => { db.close(); resolve(record.result === 1); };
      record.onerror = () => { db.close(); reject(Error('Replay reservation unavailable')); };
    };
  }), id);
}

async function verifyRevocation(profile, page, agent) {
  const linker = process.env.H2HC_BASE_URL;
  const admin = process.env.H2HC_LINKER_ADMIN_SECRET;
  assert(linker && admin, 'Ephemeral gateway administration is required');
  const worker = await extensionWorker(profile);
  const priorReceipt = await worker.evaluate(() => globalThis.__imposterRoleCiphertext());
  assert(priorReceipt, 'Guest C had no genuine pre-revocation receipt');
  const pause = command => worker.evaluate(cmd => globalThis.__imposterPauseRoleDelivery(cmd), command);
  const configure = url => page.evaluate(linkerUrl =>
    window.holochain.configureNetwork({linkerUrl}), url);
  const authenticated = () => page.evaluate(async () => {
    const connection = await window.holochain.getConnectionStatus();
    const session = await window.holochain.getNetworkStatus();
    return connection.authenticated && connection.wsHealthy && session.hasSession;
  });
  const authorize = async (method, body) => {
    const response = await fetch(linker + '/admin/agents', {
      method, headers:{Authorization:'Bearer ' + admin, 'Content-Type':'application/json'},
      body:JSON.stringify({agent_pubkey:agent, ...body}),
    });
    assert.equal(response.status, 204, 'Gateway rejected the CI admission change');
  };
  // Reconnect to obtain a fresh signed request while keeping the same cell and key.
  await pause('arm');
  await configure('http://127.0.0.1:1').catch(() => {});
  await until(async () => !await authenticated(), 'Guest C did not disconnect', 15000);
  await configure(linker);
  const pending = await until(async () => {
    const delivery = await pause('peek');
    return delivery?.outcome === 'pending' && delivery;
  }, 'No genuine delivery reached the paused installed receiver');
  assert(JSON.parse(pending.frame).envelope.recipient_agent === agent,
    'Pending ciphertext belongs to a different recipient');
  try {
    await authorize('DELETE');
    await until(async () => !await authenticated(), 'Revocation left Guest C authenticated', 15000);
  } finally {
    await pause('release');
  }
  await until(async () => (await pause('peek'))?.outcome === 'rejected',
    'A pending delivery survived server revocation', 15000);
  await authorize('POST', {capabilities:['dht_read', 'dht_write', 'k2', 'game_role_request']});
  await until(authenticated, 'Guest C did not complete fresh signed reauthorization', 15000);
  assert(JSON.parse(pending.frame).envelope.expires_at_ms > Date.now(),
    'Reauthorization missed the live stale-message window');
  await until(async () => await tryCiphertext(profile, pending.frame) === 'uncorrelated',
    'The resumed session did not reject the stale request correlation', 12000);
  await until(async () => {
    const frame = await worker.evaluate(() => globalThis.__imposterRoleCiphertext());
    return frame && frame !== pending.frame && frame !== priorReceipt;
  }, 'Reauthorization did not produce a fresh ciphertext receipt');
  await page.waitForFunction(() => document.querySelector('#my-role')?.textContent
    ?.startsWith('Your verified role:'), null, {timeout:120000});
}

async function verifySignedRoleFaults({host, guest, page, dna, agent, evidence, save}) {
  const hostWorker = await extensionWorker(host);
  const guestWorker = await extensionWorker(guest);
  const agentHex = raw(agent).toString('hex'), dnaHex = raw(dna).toString('hex');
  const fixture = (worker, operation, ...args) => worker.evaluate(({operation, args}) =>
    globalThis.__imposterRoleFixture[operation](...args), {operation, args});
  const receipt = () => guestWorker.evaluate(() => globalThis.__imposterRoleCiphertext());
  const configure = url => page.evaluate(linkerUrl =>
    window.holochain.configureNetwork({linkerUrl}), url);
  const row = async () => (await observe(guest)).find(item => item.installedAgent === agentHex);
  const disconnect = async () => {
    await configure('http://127.0.0.1:1').catch(() => {});
    await until(() => page.evaluate(async () => !(await window.holochain.getConnectionStatus()).authenticated),
      'Fault fixture could not disconnect Guest C', 15000);
  };
  const connect = () => configure(process.env.H2HC_BASE_URL);
  const recover = () => until(async () => {
    const current = await receipt();
    return current && current !== lastGood && (await row())?.receipt && current;
  }, 'Fresh legitimate delivery did not recover after a rejected frame');

  let lastGood = await receipt();
  assert(lastGood, 'Guest C requires a real positive receipt before fault tests');
  evidence.signedRoleFaults = {};
  for (const [kind, reason] of [
    ['merkle', 'malformed-opening'],
    ['expired', 'attestation-expired'],
    ['rollback', 'epoch-disagrees-with-native-enrollment'],
  ]) {
    const status = evidence.signedRoleFaults[kind] = {attempts:[], freshRecovery:false};
    save();
    if (kind === 'rollback') {
      await disconnect();
      assert.equal(await fixture(guestWorker, 'rotate', dnaHex, agentHex), 2);
      await connect();
      lastGood = await recover();
      assert.equal(await fixture(hostWorker, 'trustedEpoch', dnaHex, agentHex), 2,
        'Host did not persist the native epoch-two floor');
      status.nativeTrustedEpoch = 2;
      save();
    }
    const sender = kind === 'merkle' ? hostWorker : guestWorker;
    const target = kind === 'merkle' ? guestWorker : hostWorker;
    for (let attempt = 0; attempt < 2; attempt++) {
      await disconnect();
      await fixture(sender, 'arm', kind, agentHex);
      await connect();
      const message = await until(() => fixture(sender, 'sent'), 'Signed fault frame was not sent');
      assert.equal(message.kind, kind);
      const denied = await until(() => fixture(target, 'denial', message.messageId),
        'Signed frame missed its intended installed-receiver denial');
      status.attempts.push(denied);
      save();
      assert.equal(denied, reason);
      const guestState = await row();
      assert(guestState?.sessionBound && guestState.receipt === null,
        'Guest accepted a private role on the faulted lease');
      assert(await receipt() === lastGood, 'A faulted exchange produced a new private receipt');
    }
    // A new lease sends an unmodified request after each rejection pair.
    await disconnect();
    await connect();
    lastGood = await recover();
    status.freshRecovery = true;
    save();
  }
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
  const [host, guestB] = await until(async () => {
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
    if (!rows.slice(0, 2).every(row => row?.pinnedRoleCommit === commitHex && row.sessionBound
      && row.nativeEnrollmentPublished)) return;
    if (rows[0].gatewayRoleDeliveryQueued < 1 || rows[1].gatewayRoleRequestQueued < 1) return;
    if (!rows[1].receipt) return;
    return rows;
  }, 'Timed out waiting for a gateway enqueue and independent Guest B extension receipt', 180000);
  assert.deepEqual(guestB.receipt, {
    seat:seatB, roleCommit:commitHex,
    recipient:raw(agents[1]).toString('hex'), coordinatorInvoked:false,
  });
  assert.equal(host.decryptedRoleReceipts, 0);
  // The protected opener stays inaccessible even on the Host's authorized page.
  await assert.rejects(() => gameCall(pages[0], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  await assert.rejects(() => gameCall(pages[2], 'host_role_opening', query), /PRIVILEGED_ROLE_OPERATION_DENIED/);
  evidence.gatewayEnqueue = {requests:guestB.gatewayRoleRequestQueued, deliveries:host.gatewayRoleDeliveryQueued};
  evidence.guestBExtensionReceipt = guestB.receipt;
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
  evidence.liveCiphertextDenials = {};
  const deny = async (probe, profile, payload, expected) => {
    const result = await tryCiphertext(profile, payload);
    evidence.liveCiphertextDenials[probe] = result;
    save();
    assert.equal(result, expected);
  };
  await deny('wrongRecipient', profiles[2], frame, 'wrong-recipient-cell');
  // The foreign DNA was built and installed in the first passing run, 44340415458.
  const foreignDNA = 'uhC0k10az8nyUQCFlZlXLVXTut2TsMWqcqIlfZn7Kkd58dQz2NzUI';
  assert.notEqual(dna, foreignDNA);
  const tampered = envelope => JSON.stringify({...delivery, envelope:{...delivery.envelope, ...envelope}});
  await deny('wrongDNA', profiles[1], tampered({dna_hash:foreignDNA}), 'wrong-recipient-cell');
  await deny('wrongRoleCommit', profiles[1], tampered({role_commit:joinB}), 'wrong-commitment');
  const signature = (delivery.signature[0] === 'A' ? 'B' : 'A') + delivery.signature.slice(1);
  await deny('forgedHostSignature', profiles[1], JSON.stringify({...delivery, signature}), 'bad-signature');
  await deny('duplicate', profiles[1], frame, 'uncorrelated');

  const restarted = await restartGuestB();
  profiles[1] = restarted.profile;
  pages[1] = restarted.page;
  assert(delivery.envelope.expires_at_ms > Date.now(), 'Restart missed the live ciphertext replay window');
  await deny('afterRestart', profiles[1], frame, 'uncorrelated');
  assert(await replayRecorded(profiles[1], delivery), 'The exact replay reservation was lost on restart');
  evidence.liveCiphertextReplayDeniedAfterChromiumRestart = true;
  save();

  const guestC = await until(async () => {
    const [, , row] = await metadata();
    if (row?.receipt && row.pinnedRoleCommit === commitHex && row.gatewayRoleRequestQueued > 0)
      return row;
  }, 'Guest C did not independently receive its own role');
  assert.deepEqual(guestC.receipt, {
    seat:seats.guest_c.my_seat, roleCommit:commitHex,
    recipient:raw(agents[2]).toString('hex'), coordinatorInvoked:false,
  });
  evidence.guestCExtensionReceipt = guestC.receipt;
  save();

  for (const page of pages) {
    await page.waitForFunction(() => document.querySelector('#my-role')?.textContent
      ?.startsWith('Your verified role:'), null, {timeout:120000});
    await assert.rejects(() => gameCall(page, 'get_verified_browser_role', {recipient:agents[1]}),
      /PRIVATE_ROLE_ORIGIN_OR_PAYLOAD_DENIED/);
  }
  evidence.ownRoleRenderedInAllThreeBrowsers = true;
  save();

  await verifyRevocation(profiles[2], pages[2], agents[2]);
  evidence.revokedPendingDeliveryAndStaleReauthorizationDenied = true;
  save();
  await verifySignedRoleFaults({
    host:profiles[0], guest:profiles[2], page:pages[2], dna, agent:agents[2], evidence, save,
  });

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
