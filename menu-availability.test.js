"use strict";
// Tests for time-of-day menu category availability (lunch/dinner auto-switch).
const test = require("node:test");
const assert = require("node:assert");
const {
  parseHHMM,
  categoryVisibleAt,
  localMinutesNow,
  filterMenuByTime,
} = require("./menu-availability");

test("parseHHMM parses HH:MM into minutes since midnight", () => {
  assert.strictEqual(parseHHMM("15:00"), 900);
  assert.strictEqual(parseHHMM("08:30"), 510);
  assert.strictEqual(parseHHMM("00:00"), 0);
  assert.strictEqual(parseHHMM("9:05"), 545); // single-digit hour tolerated
});

test("parseHHMM returns null for invalid input", () => {
  assert.strictEqual(parseHHMM("nope"), null);
  assert.strictEqual(parseHHMM("25:00"), null);
  assert.strictEqual(parseHHMM("12:60"), null);
  assert.strictEqual(parseHHMM(""), null);
  assert.strictEqual(parseHHMM(undefined), null);
});

test("a category with no avail window is always visible", () => {
  assert.strictEqual(categoryVisibleAt(undefined, 0), true);
  assert.strictEqual(categoryVisibleAt({}, 720), true);
  assert.strictEqual(categoryVisibleAt(null, 1439), true);
});

test("a 'until 15:00' lunch window is visible before 3pm, hidden at/after 3pm", () => {
  const lunch = { to: "15:00" };
  assert.strictEqual(categoryVisibleAt(lunch, 8 * 60), true);   // 08:00
  assert.strictEqual(categoryVisibleAt(lunch, 14 * 60 + 59), true); // 14:59
  assert.strictEqual(categoryVisibleAt(lunch, 15 * 60), false); // 15:00 sharp -> hidden
  assert.strictEqual(categoryVisibleAt(lunch, 20 * 60), false); // 20:00
});

test("a 'from 15:00' dinner window is hidden before 3pm, visible at/after 3pm", () => {
  const dinner = { from: "15:00" };
  assert.strictEqual(categoryVisibleAt(dinner, 14 * 60 + 59), false); // 14:59
  assert.strictEqual(categoryVisibleAt(dinner, 15 * 60), true);  // 15:00 sharp -> visible
  assert.strictEqual(categoryVisibleAt(dinner, 21 * 60), true);  // 21:00
});

test("the switch is clean at the boundary: exactly one of lunch/dinner is visible at 15:00", () => {
  const lunch = { to: "15:00" };
  const dinner = { from: "15:00" };
  assert.strictEqual(categoryVisibleAt(lunch, 900), false);
  assert.strictEqual(categoryVisibleAt(dinner, 900), true);
});

test("a bounded window {from,to} is visible only inside it", () => {
  const w = { from: "08:00", to: "15:00" };
  assert.strictEqual(categoryVisibleAt(w, 7 * 60), false);
  assert.strictEqual(categoryVisibleAt(w, 9 * 60), true);
  assert.strictEqual(categoryVisibleAt(w, 15 * 60), false);
});

test("an unparseable avail window fails open (stays visible) rather than hiding the menu", () => {
  assert.strictEqual(categoryVisibleAt({ to: "garbage" }, 900), true);
});

test("localMinutesNow reports the wall-clock minute in the given timezone", () => {
  // June in NZ is standard time (UTC+12). 02:00 UTC -> 14:00 NZST -> 840 minutes.
  const d = new Date("2026-06-24T02:00:00Z");
  assert.strictEqual(localMinutesNow("Pacific/Auckland", d), 840);
});

test("localMinutesNow falls back to host local time when the timezone is invalid", () => {
  const d = new Date("2026-06-24T02:00:00Z");
  const got = localMinutesNow("Not/AZone", d);
  assert.ok(Number.isInteger(got) && got >= 0 && got < 1440);
});

function sampleMenu() {
  return {
    version: 1,
    categoryOrder: ["lunch", "mains", "burgers"],
    categories: {
      lunch: { title: "Lunch", avail: { to: "15:00" }, items: [{ id: "a", name: "A", price: 1 }] },
      mains: { title: "Mains", avail: { from: "15:00" }, items: [{ id: "b", name: "B", price: 2 }] },
      burgers: { title: "Burgers", items: [{ id: "c", name: "C", price: 3 }] }, // always
    },
  };
}

test("filterMenuByTime keeps lunch + always-on categories before 3pm", () => {
  const out = filterMenuByTime(sampleMenu(), "Pacific/Auckland", 12 * 60);
  assert.deepStrictEqual(out.categoryOrder, ["lunch", "burgers"]);
  assert.ok(out.categories.lunch);
  assert.ok(out.categories.burgers);
  assert.strictEqual(out.categories.mains, undefined); // dinner dropped from the payload
});

test("filterMenuByTime keeps dinner + always-on categories after 3pm", () => {
  const out = filterMenuByTime(sampleMenu(), "Pacific/Auckland", 16 * 60);
  assert.deepStrictEqual(out.categoryOrder, ["mains", "burgers"]);
  assert.strictEqual(out.categories.lunch, undefined);
  assert.ok(out.categories.mains);
  assert.ok(out.categories.burgers);
});

test("filterMenuByTime leaves a menu with no avail windows untouched (backwards-compatible)", () => {
  const plain = {
    version: 1,
    categoryOrder: ["x", "y"],
    categories: { x: { title: "X", items: [] }, y: { title: "Y", items: [] } },
  };
  const out = filterMenuByTime(plain, "Pacific/Auckland", 16 * 60);
  assert.deepStrictEqual(out.categoryOrder, ["x", "y"]);
  assert.ok(out.categories.x && out.categories.y);
});
