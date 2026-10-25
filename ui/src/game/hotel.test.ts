import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOMS, TASKS, VENTS } from "./world.js";
import {
  guestOutfit, HOTEL_ROOMS, HOTEL_TASKS, hotelRoomName, hotelTaskName, hotelCrisisName,
} from "./hotel.js";

test("every gameplay room has a hotel-facing name while indices stay unchanged", () => {
  assert.equal(ROOMS.length, HOTEL_ROOMS.length);
  ROOMS.forEach((room, id) => {
    assert.equal(hotelRoomName(room.name), HOTEL_ROOMS[id]);
  });
  assert.equal(ROOMS[6].name, "Commons"); // protocol/world name deliberately untouched
  assert.equal(hotelRoomName("Unmapped Room"), "Unmapped Room");
});

test("tasks retain stable numeric IDs and hotel labels", () => {
  assert.equal(TASKS.length, HOTEL_TASKS.length);
  TASKS.forEach((task, id) => {
    assert.equal(task.id, id);
    assert.equal(hotelTaskName(task.id), HOTEL_TASKS[id]);
  });
  assert.equal(TASKS[5].scan, true, "Mirror of Truth must keep role-proof scan");
  assert.equal(hotelTaskName(999, "Unknown"), "Unknown");
});

test("secret service-passages still lead only to rooms in the hotel map", () => {
  const rooms = new Set(ROOMS.map((r) => r.name));
  for (const vent of VENTS) {
    assert.ok(rooms.has(vent.room));
    assert.ok(HOTEL_ROOMS.includes(hotelRoomName(vent.room) as (typeof HOTEL_ROOMS)[number]));
    for (const link of vent.links) assert.ok(VENTS.some((v) => v.id === link));
  }
});

test("costume selection is deterministic and unrelated to secret role", () => {
  for (const key of ["uhCAkGuestOne", "uhCAkGuestTwo", "uhCAkGuestThree"]) {
    assert.equal(guestOutfit(key), guestOutfit(key));
    assert.ok(guestOutfit(key) >= 0 && guestOutfit(key) < 6);
  }
});

test("the three on-chain crisis kinds map to hotel emergencies", () => {
  assert.equal(hotelCrisisName("reactor"), "Great Furnace Overload");
  assert.equal(hotelCrisisName("life_support"), "Ventilation Failure");
  assert.equal(hotelCrisisName("nav_drift"), "Reality Instability");
});
