"use strict";
// Tests for the generalized promo-code engine: a promo is a config object
// (code + discount {mode,value} + target {scope,ref}) and the engine derives a
// server-authoritative discount from the real menu. Legacy KATYUSHA (50% off a
// honeycake) is preserved via the `honeycake` scope.
const test = require("node:test");
const assert = require("node:assert");
const { LEGACY_KATYUSHA, isHoneycake, computePromoDiscount, normalizePromos } = require("./promo");

function menu() {
  return {
    categoryOrder: ["mains", "desserts", "drinks"],
    categories: {
      mains: {
        title: "Mains",
        items: [
          { id: "burger", name: "Burger", price: 12 },
          // A non-dessert whose name merely contains "honey" — must NOT count.
          { id: "salad-honey", name: "Honey Mustard Bowl", price: 18 },
        ],
      },
      desserts: {
        title: "Desserts",
        items: [
          { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4 },
          { id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4 },
          { id: "tiramisu-classic", name: "Classic Tiramisu", price: 14.4 },
          { id: "cookie", name: "Cookie", price: 2 },
        ],
      },
      drinks: {
        title: "Drinks",
        items: [{ id: "latte", name: "Latte", sizes: { Small: 4, Large: 5.5 } }],
      },
    },
  };
}

// Helper to build a promo config object quickly.
function promo(code, mode, value, scope, ref) {
  return { code, enabled: true, discount: { mode, value }, target: { scope, ref } };
}

/* ── legacy catalog object + helpers ───────────────────────────── */

test("LEGACY_KATYUSHA is a valid honeycake percent promo", () => {
  assert.ok(LEGACY_KATYUSHA, "LEGACY_KATYUSHA should exist");
  assert.strictEqual(LEGACY_KATYUSHA.code, "KATYUSHA");
  assert.strictEqual(LEGACY_KATYUSHA.discount.mode, "percent");
  assert.strictEqual(LEGACY_KATYUSHA.discount.value, 50);
  assert.strictEqual(LEGACY_KATYUSHA.target.scope, "honeycake");
});

test("isHoneycake matches honeycakes by id prefix or name, not other items", () => {
  assert.strictEqual(isHoneycake({ id: "honeycake-classic", name: "Classic Honeycake" }), true);
  assert.strictEqual(isHoneycake({ id: "", name: "Black Forest Honeycake" }), true);
  assert.strictEqual(isHoneycake({ id: "tiramisu-classic", name: "Classic Tiramisu" }), false);
  assert.strictEqual(isHoneycake({ id: "salad-honey", name: "Honey Mustard Bowl" }), false);
  assert.strictEqual(isHoneycake(null), false);
});

/* ── honeycake (legacy) scope ──────────────────────────────────── */

test("honeycake scope: 50% off a single honeycake", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 }];
  const d = computePromoDiscount(LEGACY_KATYUSHA, items, menu());
  assert.ok(d);
  assert.strictEqual(d.amount, -5.7);
  assert.strictEqual(d.code, "KATYUSHA");
});

test("honeycake scope: the priciest honeycake unit is discounted, qty-independent", () => {
  const items = [
    { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 2 },
    { id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4, qty: 3 },
  ];
  const d = computePromoDiscount(LEGACY_KATYUSHA, items, menu());
  assert.strictEqual(d.amount, -6.7); // 50% of the priciest (13.40), one unit
});

test("honeycake scope: discount uses the AUTHORITATIVE menu price, not the line's claim", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 999, qty: 1 }];
  const d = computePromoDiscount(LEGACY_KATYUSHA, items, menu());
  assert.strictEqual(d.amount, -5.7);
});

test("honeycake scope: no honeycake in cart -> null", () => {
  const items = [{ id: "tiramisu-classic", name: "Classic Tiramisu", price: 14.4, qty: 1 }];
  assert.strictEqual(computePromoDiscount(LEGACY_KATYUSHA, items, menu()), null);
});

/* ── order scope ───────────────────────────────────────────────── */

test("order percent: N% off the whole items subtotal", () => {
  const items = [
    { id: "burger", name: "Burger", price: 12, qty: 2 },
    { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 },
  ];
  const d = computePromoDiscount(promo("SAVE10", "percent", 10, "order"), items, menu());
  assert.strictEqual(d.amount, -3.54); // 10% of (24 + 11.40) = 35.40
});

test("order amount: fixed $ off, clamped to the subtotal", () => {
  const items = [{ id: "cookie", name: "Cookie", price: 2, qty: 1 }];
  const d = computePromoDiscount(promo("FIVEOFF", "amount", 5, "order"), items, menu());
  assert.strictEqual(d.amount, -2); // min($5, $2 subtotal)
});

test("order scope uses authoritative size prices for sized lines", () => {
  const items = [{ id: "latte", name: "Latte", size: "Large", price: 99, qty: 2 }];
  const d = computePromoDiscount(promo("SAVE10", "percent", 10, "order"), items, menu());
  assert.strictEqual(d.amount, -1.1); // 10% of (5.50 * 2), NOT the claimed 99
});

/* ── category scope ────────────────────────────────────────────── */

test("category percent: N% off the matching category's subtotal only", () => {
  const items = [
    { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 },
    { id: "tiramisu-classic", name: "Classic Tiramisu", price: 14.4, qty: 1 },
    { id: "burger", name: "Burger", price: 12, qty: 1 }, // excluded (mains)
  ];
  const d = computePromoDiscount(promo("SWEET20", "percent", 20, "category", "desserts"), items, menu());
  assert.strictEqual(d.amount, -5.16); // 20% of (11.40 + 14.40)
});

test("category scope with nothing eligible -> null", () => {
  const items = [{ id: "burger", name: "Burger", price: 12, qty: 1 }];
  assert.strictEqual(computePromoDiscount(promo("SWEET20", "percent", 20, "category", "desserts"), items, menu()), null);
});

/* ── item scope ────────────────────────────────────────────────── */

test("item percent: % off the priciest matching unit, qty-independent", () => {
  const items = [
    { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 3 },
    { id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4, qty: 1 },
  ];
  const d = computePromoDiscount(promo("HALFCLASSIC", "percent", 50, "item", "honeycake-classic"), items, menu());
  assert.strictEqual(d.amount, -5.7); // only honeycake-classic matches; one unit
});

test("item amount: $ off, clamped to the unit price", () => {
  const items = [{ id: "burger", name: "Burger", price: 12, qty: 1 }];
  const d = computePromoDiscount(promo("BIGOFF", "amount", 20, "item", "burger"), items, menu());
  assert.strictEqual(d.amount, -12); // min($20, $12 unit)
});

test("item scope: target not in cart -> null", () => {
  const items = [{ id: "burger", name: "Burger", price: 12, qty: 1 }];
  assert.strictEqual(computePromoDiscount(promo("X", "percent", 10, "item", "honeycake-classic"), items, menu()), null);
});

/* ── guards ────────────────────────────────────────────────────── */

test("disabled promo yields no discount", () => {
  const p = promo("SAVE10", "percent", 10, "order");
  p.enabled = false;
  const items = [{ id: "burger", name: "Burger", price: 12, qty: 1 }];
  assert.strictEqual(computePromoDiscount(p, items, menu()), null);
});

test("empty cart yields no discount", () => {
  assert.strictEqual(computePromoDiscount(promo("SAVE10", "percent", 10, "order"), [], menu()), null);
});

/* ── normalizePromos validation ────────────────────────────────── */

test("normalizePromos cleans a valid list: uppercases code, mints id, defaults label, coerces enabled", () => {
  const out = normalizePromos([{ code: "save10", discount: { mode: "percent", value: 10 }, target: { scope: "order" } }], menu());
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].code, "SAVE10");
  assert.strictEqual(out[0].id, "save10");
  assert.strictEqual(out[0].enabled, true);
  assert.ok(out[0].label.includes("SAVE10"));
});

test("normalizePromos rejects duplicate codes (case-insensitive)", () => {
  assert.throws(() => normalizePromos([
    promo("DUP", "percent", 10, "order"),
    promo("dup", "percent", 20, "order"),
  ], menu()), /Duplicate/i);
});

test("normalizePromos rejects a missing code", () => {
  assert.throws(() => normalizePromos([promo("", "percent", 10, "order")], menu()), /code/i);
});

test("normalizePromos rejects an invalid code format", () => {
  assert.throws(() => normalizePromos([promo("has space", "percent", 10, "order")], menu()), /code/i);
});

test("normalizePromos rejects an out-of-range percentage", () => {
  assert.throws(() => normalizePromos([promo("BIG", "percent", 150, "order")], menu()), /1.?100|percentage/i);
});

test("normalizePromos rejects an unknown category target", () => {
  assert.throws(() => normalizePromos([promo("X", "percent", 10, "category", "nope")], menu()), /category/i);
});

test("normalizePromos rejects an unknown item target", () => {
  assert.throws(() => normalizePromos([promo("X", "percent", 10, "item", "nope")], menu()), /item/i);
});

test("normalizePromos rejects an amount-mode honeycake promo", () => {
  assert.throws(() => normalizePromos([promo("X", "amount", 5, "honeycake")], menu()), /honeycake|percent/i);
});

test("normalizePromos accepts category, item, order, and honeycake scopes", () => {
  const out = normalizePromos([
    promo("A", "percent", 10, "order"),
    promo("B", "percent", 20, "category", "desserts"),
    promo("C", "amount", 3, "item", "burger"),
    promo("D", "percent", 50, "honeycake"),
  ], menu());
  assert.strictEqual(out.length, 4);
});
