"use strict";
// Tests for the pricing/fees normaliser: the owner-facing Settings editor for the
// two independent charging models — a flat per-order developer fee and a
// per-category online menu price rise (surcharge). Pure + server-authoritative:
// category slugs are validated against the live menu, all money is clamped >= 0.
const test = require("node:test");
const assert = require("node:assert");
const { normalizePricing } = require("./pricing");

function menu() {
  return {
    categoryOrder: ["all-day", "mains", "coffee", "sides"],
    categories: {
      "all-day": { title: "Breakfast", items: [] },
      mains: { title: "Mains", items: [] },
      coffee: { title: "Coffee", items: [] },
      sides: { title: "Sides", items: [] },
    },
  };
}

test("clean input round-trips", () => {
  const out = normalizePricing(
    { developerFee: 2, developerFeeLabel: "Developer fee", surcharge: { coffee: 0.2, mains: 0.6 }, surchargeDefault: 0.1 },
    menu()
  );
  assert.strictEqual(out.developerFee, 2);
  assert.strictEqual(out.developerFeeLabel, "Developer fee");
  assert.deepStrictEqual(out.surcharge, { coffee: 0.2, mains: 0.6 });
  assert.strictEqual(out.surchargeDefault, 0.1);
});

test("developerFee: 0 is off; negatives/junk clamp to 0", () => {
  assert.strictEqual(normalizePricing({ developerFee: 0 }, menu()).developerFee, 0);
  assert.strictEqual(normalizePricing({ developerFee: -5 }, menu()).developerFee, 0);
  assert.strictEqual(normalizePricing({ developerFee: "abc" }, menu()).developerFee, 0);
  assert.strictEqual(normalizePricing({}, menu()).developerFee, 0);
});

test("developerFee rounds to 2dp", () => {
  assert.strictEqual(normalizePricing({ developerFee: 2.005 }, menu()).developerFee, 2.01);
});

test("developerFeeLabel: trims, falls back, caps length", () => {
  assert.strictEqual(normalizePricing({ developerFeeLabel: "  Service fee  " }, menu()).developerFeeLabel, "Service fee");
  assert.strictEqual(normalizePricing({ developerFeeLabel: "" }, menu()).developerFeeLabel, "Developer fee");
  assert.strictEqual(normalizePricing({ developerFeeLabel: "   " }, menu()).developerFeeLabel, "Developer fee");
  assert.strictEqual(normalizePricing({}, menu()).developerFeeLabel, "Developer fee");
  assert.strictEqual(normalizePricing({ developerFeeLabel: "x".repeat(80) }, menu()).developerFeeLabel.length, 40);
});

test("surcharge drops slugs not in the live menu", () => {
  const out = normalizePricing({ surcharge: { coffee: 0.2, ghost: 0.5, "old-cat": 1 } }, menu());
  assert.deepStrictEqual(out.surcharge, { coffee: 0.2 });
});

test("surcharge keeps explicit 0 (exempt from default), drops negative/junk", () => {
  const out = normalizePricing({ surcharge: { coffee: 0, mains: -0.3, sides: 0.15 } }, menu());
  assert.deepStrictEqual(out.surcharge, { coffee: 0, sides: 0.15 });
  // Junk, empty and null never become an accidental exemption.
  const junk = normalizePricing({ surcharge: { coffee: "abc", mains: "", sides: null } }, menu());
  assert.deepStrictEqual(junk.surcharge, {});
  // Explicit "0" as a string counts as an exemption too (form inputs send strings).
  const str = normalizePricing({ surcharge: { coffee: "0" } }, menu());
  assert.deepStrictEqual(str.surcharge, { coffee: 0 });
});

test("surcharge values round to 2dp", () => {
  const out = normalizePricing({ surcharge: { coffee: 0.205 } }, menu());
  assert.strictEqual(out.surcharge.coffee, 0.21);
});

test("surchargeDefault clamps and rounds", () => {
  assert.strictEqual(normalizePricing({ surchargeDefault: -1 }, menu()).surchargeDefault, 0);
  assert.strictEqual(normalizePricing({ surchargeDefault: "junk" }, menu()).surchargeDefault, 0);
  assert.strictEqual(normalizePricing({ surchargeDefault: 0.105 }, menu()).surchargeDefault, 0.11);
  assert.strictEqual(normalizePricing({}, menu()).surchargeDefault, 0);
});

test("missing/non-object surcharge yields empty map", () => {
  assert.deepStrictEqual(normalizePricing({}, menu()).surcharge, {});
  assert.deepStrictEqual(normalizePricing({ surcharge: null }, menu()).surcharge, {});
  assert.deepStrictEqual(normalizePricing({ surcharge: "nope" }, menu()).surcharge, {});
});

test("does not mutate the input or the menu", () => {
  const raw = { developerFee: 2, surcharge: { coffee: 0.2, ghost: 9 } };
  const m = menu();
  const snapRaw = JSON.stringify(raw);
  const snapMenu = JSON.stringify(m);
  normalizePricing(raw, m);
  assert.strictEqual(JSON.stringify(raw), snapRaw);
  assert.strictEqual(JSON.stringify(m), snapMenu);
});

test("tolerates a missing/empty menu (no categories → empty surcharge map)", () => {
  assert.deepStrictEqual(normalizePricing({ surcharge: { coffee: 0.2 } }, null).surcharge, {});
  assert.deepStrictEqual(normalizePricing({ surcharge: { coffee: 0.2 } }, {}).surcharge, {});
});

test("non-object raw is treated as all-defaults", () => {
  const out = normalizePricing(null, menu());
  assert.strictEqual(out.developerFee, 0);
  assert.strictEqual(out.developerFeeLabel, "Developer fee");
  assert.deepStrictEqual(out.surcharge, {});
  assert.strictEqual(out.surchargeDefault, 0);
});
