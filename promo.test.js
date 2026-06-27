"use strict";
// Tests for promo-code discounts (KATYUSHA: 50% off one honeycake).
const test = require("node:test");
const assert = require("node:assert");
const { PROMOS, isHoneycake, computePromoDiscount } = require("./promo");

function menu() {
  return {
    categoryOrder: ["mains", "desserts"],
    categories: {
      mains: {
        title: "Mains",
        items: [
          // A non-dessert whose name merely contains "honey" — must NOT count.
          { id: "salad-honey", name: "Honey Mustard Bowl", price: 18 },
        ],
      },
      desserts: {
        title: "Desserts",
        items: [
          { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4 },
          { id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4 },
          // A dessert that is NOT a honeycake — must NOT be discounted.
          { id: "tiramisu-classic", name: "Classic Tiramisu", price: 14.4 },
        ],
      },
    },
  };
}

test("PROMOS catalog defines KATYUSHA as 50% off a honeycake", () => {
  assert.ok(PROMOS.KATYUSHA, "KATYUSHA should exist");
  assert.strictEqual(PROMOS.KATYUSHA.percent, 50);
  assert.strictEqual(PROMOS.KATYUSHA.scope, "honeycake");
  assert.strictEqual(typeof PROMOS.KATYUSHA.label, "string");
});

test("isHoneycake matches honeycakes by id prefix or name, not other items", () => {
  assert.strictEqual(isHoneycake({ id: "honeycake-classic", name: "Classic Honeycake" }), true);
  assert.strictEqual(isHoneycake({ id: "", name: "Black Forest Honeycake" }), true); // by name
  assert.strictEqual(isHoneycake({ id: "tiramisu-classic", name: "Classic Tiramisu" }), false);
  assert.strictEqual(isHoneycake({ id: "salad-honey", name: "Honey Mustard Bowl" }), false); // "honey" != "honeycake"
  assert.strictEqual(isHoneycake(null), false);
});

test("unknown promo code yields no discount", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 }];
  assert.strictEqual(computePromoDiscount("NOPE", items, menu()), null);
});

test("KATYUSHA gives 50% off a single honeycake", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 }];
  const d = computePromoDiscount("KATYUSHA", items, menu());
  assert.ok(d, "should return a discount");
  assert.strictEqual(d.amount, -5.7); // 50% of 11.40, negative
  assert.strictEqual(d.code, "KATYUSHA");
});

test("KATYUSHA code is case-insensitive and trimmed", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 }];
  const d = computePromoDiscount("  katyusha ", items, menu());
  assert.ok(d);
  assert.strictEqual(d.amount, -5.7);
});

test("with several honeycakes, the most expensive one is discounted", () => {
  const items = [
    { id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 },
    { id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4, qty: 1 },
  ];
  const d = computePromoDiscount("KATYUSHA", items, menu());
  assert.strictEqual(d.amount, -6.7); // 50% of the priciest (13.40)
});

test("only ONE honeycake unit is discounted even when qty > 1", () => {
  const items = [{ id: "honeycake-blackforest", name: "Black Forest Honeycake", price: 13.4, qty: 3 }];
  const d = computePromoDiscount("KATYUSHA", items, menu());
  assert.strictEqual(d.amount, -6.7); // not multiplied by qty
});

test("no honeycake in the cart -> no discount (valid code, nothing eligible)", () => {
  const items = [{ id: "tiramisu-classic", name: "Classic Tiramisu", price: 14.4, qty: 1 }];
  assert.strictEqual(computePromoDiscount("KATYUSHA", items, menu()), null);
});

test("a non-honeycake item whose name contains 'honey' is not discounted", () => {
  const items = [{ id: "salad-honey", name: "Honey Mustard Bowl", price: 18, qty: 1 }];
  assert.strictEqual(computePromoDiscount("KATYUSHA", items, menu()), null);
});

test("honeycake resolved by name (no id) is still discounted at the menu price", () => {
  const items = [{ name: "Classic Honeycake", price: 11.4, qty: 1 }];
  const d = computePromoDiscount("KATYUSHA", items, menu());
  assert.strictEqual(d.amount, -5.7);
});

test("discount is computed from the AUTHORITATIVE menu price, not the client's claimed price", () => {
  // A tampered line claiming a $999 honeycake must still only discount the real $11.40.
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 999, qty: 1 }];
  const d = computePromoDiscount("KATYUSHA", items, menu());
  assert.strictEqual(d.amount, -5.7); // 50% of the real 11.40, NOT 999
});

test("empty cart yields no discount", () => {
  assert.strictEqual(computePromoDiscount("KATYUSHA", [], menu()), null);
});
