import { AdminWebsocket, AppWebsocket, decodeHashFromBase64, encodeHashToBase64 } from "@holochain/client";
import { DatabaseSync } from "node:sqlite";

const appId = "imposter-native-authority";
const readerOrigin = "http://localhost";
const query = "get_authoritative_game_view";

export async function nativeMembership(port: number, database: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  const admission = db.prepare(`SELECT 1 FROM allowed_agents a
    JOIN session_dnas d ON d.agent_pubkey = a.agent_pubkey
    WHERE a.agent_pubkey = ? AND d.dna_hash = ?
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.agent_pubkey = a.agent_pubkey)`);
  const options = { wsClientOptions: { origin: readerOrigin } };
  const admin = await AdminWebsocket.connect({ ...options, url: new URL(`ws://127.0.0.1:${port}`) });
  const cells = await admin.listCellIds();
  if (cells.length !== 1) throw Error("Expected one host-bound authority cell");
  const cell = cells[0];
  const interfaces = await admin.listAppInterfaces();
  const endpoint = interfaces.find(i => i.installed_app_id === appId && i.allowed_origins === readerOrigin)
    ?? await admin.attachAppInterface({ installed_app_id: appId, allowed_origins: readerOrigin, port: 0 });
  const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: appId });
  const app = await AppWebsocket.connect({ ...options, token, url: new URL(`ws://127.0.0.1:${endpoint.port}`) });
  await admin.authorizeSigningCredentials(cell, { type: "listed", value: [["game", query]] });
  await admin.client.close();
  const installedDna = encodeHashToBase64(cell[0]);
  return {
    admitted(dna: string, agent: string) {
      return dna === installedDna && Boolean(admission.get(agent, dna));
    },
    async seated(lobby: string, agent: string) {
      const view = await app.callZome({ cell_id: cell, zome_name: "game", fn_name: query,
        payload: { expected_lobby: decodeHashFromBase64(lobby), expected_role_commit: null,
          expected_recipient: null, expected_seat: null } }) as {
          dna: Uint8Array; lobby_action: Uint8Array; phase: string; seats: { agent: Uint8Array }[];
        };
      return encodeHashToBase64(view.dna) === installedDna && encodeHashToBase64(view.lobby_action) === lobby &&
        ["lobby", "playing", "meeting"].includes(view.phase) && view.seats.some(s => encodeHashToBase64(s.agent) === agent);
    },
  };
}
