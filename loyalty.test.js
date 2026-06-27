"use strict";
// Tests for loyalty discount math (stamp-card reward + frequent-customer standing discount).
const test = require("node:test");
const assert = require("node:assert");
const {
  loyaltyConfig, loyaltyEnabled, itemsSubtotal,
  computeRewardDiscount, frequentPercent, computeFrequentDiscount, earnStamp,
} = require("./loyalty");

function menu() {
  return {
    categoryOrder: ["coffee", "cakes"],
    categories: {
      coffee: { title: "Coffee", items: [{ id: "flat-white", name: "Flat White", price: 5 }] },
      cakes: { title: "Cakes", items: [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4 }] },
    },
  };
}
// A tenant config with loyalty ON, reward = flat white, default frequent ramp.
function cfgOn(extra) {
  return Object.assign({ features: { loyalty: true }, loyalty: { stampsNeeded: 10, rewardItemId: "flat-white" } }, extra || {});
}

test("loyaltyConfig fills defaults (10 stamps, +1%/visit cap 15)", () => {
  const L = loyaltyConfig({ loyalty: {} });
  assert.strictEqual(L.stampsNeeded, 10);
  assert.strictEqual(L.rewardItemId, null);
  assert.strictEqual(L.frequent.percentPerVisit, 1);
  assert.strictEqual(L.frequent.maxPercent, 15);
  assert.strictEqual(L.frequent.enabled, true);
});

test("loyaltyEnabled reflects features.loyalty", () => {
  assert.strictEqual(loyaltyEnabled({ features: { loyalty: true } }), true);
  assert.strictEqual(loyaltyEnabled({ features: {} }), false);
  assert.strictEqual(loyaltyEnabled({}), false);
});

test("computeRewardDiscount: free reward item when it is in the cart, at the authoritative price", () => {
  const items = [{ id: "flat-white", name: "Flat White", price: 999, qty: 1 }]; // tampered price
  const d = computeRewardDiscount(cfgOn(), menu(), items);
  assert.ok(d);
  assert.strictEqual(d.amount, -5);            // real $5, not 999
  assert.strictEqual(d.rewardItemId, "flat-white");
});

test("computeRewardDiscount: null when reward item not in cart", () => {
  const items = [{ id: "honeycake-classic", name: "Classic Honeycake", price: 11.4, qty: 1 }];
  assert.strictEqual(computeRewardDiscount(cfgOn(), menu(), items), null);
});

test("computeRewardDiscount: null when loyalty disabled or no reward set", () => {
  const items = [{ id: "flat-white", name: "Flat White", price: 5, qty: 1 }];
  assert.strictEqual(computeRewardDiscount({ features: {} , loyalty: { rewardItemId: "flat-white" } }, menu(), items), null);
  assert.strictEqual(computeRewardDiscount({ features: { loyalty: true }, loyalty: {} }, menu(), items), null);
});

test("frequentPercent ramps +1% per paid visit and caps at 15%", () => {
  assert.strictEqual(frequentPercent(cfgOn(), { loyalty: { lifetimeStamps: 0 } }), 0);
  assert.strictEqual(frequentPercent(cfgOn(), { loyalty: { lifetimeStamps: 7 } }), 7);
  assert.strictEqual(frequentPercent(cfgOn(), { loyalty: { lifetimeStamps: 15 } }), 15);
  assert.strictEqual(frequentPercent(cfgOn(), { loyalty: { lifetimeStamps: 40 } }), 15); // capped
});

test("computeFrequentDiscount applies the percent to the item subtotal", () => {
  const items = [{ id: "flat-white", price: 5, qty: 2 }, { id: "honeycake-classic", price: 11.4, qty: 1 }]; // subtotal 21.40
  const d = computeFrequentDiscount(cfgOn(), { loyalty: { lifetimeStamps: 10 } }, items); // 10%
  assert.ok(d);
  assert.strictEqual(d.percent, 10);
  assert.strictEqual(d.amount, -2.14);
});

test("computeFrequentDiscount: null at 0 visits or when track disabled", () => {
  const items = [{ id: "flat-white", price: 5, qty: 1 }];
  assert.strictEqual(computeFrequentDiscount(cfgOn(), { loyalty: { lifetimeStamps: 0 } }, items), null);
  const off = cfgOn({ loyalty: { stampsNeeded: 10, rewardItemId: "flat-white", frequent: { enabled: false } } });
  assert.strictEqual(computeFrequentDiscount(off, { loyalty: { lifetimeStamps: 9 } }, items), null);
});

test("earnStamp increments and rolls a full card into a reward", () => {
  const l = { stamps: 9, rewardsAvailable: 0, lifetimeStamps: 9, lifetimeRewards: 0 };
  earnStamp(l, 10);
  assert.deepStrictEqual(l, { stamps: 0, rewardsAvailable: 1, lifetimeStamps: 10, lifetimeRewards: 1 });
  earnStamp(l, 10); // 11th paid order
  assert.strictEqual(l.stamps, 1);
  assert.strictEqual(l.lifetimeStamps, 11);
  assert.strictEqual(l.rewardsAvailable, 1);
});
