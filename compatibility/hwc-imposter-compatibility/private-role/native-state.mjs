/** Agent 4's *real* game::get_authoritative_game_view v1 response.
 * The caller MUST be the installed-cell-only zome executor, with exact
 * expected_lobby + expected_role_commit pinned from prior native actions.
 * Agent 4's zome internally requires native Valid typed records and joins,
 * rejects conflicts and wrong authors. An arbitrary page/get_game_state JSON
 * or a Boolean nativeValidated flag is never sufficient.
 *
 * This function checks byte-level response consistency independently; it
 * does NOT confer native authority by itself or assert global DHT finality.
 */
const asBytes=x=>x instanceof Uint8Array?x:Array.isArray(x)?Uint8Array.from(x):null;
const equal=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const hash=(x,kind)=>{const v=asBytes(x),p={dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]}[kind];if(!v||v.length!==39||!p.every((b,i)=>v[i]===b))throw Error('invalid native '+kind+' hash');return v;};
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const less=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]<b[i];}return false;};
export function requireCurrentRoleState(view,cell){
 if(view?.schema_version!==1||view.observed_only!==true||
    !equal(hash(view.dna,'dna'),hash(cell.dna,'dna'))||
    !['playing','meeting'].includes(view.phase))
   throw Error('missing installed-cell native current committed phase');
 if(typeof view.network_seed!=='string'||!view.network_seed||
    !view.lobby||!Array.isArray(view.seats))
   throw Error('native authoritative game view missing');
 const lobbyAction=hash(view.lobby_action,'action');
 const commitAction=hash(view.role_commit_action,'action');
 const host=hash(view.host,'agent');
 const root=asBytes(view.merkle_root),e=view.lobby;
 if(!root||root.length!==32||
    typeof e.code!=='string'||!e.code||
    !int(e.player_count,1,64)||!int(e.impostor_count,1,e.player_count)||
    !int(e.task_target,0,4294967295)||
    view.seats.length!==e.player_count)
   throw Error('native RoleCommit Merkle root or Lobby configuration mismatch');
 const seats=view.seats.map((row,i)=>{
   if(!row||row.seat!==i||typeof row.display_name!=='string'||
      !row.display_name||!asBytes(row.join_action))
     throw Error('noncanonical native seat or missing signed PlayerJoin');
   return hash(row.agent,'agent');
 });
 const joins=view.seats.map(row=>hash(row.join_action,'action'));
 if(!seats.some(a=>equal(a,host))||
    seats.some((a,i)=>i>0&&!less(seats[i-1],a))||
    joins.some((a,i)=>joins.some((b,j)=>i!==j&&equal(a,b))))
   throw Error('noncanonical native seats, joins or host');
 // Agent 4's native extern independently verifies commit author==host,
 // Lobby hash, RoleCommit.seats, PlayerJoin author/action, native Valid and
 // observed-only freshness. We require that exact origin, not a trust flag.
 return {lobby:{action:lobbyAction,author:host,host},
   commit:{action:commitAction,author:host,lobby:lobbyAction,
     seats,joins,merkleRoot:root}};
}
