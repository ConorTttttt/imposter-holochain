/** Privileged HWC background ONLY. No public message listener or remote executor.
 * This is instantiated by the pinned HWC source integration patch. A forwarded
 * lease is an untrusted hint: EVERY operation re-probes the real offscreen WS.
 */
import {openRoleStore} from './store.mjs';
import {createInstalledNativeAuthority} from './native-authority.mjs';
import {createRestrictedRoleService} from './trusted-receiver.mjs';
import {publishInstalledRecipientKey} from './installed-native-enrollment.mjs';
import {parseRoleFrame} from './wire.mjs';
import {encodeRoleOpening,verifyRoleOpening} from './merkle.mjs';
import {requireCurrentRoleState} from './native-state.mjs';

const bytes = v => {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every(x => Number.isInteger(x) && x >= 0 && x < 256))
    return Uint8Array.from(v);
  if (v && typeof v === 'object') {
    const keys=Object.keys(v);
    if (keys.length && keys.every((k,i)=>k===String(i)))
      return bytes(keys.map(k=>v[k]));
  }
  return null;
};
const eq=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&
  a.length===b.length&&a.every((x,i)=>x===b[i]);
const action=b=>b instanceof Uint8Array && b.length===39 &&
  b[0]===0x84&&b[1]===0x29&&b[2]===0x24;
const hex=b=>Array.from(b,v=>v.toString(16).padStart(2,'0')).join('');
const forbidden=['deal_roles','recv_remote_signal','send_remote_signal','call_remote'];

export function createInstalledHwcRoleRuntime({
  contextManager, getLair, nativeZomeCall, probeSocket, sendSocket,
  encodeHash, canonicalHash, onReceipt=()=>{}
}) {
  if (!contextManager?.listContexts || !contextManager?.getContext ||
      typeof getLair!=='function' || typeof nativeZomeCall!=='function' ||
      typeof probeSocket!=='function' || typeof sendSocket!=='function' ||
      typeof encodeHash!=='function' || typeof canonicalHash!=='function')
    throw Error('HWC background-only role dependencies missing');
  const storePromise=openRoleStore();
  const services=new Map(), booting=new Map();
  const acceptedReceipts=new Map();
  const exactly=(v,type)=> {
    const b=bytes(v);
    if(!b || b.length!==39 || !eq(canonicalHash(b,type),b))
      throw Error('noncanonical installed HoloHash');
    return b;
  };
  const cellKey=c=>c.contextId+':'+hex(c.dna)+':'+hex(c.agent);

  async function installed(dna,agent) {
    const d=exactly(dna,'dna'),a=exactly(agent,'agent');
    const contexts=await contextManager.listContexts();
    const matches=contexts.filter(c=>c.enabled===true &&
      c.dnas?.length===1 && eq(bytes(c.agentPubKey),a) &&
      eq(bytes(c.dnas[0]?.hash),d));
    if(matches.length!==1)throw Error('no unique enabled installed HWC game cell');
    const c=await contextManager.getContext(matches[0].id);
    if(!c?.enabled || !eq(bytes(c.agentPubKey),a) ||
       c.dnas?.length!==1 || !eq(bytes(c.dnas[0].hash),d))
      throw Error('installed HWC game cell disabled or replaced');
    const lair=await getLair();
    // Context metadata is not proof that the signer remains in Lair.
    const entry=await lair.getEntry(c.agentKeyTag);
    if(!eq(bytes(entry?.ed25519_pub_key),a.slice(3,35)))
      throw Error('installed context Lair seed is absent or substituted');
    return {contextId:c.id,dna:d,agent:a,enabled:true};
  }
  async function sameCell(cell) {
    const live=await installed(cell.dna,cell.agent);
    if(live.contextId!==cell.contextId)throw Error('installed cell changed');
    return live;
  }
  async function probeLease(cell) {
    await sameCell(cell);
    const result=await probeSocket();
    const dna=encodeHash(cell.dna),agent=encodeHash(cell.agent);
    if(!result?.isConnected || result.authenticated!==true ||
       typeof result.lease!=='string' || result.lease.length<16 ||
       result.authenticatedAgent!==agent ||
       !Array.isArray(result.registrations) ||
       !result.registrations.some(r=>r?.dna_hash===dna&&r?.agent_pubkey===agent))
      throw Error('offscreen authenticated role session not confirmed');
    return result.lease;
  }
  function sessionFor(cell,store,lobby,lease) {
    let active=true;
    async function refresh(){
      try {
        if(!active || await probeLease(cell)!==lease ||
           !eq(await store.getPinnedLobby(cell.dna,cell.agent),lobby) || !active)
          throw Error('role WebSocket lease or selected lobby changed');
        return lease;
      } catch(e) { active=false;throw e; }
    }
    return {
      refresh,
      invalidate(){active=false;},
      leaseId(){return active?lease:null;},
      isAuthenticated(){return active;},
      isRegistered(d,a){return active&&eq(d,cell.dna)&&eq(a,cell.agent);},
      async sendRoleFrame(frame){
        await refresh();
        const status=await sendSocket({frame,lease});
        if(status?.success!==true)throw Error('restricted authenticated WS send rejected');
        await refresh();
      }
    };
  }
  function serviceFor(cell,store,lobby,lease) {
    const session=sessionFor(cell,store,lobby,lease);
    const installedCell=()=>sameCell(cell);
    const native=createInstalledNativeAuthority({
      installedCell,
      pinnedLobby:async c=>{
        const selected=await store.getPinnedLobby(c.dna,c.agent);
        if(!eq(selected,lobby))throw Error('selected lobby changed');
        return lobby;
      },
      pinRoleCommit:(d,a,l,r)=>store.pinTrustedRoleCommit(d,a,l,r),
      readPinnedRoleCommit:(d,a,l)=>store.getPinnedRoleCommit(d,a,l),
      trustedFloor:(d,a)=>store.getTrustedFloor(d,a),
      zomeCall:async call=>{
        if(call.zome!=='game' || ![
          'get_authoritative_game_view','host_role_opening',
          'publish_signed_recipient_key_attestation','lookup_recipient_key','commit_roles_only'
        ].includes(call.fn) || forbidden.includes(call.fn))
          throw Error('unreviewed native coordinator operation refused');
        await sameCell(cell);
        const result=await nativeZomeCall(call);
        await sameCell(cell);
        return result;
      }
    });
    const signer=Object.freeze({signByPubKey:async(pub,data)=>{
      await sameCell(cell);
      if(!eq(bytes(pub),cell.agent.slice(3,35)))
        throw Error('different installed Lair signer requested');
      const signed=await (await getLair()).signByPubKey(pub,data);
      await sameCell(cell);
      return signed;
    }});
    const service=createRestrictedRoleService({installedCell,store,native,
      lair:signer,session});
    return {cell,store,lobby,native,service,session,signer,enrolledUntil:0};
  }
  async function checked(cell,forwardedLease=null) {
    const store=await storePromise;
    const lease=await probeLease(cell);
    if(forwardedLease!==null && forwardedLease!==lease)
      throw Error('forwarded role lease is not the active authenticated WS lease');
    const lobby=await store.getPinnedLobby(cell.dna,cell.agent);
    if(!lobby)throw Error('no selected native lobby');
    const key=cellKey(cell);
    const previous=services.get(key);
    if(previous?.session.leaseId()===lease && eq(previous.lobby,lobby))return previous;
    // In-flight work cannot carry requests or receipts to another socket or lobby.
    previous?.session.invalidate();
    acceptedReceipts.delete(key);
    const held=serviceFor(cell,store,lobby,lease);
    services.set(key,held);
    return held;
  }
  function invalidate() {
    for(const held of services.values())held.session.invalidate();
    services.clear();
    booting.clear();
    acceptedReceipts.clear();
  }
  async function bootstrap(cell) {
    const key=cellKey(cell),prior=booting.get(key);
    if(prior)return prior;
    const promise=(async()=>{
      const h=await checked(cell);
      const view=await h.native.readCurrentGame(cell);
      if(h.enrolledUntil<=Date.now()+15000) {
        // Actual installed HWC Lair attestation, native publication and exact
        // signed action lookup. No DHT-only key or webpage attestation accepted.
        const enrollment=await publishInstalledRecipientKey({
          contextId:cell.contextId,dna:cell.dna,
          contextManager,lair:h.signer,store:h.store,native:h.native
        });
        await h.session.refresh();
        h.enrolledUntil=enrollment.expiresAt;
      }
      await h.session.refresh();
      const host=exactly(view.host,'agent');
      if(!eq(host,cell.agent) && !acceptedReceipts.has(key)) {
        const seat=view.seats.find(x=>eq(bytes(x.agent),cell.agent))?.seat;
        if(!Number.isInteger(seat))throw Error('installed agent has no committed seat');
        try { await h.service.requestRole({seat}); }
        catch(e) {
          if(!/outstanding signed recipient request exists/.test(String(e)))throw e;
        }
      }
      return {bound:true,host:eq(host,cell.agent)};
    })();
    booting.set(key,promise);
    try {return await promise;} finally {
      if(booting.get(key)===promise)booting.delete(key);
    }
  }
  async function pulse() {
    const contexts=await contextManager.listContexts();
    for(const c of contexts) {
      if(!c.enabled || c.dnas?.length!==1)continue;
      try {
        const cell=await installed(c.dnas[0].hash,c.agentPubKey);
        const store=await storePromise;
        if(!await store.getPinnedLobby(cell.dna,cell.agent))continue;
        await bootstrap(cell);
      } catch { /* absent lobby, pending DHT convergence, locked signer: no bypass */ }
    }
  }
  /** Only an actual result of an installed-cell operation can select a lobby. */
  async function pinLobbyFromNativeRecord(contextId,fn,record,decodeApp) {
    const createsLobby=['create_lobby','create_browser_lobby','new_browser_game'].includes(fn);
    const browser=['create_browser_lobby','new_browser_game','join_browser_lobby','reopen_browser_lobby'].includes(fn);
    if(!createsLobby && fn!=='join_lobby' && !browser)return false;
    const c=await contextManager.getContext(contextId);
    if(!c?.enabled || c.dnas?.length!==1)return false;
    const cell=await installed(c.dnas[0].hash,c.agentPubKey);
    const signed=record?.signed_action?.hashed;
    const author=bytes(signed?.content?.header?.author);
    const ownAction=bytes(signed?.hash);
    if(!action(ownAction) || !eq(author,cell.agent) ||
       signed.content?.data?.type!=='Create')
      throw Error('local native Lobby/Join result lacks signed Create action');
    const entryValue=record?.entry?.Present;
    const app=entryValue?.entry_type==='App' && bytes(entryValue.entry);
    if(!app)throw Error('native Create record missing app entry');
    const entry=decodeApp(app); // MessagePack from actual local WASM result
    let lobby;
    if(createsLobby){
      if(!entry || typeof entry.code!=='string' ||
         !Number.isInteger(entry.player_count) ||
         !Number.isInteger(entry.impostor_count))
        throw Error('native Lobby record invalid');
      lobby=ownAction;
    } else {
      if(!eq(bytes(entry?.player),cell.agent) ||
         typeof entry?.display_name!=='string')
        throw Error('native PlayerJoin identity invalid');
      lobby=bytes(entry.lobby);
    }
    lobby=exactly(lobby,'action');
    const store=await storePromise;
    await store.pinNativeLobby(cell.dna,cell.agent,lobby,{browser});
    const key=cellKey(cell),held=services.get(key);
    if(held && !eq(held.lobby,await store.getPinnedLobby(cell.dna,cell.agent))){
      held.session.invalidate();
      if(services.get(key)===held){
        services.delete(key);
        booting.delete(key);
        acceptedReceipts.delete(key);
      }
    }
    return true;
  }
  async function selectedBrowserLobby(contextId) {
    const c=await contextManager.getContext(contextId);
    if(!c?.enabled || c.dnas?.length!==1)return null;
    const cell=await installed(c.dnas[0].hash,c.agentPubKey);
    if(cell.contextId!==contextId)throw Error('lobby read requires the installed context');
    return (await storePromise).getSelectedBrowserLobby(cell.dna,cell.agent);
  }
  async function receiveSocketFrame(json,forwardedLease) {
    if(typeof json!=='string'||typeof forwardedLease!=='string')
      throw Error('restricted WS payload missing');
    const packet=parseRoleFrame(json);
    const cell=await installed(packet.dna,packet.recipient);
    const h=await checked(cell,forwardedLease);
    const before=h.session.leaseId();
    const outcome=await h.service.receiveFromSocket(json);
    const after=await h.session.refresh();
    if(after!==before)throw Error('WS changed before role receipt');
    if(outcome?.validatedRecipientRequest) {
      // Host has authenticated and independently verified the guest's native
      // enrollment. Only NOW may its private local opening be encrypted.
      await h.service.sendRole({seat:packet.seat});
      return {requestVerified:true,queuedOnly:true};
    }
    if(outcome && [0,1].includes(outcome.role) && outcome.coordinatorInvoked===false) {
      if(services.get(cellKey(cell))!==h)throw Error('selected lobby changed before role receipt');
      const receipt={seat:outcome.seat,roleCommit:hex(outcome.roleCommit),
        dna:hex(cell.dna),recipient:hex(cell.agent),lease:before,
        coordinatorInvoked:false,extensionLocalVerified:true};
      acceptedReceipts.set(cellKey(cell),Object.freeze({...receipt,role:outcome.role}));
      onReceipt(Object.freeze({...receipt}));
      return {recipientReceipt:true,coordinatorInvoked:false};
    }
    throw Error('unrecognized role-only frame');
  }
  async function readOwnRole(contextId,expectedLobby=null) {
    const context=await contextManager.getContext(contextId);
    if(!context?.enabled || context.dnas?.length!==1)return null;
    const cell=await installed(context.dnas[0].hash,context.agentPubKey);
    if(cell.contextId!==contextId)throw Error('role read requires the installed context');
    const held=await checked(cell);
    if(expectedLobby!==null && !eq(held.lobby,exactly(expectedLobby,'action')))return null;
    const game=requireCurrentRoleState(await held.native.readCurrentGame(cell),cell);
    const seat=game.commit.seats.findIndex(agent=>eq(agent,cell.agent));
    if(seat<0)return null;
    let role;
    if(eq(cell.agent,game.lobby.host)) {
      const opening=await held.native.readHostRoleOpening(cell,{
        expected_lobby:game.lobby.action,expected_role_commit:game.commit.action,
        expected_recipient:cell.agent,expected_seat:seat,
      });
      role=await verifyRoleOpening({seat,root:game.commit.merkleRoot,
        payload:encodeRoleOpening(opening.role,opening.proof.role_salt,opening.proof.path)});
    } else {
      const receipt=acceptedReceipts.get(cellKey(cell));
      if(receipt?.lease!==held.session.leaseId() || receipt?.seat!==seat ||
         receipt.roleCommit!==hex(game.commit.action))return null;
      role=receipt.role;
    }
    await held.session.refresh();
    return role;
  }
  return Object.freeze({
    pinLobbyFromNativeRecord,receiveSocketFrame,pulse,invalidate,readOwnRole,selectedBrowserLobby,
    // Only metadata: no role, Lair secret, X25519 private key or native executor.
    receiptCount(){return acceptedReceipts.size;},
    // CI may inspect this through its OWN service-worker debugger only.
    // Never publish a messaging listener for this metadata or any role.
    async evidenceMetadata(){
      const out=[];
      for(const h of services.values()){
        const lobby=await h.store.getPinnedLobby(h.cell.dna,h.cell.agent);
        const commit=await h.store.getPinnedRoleCommit(h.cell.dna,h.cell.agent);
        const gateway=await probeSocket().catch(()=>null);
        const receipt=acceptedReceipts.get(cellKey(h.cell));
        out.push({contextId:h.cell.contextId,installedDna:hex(h.cell.dna),
          installedAgent:hex(h.cell.agent),pinnedLobby:lobby?hex(lobby):null,
          pinnedRoleCommit:commit?hex(commit):null,
          nativeEnrollmentPublished:h.enrolledUntil>Date.now(),
          sessionBound:!!h.session.leaseId(),
          gatewayRoleRequestQueued:gateway?.queuedAcks?.requests??0,
          gatewayRoleDeliveryQueued:gateway?.queuedAcks?.deliveries??0,
          decryptedRoleReceipts:receipt?1:0,
          receipt:receipt?{seat:receipt.seat,roleCommit:receipt.roleCommit,
            recipient:receipt.recipient,coordinatorInvoked:receipt.coordinatorInvoked}:null});
      }
      return out;
    }
  });
}
