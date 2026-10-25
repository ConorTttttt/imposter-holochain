// Display-only hotel identities. NEVER change room indices, task IDs or protocol values
// to retheme the game: Holochain and the collision map rely on those stable IDs.
export const HOTEL_PALETTE = {
  ink: "#0e1718",
  emerald: "#12312b",
  burgundy: "#6e2430",
  gold: "#d4a655",
  ivory: "#f3e5c9",
  walnut: "#4b302a",
  ghost: "#9988c5",
  alarm: "#e35f52",
  restored: "#79cfa8",
} as const;

export const HOTEL_ROOMS = [
  "Grand Entrance",
  "Reception & Switchboard",
  "Doorman's Station",
  "Trophy Gallery",
  "Spa & Infirmary",
  "Conservatory",
  "Grand Salon",
  "Boiler & Lift Machinery",
  "Surveillance Office",
  "The Great Furnace",
  "Fuse Room",
  "Kitchen & Service Office",
  "Wine Cellar & Stores",
  "Steam Laundry",
] as const;

const ORIGINAL_ROOMS = [
  "Navigator Bridge", "Communications Array", "Shields Control",
  "Weapons Control", "Medical Bay", "Life Support", "Commons",
  "Core Engine", "Security & Network", "Reactor Core",
  "Electrical Systems", "Cargo Control", "Storage Bay", "Decontamination",
] as const;

const ROOM_NAMES = new Map<string, string>(ORIGINAL_ROOMS.map((name, i) => [name, HOTEL_ROOMS[i]]));
export function hotelRoomName(legacyName: string): string {
  return ROOM_NAMES.get(legacyName) ?? legacyName;
}

export const HOTEL_TASKS = [
  "Balance Boiler Pressure", "Feed the Great Furnace", "Calibrate the Fuse Board",
  "Restore Protective Wards", "Arrange the Arrival Register", "Consult the Mirror of Truth",
  "Align Gallery Spotlights", "Replace Ventilation Filters", "Restore Switchboard Connections",
  "Verify Produce Delivery", "Inspect Pantry Crates", "Confirm Catering Orders",
  "Route Room Service", "Count Cellar Inventory", "Review Security Alerts",
  "Reset Brass Circuit Breakers", "Inspect Laundry Steam Seals", "Update the Guest Ledger",
] as const;

export function hotelTaskName(taskId: number, fallback = `Task ${taskId}`): string {
  return HOTEL_TASKS[taskId] ?? fallback;
}

export type HotelCrisis = "reactor" | "life_support" | "nav_drift";
const HOTEL_CRISES: Record<HotelCrisis, string> = {
  reactor: "Great Furnace Overload",
  life_support: "Ventilation Failure",
  nav_drift: "Reality Instability",
};
export function hotelCrisisName(kind: HotelCrisis): string {
  return HOTEL_CRISES[kind];
}

/** Cosmetic look is stable across clients and independent of role, seat and game state. */
export function guestOutfit(keyB64: string): number {
  let hash = 2166136261;
  for (let i = 0; i < keyB64.length; i++) {
    hash = Math.imul(hash ^ keyB64.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % 6;
}
