"use strict";
// Tests for the breakfast meal-deal engine: a time-gated, auto-applied promo
// where ordering a qualifying food item unlocks one eligible drink for a fixed
// price ($1). Pure + server-authoritative (prices from the menu, never the line).
const test = require("node:test");
const assert = require("node:assert");
const { mealDealActive, computeMealDeal, normalizeMealDeal } = require("./mealdeal");

function menu() {
  return {
    categoryOrder: ["all-day", "mains", "burgers", "coffee", "tea", "signature", "sides"],
    categories: {
      "all-day": {
        title: "Breakfast",
        items: [
          { id: "eggs-benedict", name: "Eggs Benedict", sizes: { Bacon: 24, Salmon: 28 } },
          { id: "crispy-breakfast", name: "Crispy Breakfast", price: 30.9 },
        ],
      },
      mains: { title: "Mains", items: [{ id: "chicken-pasta", name: "Chicken Pasta", price: 27.9 }] },
      burgers: {
        title: "Burgers",
        items: [
          { id: "chicken-burger", name: "Chicken Burger", price: 26.9 },
          { id: "borsht", name: "Borsht", price: 17.9 },
        ],
      },
      coffee: {
        title: "Coffee",
        items: [
          { id: "latte", name: "Latte", sizes: { S: 6, M: 7, L: 8 } },
          { id: "long-black", name: "Long Black", price: 6 },
        ],
      },
      tea: {
        title: "Tea & shakes",
        items: [
          { id: "milkshake", name: "Milkshake", price: 10 },
          { id: "tea-pot", name: "Tea Pot", price: 7 },
          { id: "dollar-water", name: "Dollar Water", price: 1 }, // <= drinkPrice, never eligible
        ],
      },
      signature: { title: "Signature", items: [{ id: "rosy-coffee", name: "Rosy Coffee", price: 9.5 }] },
      sides: { title: "Sides", items: [{ id: "side-egg", name: "Side Egg", price: 3 }] },
    },
  };
}

// A valid deal config, overridable per test.
function deal(over) {
  return Object.assign(
    {
      enabled: true,
      label: "Breakfast deal · drink for $1",
      window: { from: "00:00", to: "11:00" },
      qualifyCategories: ["all-day", "mains", "burgers"],
      drinkCategories: ["coffee", "tea"],
      drinkPrice: 1,
    },
    over || {}
  );
}

const BEFORE = { nowMinOverride: 9 * 60 };  // 09:00 — inside the window
const AFTER = { nowMinOverride: 12 * 60 };  // 12:00 — outside the window

/* ── mealDealActive ────────────────────────────────────────────── */

test("mealDealActive: enabled deal inside the window is active", () => {
  assert.strictEqual(mealDealActive(deal(), { nowMinOverride: 10 * 60 }), true);
  assert.strictEqual(mealDealActive(deal(), { nowMinOverride: 0 }), true);
});

test("mealDealActive: at/after the cutoff it is inactive", () => {
  assert.strictEqual(mealDealActive(deal(), { nowMinOverride: 11 * 60 }), false); // 11:00 sharp
  assert.strictEqual(mealDealActive(deal(), { nowMinOverride: 14 * 60 }), false);
});

test("mealDealActive: disabled / missing config is never active", () => {
  assert.strictEqual(mealDealActive(deal({ enabled: false }), BEFORE), false);
  assert.strictEqual(mealDealActive(null, BEFORE), false);
  assert.strictEqual(mealDealActive(undefined, BEFORE), false);
});

/* ── computeMealDeal: core ─────────────────────────────────────── */

test("a qualifying meal + a drink reprices that drink to $1", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "latte", size: "M", qty: 1 }];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.ok(d);
  assert.strictEqual(d.amount, -6); // 7 -> 1
  assert.strictEqual(d.mealDeal, true);
  assert.ok(typeof d.label === "string" && d.label.length > 0);
});

test("a sized breakfast item (eggs benedict) also qualifies", () => {
  const items = [{ id: "eggs-benedict", size: "Salmon", qty: 1 }, { id: "latte", size: "M", qty: 1 }];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -6);
});

test("outside the window: no deal", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "latte", size: "M", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), AFTER), null);
});

test("qualifying meal but no eligible drink in cart: no deal", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), BEFORE), null);
});

test("a drink but no qualifying meal: no deal", () => {
  const items = [{ id: "latte", size: "M", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), BEFORE), null);
});

test("the discount uses the AUTHORITATIVE menu price, not the line's claim", () => {
  const items = [
    { id: "crispy-breakfast", price: 1, qty: 1 },
    { id: "latte", size: "M", price: 99, qty: 1 },
  ];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -6); // 7 (menu) -> 1, the claimed 99 is ignored
});

test("the chosen drink's size is honoured (a Large latte reprices from its size price)", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "latte", size: "L", qty: 1 }];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -7); // 8 -> 1
});

/* ── computeMealDeal: scaling + selection ──────────────────────── */

test("one $1 drink per qualifying meal; the priciest eligible units win", () => {
  // 2 meals, 3 drink units priced [8, 7, 7] -> top two (8, 7) repriced to $1.
  const items = [
    { id: "crispy-breakfast", qty: 2 },
    { id: "latte", size: "L", qty: 1 }, // 8
    { id: "latte", size: "M", qty: 2 }, // 7, 7
  ];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -13); // (8-1) + (7-1)
  assert.match(d.label, /2/); // label reflects the count
});

test("across drink categories the single priciest unit is chosen first", () => {
  const items = [
    { id: "crispy-breakfast", qty: 1 },
    { id: "milkshake", qty: 1 }, // 10
    { id: "tea-pot", qty: 1 }, // 7
  ];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -9); // milkshake 10 -> 1
});

/* ── computeMealDeal: exclusions + guards ──────────────────────── */

test("drinks outside the eligible categories (e.g. signature) do not qualify", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "rosy-coffee", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), BEFORE), null);
});

test("food outside the qualifying categories (e.g. a side) is not a meal", () => {
  const items = [{ id: "side-egg", qty: 1 }, { id: "latte", size: "M", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), BEFORE), null);
});

test("a drink already at/below the deal price is never selected", () => {
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "dollar-water", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal(), items, menu(), BEFORE), null);
});

test("with a mix, only the drink priced above the deal price is repriced", () => {
  const items = [
    { id: "crispy-breakfast", qty: 1 },
    { id: "dollar-water", qty: 1 }, // 1, ineligible
    { id: "tea-pot", qty: 1 }, // 7
  ];
  const d = computeMealDeal(deal(), items, menu(), BEFORE);
  assert.strictEqual(d.amount, -6); // tea-pot 7 -> 1
});

test("empty cart / disabled deal: no deal", () => {
  assert.strictEqual(computeMealDeal(deal(), [], menu(), BEFORE), null);
  const items = [{ id: "crispy-breakfast", qty: 1 }, { id: "latte", size: "M", qty: 1 }];
  assert.strictEqual(computeMealDeal(deal({ enabled: false }), items, menu(), BEFORE), null);
});

/* ── normalizeMealDeal validation ──────────────────────────────── */

test("normalizeMealDeal cleans a valid config: coerces enabled, trims label", () => {
  const out = normalizeMealDeal(
    { enabled: 1, label: "  Morning deal  ", window: { from: "00:00", to: "11:00" }, qualifyCategories: ["all-day"], drinkCategories: ["coffee"], drinkPrice: 1 },
    menu()
  );
  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.label, "Morning deal");
  assert.strictEqual(out.drinkPrice, 1);
  assert.deepStrictEqual(out.qualifyCategories, ["all-day"]);
  assert.deepStrictEqual(out.drinkCategories, ["coffee"]);
});

test("normalizeMealDeal defaults a blank label to a non-empty string", () => {
  const out = normalizeMealDeal(
    { enabled: true, label: "", window: { to: "11:00" }, qualifyCategories: ["all-day"], drinkCategories: ["coffee"], drinkPrice: 1 },
    menu()
  );
  assert.ok(typeof out.label === "string" && out.label.length > 0);
});

test("normalizeMealDeal rejects an invalid cutoff time", () => {
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "25:00" }, qualifyCategories: ["all-day"], drinkCategories: ["coffee"], drinkPrice: 1 },
    menu()
  ), /time|window/i);
});

test("normalizeMealDeal rejects unknown qualifying / drink categories", () => {
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "11:00" }, qualifyCategories: ["nope"], drinkCategories: ["coffee"], drinkPrice: 1 },
    menu()
  ), /categor/i);
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "11:00" }, qualifyCategories: ["all-day"], drinkCategories: ["nope"], drinkPrice: 1 },
    menu()
  ), /categor/i);
});

test("normalizeMealDeal requires at least one qualifying and one drink category", () => {
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "11:00" }, qualifyCategories: [], drinkCategories: ["coffee"], drinkPrice: 1 },
    menu()
  ), /categor/i);
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "11:00" }, qualifyCategories: ["all-day"], drinkCategories: [], drinkPrice: 1 },
    menu()
  ), /categor/i);
});

test("normalizeMealDeal allows empty categories when the deal is disabled", () => {
  const out = normalizeMealDeal(
    { enabled: false, window: { to: "11:00" }, qualifyCategories: [], drinkCategories: [], drinkPrice: 1 },
    menu()
  );
  assert.strictEqual(out.enabled, false);
  assert.deepStrictEqual(out.qualifyCategories, []);
  assert.deepStrictEqual(out.drinkCategories, []);
});

test("normalizeMealDeal rejects a negative deal price", () => {
  assert.throws(() => normalizeMealDeal(
    { enabled: true, window: { to: "11:00" }, qualifyCategories: ["all-day"], drinkCategories: ["coffee"], drinkPrice: -1 },
    menu()
  ), /price/i);
});
