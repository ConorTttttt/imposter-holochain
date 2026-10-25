// Player colors. The coordinator hands out an index by join order
// (`PlayerView.color`), so everyone sees the same color for the same player.

export const PLAYER_COLORS: { name: string; hex: string }[] = [
  { name: "Red", hex: "#e5484d" },
  { name: "Blue", hex: "#3e63dd" },
  { name: "Green", hex: "#30a46c" },
  { name: "Yellow", hex: "#f5d90a" },
  { name: "Orange", hex: "#f76b15" },
  { name: "Pink", hex: "#e93d82" },
  { name: "Cyan", hex: "#05a2c2" },
  { name: "Purple", hex: "#8e4ec6" },
  { name: "Lime", hex: "#99d52a" },
  { name: "Brown", hex: "#ad7f58" },
  { name: "White", hex: "#eceef0" },
  { name: "Tan", hex: "#d6b58c" },
];

export function colorHex(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length].hex;
}
