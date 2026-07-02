"use strict";
// Pricing/fees normaliser — validates the owner's Settings edits for the two
// INDEPENDENT online-order charging models this platform supports:
//
//   1. developerFee      — a flat per-order fee (dollars), disclosed at checkout
//                           and on the GST receipt. 0 = off.
//   2. surcharge/default  — a per-category "+¢" baked into displayed menu prices
//                           in GET /menu (config.surcharge map, keyed by category
//                           slug; config.surchargeDefault covers the rest).
//
// Pure + unit-tested (see pricing.test.js). Called by PATCH /me/pricing before
// saving to tenant config. All money is CLAMPED to >= 0 (never throws on a stray
// character — the owner shouldn't hit a hard error), and surcharge keys are
// filtered against the live menu's categoryOrder so stale/garbage slugs can't
// accumulate. Never mutates its inputs.

const LABEL_MAX = 40;
const DEFAULT_LABEL = "Developer fee";

// Coerce to a non-negative amount rounded to 2dp; anything invalid → 0.
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v * 100) / 100;
}

// Set of valid category slugs from a menu (empty if the menu is missing/empty).
function menuSlugs(menu) {
  const order = menu && Array.isArray(menu.categoryOrder) ? menu.categoryOrder : [];
  return new Set(order);
}

// normalizePricing(raw, menu) → { developerFee, developerFeeLabel, surcharge, surchargeDefault }
function normalizePricing(raw, menu) {
  const r = raw && typeof raw === "object" ? raw : {};
  const slugs = menuSlugs(menu);

  const developerFee = money(r.developerFee);

  let developerFeeLabel = typeof r.developerFeeLabel === "string" ? r.developerFeeLabel.trim() : "";
  if (!developerFeeLabel) developerFeeLabel = DEFAULT_LABEL;
  if (developerFeeLabel.length > LABEL_MAX) developerFeeLabel = developerFeeLabel.slice(0, LABEL_MAX);

  // Keep only entries for real menu categories. Positive amounts are kept as-is;
  // an EXPLICIT 0 is kept too — it means "exempt this category from
  // surchargeDefault" (the runtime consumer treats a stored 0 as 0, not default).
  // Junk/negative values are dropped so the default covers those categories.
  const surcharge = {};
  const rawSurcharge = r.surcharge && typeof r.surcharge === "object" ? r.surcharge : {};
  for (const key of Object.keys(rawSurcharge)) {
    if (!slugs.has(key)) continue;
    const rawV = rawSurcharge[key];
    const v = money(rawV);
    if (v > 0) surcharge[key] = v;
    else if (rawV != null && rawV !== "" && Number(rawV) === 0) surcharge[key] = 0;
  }

  const surchargeDefault = money(r.surchargeDefault);

  return { developerFee, developerFeeLabel, surcharge, surchargeDefault };
}

module.exports = { normalizePricing };
