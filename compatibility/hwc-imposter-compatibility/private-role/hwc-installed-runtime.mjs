/** Privileged HWC background ONLY. No public message listener or remote executor.
 * This is instantiated by the pinned HWC source integration patch. A forwarded
 * lease is an untrusted hint: EVERY operation re-probes the real offscreen WS.
 */
import {openRoleStore} from './store.mjs';
import {createInstalledNativeAuthority} from './native-authority.mjs';
import {createRestrictedRoleService} from './trusted-receiver.mjs';
import {publishInstalledRecipientKey} from './installed-native-enrollment.mjs';
import {parseRoleFrame} from './wire.mjs';

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
  const services=new Map(), booting=new Map(), enrolled=new Set();
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
  function sessionFor(cell) {
    let state=null;
    const read=()=>state;
    async function refresh(){
      let result;
      try {
        await sameCell(cell);
        result=await probeSocket();
        const dna=encodeHash(cell.dna),agent=encodeHash(cell.agent);
        if(!result?.isConnected || result.authenticated!==true ||
           typeof result.lease!=='string' || result.lease.length<16 ||
           result.authenticatedAgent!==agent ||
           !Array.isArray(result.registrations) ||
           !result.registrations.some(r=>r?.dna_hash===dna&&r?.agent_pubkey===agent))
          throw Error('offscreen authenticated role session not confirmed');
        if(state && state.lease!==result.lease)
          state=null; // pending correlation cannot be carried across leases
        state={lease:result.lease};
        return result.lease;
      } catch(e) { state=null;throw e; }
    }
    return {
      refresh,
      invalidate(){state=null;},
      leaseId(){return read()?.lease??null;},
      isAuthenticated(){return !!read()?.lease;},
      isRegistered(d,a){return !!read()?.lease&&eq(d,cell.dna)&&eq(a,cell.agent);},
      async sendRoleFrame(frame){
        const lease=await refresh();
        const status=await sendSocket({frame,lease});
        if(status?.success!==true)throw Error('restricted authenticated WS send rejected');
        const after=await refresh();
        if(after!==lease)throw Error('role WS reauthenticated during send');
      }
    };
  }
  async function serviceFor(cell) {
    const k=cellKey(cell);
    let held=services.get(k);
    if(held)return held;
    const store=await storePromise;
    const session=sessionFor(cell);
    const installedCell=()=>sameCell(cell);
    const native=createInstalledNativeAuthority({
      installedCell,
      pinnedLobby:c=>store.getPinnedLobby(c.dna,c.agent),
      pinRoleCommit:(d,a,l,r)=>store.pinTrustedRoleCommit(d,a,l,r),
      readPinnedRoleCommit:(d,a)=>store.getPinnedRoleCommit(d,a),
      trustedFloor:(d,a)=>store.getTrustedFloor(d,a),
      zomeCall:async call=>{
        if(call.zome!=='game' || ![
          'get_authoritative_game_view','host_role_opening',
          'publish_signed_recipient_key_attestation','lookup_recipient_key'
        ].includes(call.fn) || forbidden.includes(call.fn))
          throw Error('unreviewed native coordinator operation refused');
        await sameCell(cell);
        const result=await nativeZomeCall(call);
        await sameCell(cell);
        return result;
      }
    });
    const lair=await getLair();
    const signer=Object.freeze({signByPubKey:async(pub,data)=>{
      await sameCell(cell);
      if(!eq(bytes(pub),cell.agent.slice(3,35)))
        throw Error('different installed Lair signer requested');
      const signed=await lair.signByPubKey(pub,data);
      await sameCell(cell);
      return signed;
    }});
    const service=createRestrictedRoleService({installedCell,store,native,
      lair:signer,session});
    held={cell,store,native,service,session,signer,lease:null};
    services.set(k,held);
    return held;
  }
  async function checked(cell,forwardedLease=null) {
    const held=await serviceFor(cell);
    const lease=await held.session.refresh();
    if(forwardedLease!==null && forwardedLease!==lease)
      throw Error('forwarded role lease is not the active authenticated WS lease');
    if(held.lease && held.lease!==lease) {
      // A new service has no old signed request/reply correlation.
      services.delete(cellKey(cell));
      const next=await serviceFor(cell);
      next.lease=lease;
      await next.session.refresh();
      return next;
    }
    held.lease=lease;
    return held;
  }
  function invalidate() {
    for(const held of services.values())held.session.invalidate();
    services.clear();
    booting.clear();
    enrolled.clear();
  }
  async function bootstrap(cell) {
    const key=cellKey(cell),prior=booting.get(key);
    if(prior)return prior;
    const promise=(async()=>{
      const h=await checked(cell);
      if(!enrolled.has(key)) {
        // Actual installed HWC Lair attestation, native publication and exact
        // signed action lookup. No DHT-only key or webpage attestation accepted.
        await publishInstalledRecipientKey({
          contextId:cell.contextId,dna:cell.dna,
          contextManager,lair:h.signer,store:h.store,native:h.native
        });
        enrolled.add(key);
      }
      const lease=await h.session.refresh();
      const view=await h.native.readCurrentGame(cell);
      if(h.session.leaseId()!==lease)throw Error('bootstrap lease invalidated');
      const host=exactly(view.host,'agent');
      if(!eq(host,cell.agent)) {
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
    try {return await promise;} finally {booting.delete(key);}
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
  /** Invoked ONLY after successful, local installed-cell create_lobby/join_lobby.
   * The record is the actual native zome return, never a webpage argument.
   * Recovery does not overwrite a protected Lobby action on restart.
   */
  async function pinLobbyFromNativeRecord(contextId,fn,record,decodeApp) {
    if(!['create_lobby','join_lobby'].includes(fn))return false;
    const c=await contextManager.getContext(contextId);
    if(!c?.enabled || c.dnas?.length!==1)return false;
    const cell=await installed(c.dnas[0].hash,c.agentPubKey);
    const signed=record?.signed_action?.hashed;
    const author=bytes(signed?.content?.author);
    const ownAction=bytes(signed?.hash);
    if(!action(ownAction) || !eq(author,cell.agent) ||
       (signed.content?.type!=='Create' && !signed.content?.Create))
      throw Error('local native Lobby/Join result lacks signed Create action');
    const app=bytes(record?.entry?.Present?.App);
    if(!app)throw Error('native Create record missing app entry');
    const entry=decodeApp(app); // MessagePack from actual local WASM result
    let lobby;
    if(fn==='create_lobby'){
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
    await store.pinNativeLobby(cell.dna,cell.agent,lobby);
    // Never return an action or private role to a public page response.
    return true;
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
    if(outcome && Number.isInteger(outcome.role) && outcome.coordinatorInvoked===false) {
      const receipt={seat:outcome.seat,roleCommit:hex(outcome.roleCommit),
        dna:hex(cell.dna),recipient:hex(cell.agent),lease:before,
        coordinatorInvoked:false,extensionLocalVerified:true};
      acceptedReceipts.set(cellKey(cell),Object.freeze(receipt));
      onReceipt(Object.freeze({...receipt}));
      return {recipientReceipt:true,coordinatorInvoked:false};
    }
    throw Error('unrecognized role-only frame');
  }
  return Object.freeze({
    pinLobbyFromNativeRecord,receiveSocketFrame,pulse,invalidate,
    // Only metadata: no role, Lair secret, X25519 private key or native executor.
    receiptCount(){return acceptedReceipts.size;}
  });
}
