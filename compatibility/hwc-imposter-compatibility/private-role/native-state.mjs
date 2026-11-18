/** Validate the *existing* native Lobby and RoleCommit entry contracts.
 * The privileged reader must return current, native Valid typed Create
 * records with original action hashes/authors, plus phase/roles_dealt from
 * get_game_state. No arbitrary DHT JSON or page-supplied Boolean is authority.
 * This file NEVER constructs a default round, host, seat or Merkle root.
 *
 * Required installed-cell-only readCurrentGame response:
 * {dna, phase, roles_dealt, lobby:{action,author,entry:Lobby},
 *  roleCommit:{action,author,entry:RoleCommit}}
 *
 * Current selection, native-validity/integration, and no conflicting records
 * must be established by the native reader BEFORE returning this object.
 * Existing Agent 4 get_game_state is NOT that reader yet.
 */
const asBytes=x=>x instanceof Uint8Array?x:Array.isArray(x)?Uint8Array.from(x):null;
const equal=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const hash=(x,kind)=>{const v=asBytes(x),p={dna:[0x84,0x2d,0x24],agent:[0x84,0x20,0x24],action:[0x84,0x29,0x24]}[kind];if(!v||v.length!==39||!p.every((b,i)=>v[i]===b))throw Error('invalid native '+kind+' hash');return v};
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const less=(a,b)=>{for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]<b[i]}return false;};
export function requireCurrentRoleState(state,cell){
 if(!state||!equal(hash(state.dna,'dna'),hash(cell.dna,'dna'))||
    !['playing','meeting'].includes(state.phase)||state.roles_dealt!==true)
   throw Error('native game not in an active committed phase');
 const l=state.lobby,r=state.roleCommit;
 if(!l?.entry||!r?.entry)throw Error('native typed Lobby and RoleCommit records required');
 const lobby={action:hash(l.action,'action'),author:hash(l.author,'agent'),entry:l.entry};
 const commit={action:hash(r.action,'action'),author:hash(r.author,'agent'),entry:r.entry};
 const e=l.entry,c=r.entry;
 if(typeof e.code!=='string'||e.code.length===0||!int(e.player_count,1,64)||
    !int(e.impostor_count,1,e.player_count)||!int(e.task_target,0,4294967295)||
    !int(c.player_count,1,64)||!int(c.impostor_count,1,c.player_count)||
    e.player_count!==c.player_count||e.impostor_count!==c.impostor_count||
    !equal(hash(c.lobby,'action'),lobby.action)||
    !equal(commit.author,lobby.author)||
    !Array.isArray(c.seats)||!Array.isArray(c.joins)||
    c.seats.length!==c.player_count||c.joins.length!==c.player_count||
    !asBytes(c.merkle_root)||asBytes(c.merkle_root).length!==32)
   throw Error('native Lobby / RoleCommit identity or entry mismatch');
 const seats=c.seats.map(a=>hash(a,'agent'));
 const joins=c.joins.map(a=>hash(a,'action'));
 if(seats.some((a,i)=>i>0&&!less(seats[i-1],a))||
    joins.some((a,i)=>joins.some((b,j)=>i!==j&&equal(a,b))))
   throw Error('noncanonical seats or duplicate PlayerJoin action');
 // Checked, immutable projection sourced ONLY from the native typed entries.
 return {lobby:{action:lobby.action,author:lobby.author,host:lobby.author},
   commit:{action:commit.action,author:commit.author,lobby:hash(c.lobby,'action'),
     seats,joins,merkleRoot:asBytes(c.merkle_root)}};
}
