"use strict";
// Loyalty discounts — the server-authoritative half of the loyalty program.
// Pure functions mirroring promo.js:
//   computeRewardDiscount   — the stamp-card free item (reward item's menu price)
//   computeFrequentDiscount — the per-visit standing discount (% of subtotal, capped)
//   earnStamp               — apply one earned stamp, rolling a full card into a reward
// Discounts return a NEGATIVE `amount` (rounded to cents) for adjustments[]. All
// pricing derives from the AUTHORITATIVE menu / the server's stored visit count —
// never from a client-supplied value.
const { resolveMenuItem, unitPrice } = require("./promo");

function round2(n) { return Math.round(n * 100) / 100; }

// Normalize a tenant's loyalty config with safe defaults.
function loyaltyConfig(cfg) {
  const L = (cfg && cfg.loyalty) || {};
  const f = L.frequent || {};
  return {
    stampsNeeded: Number.isFinite(+L.stampsNeeded) && +L.stampsNeeded > 0 ? Math.floor(+L.stampsNeeded) : 10,
    rewardItemId: L.rewardItemId || null,
    minOrder: Number.isFinite(+L.minOrder) && +L.minOrder > 0 ? round2(+L.minOrder) : 0,
    frequent: {
      enabled: f.enabled !== false,
      percentPerVisit: Number.isFinite(+f.percentPerVisit) && +f.percentPerVisit > 0 ? +f.percentPerVisit : 1,
      maxPercent: Number.isFinite(+f.maxPercent) && +f.maxPercent >= 0 ? +f.maxPercent : 15,
    },
  };
}

// Is the loyalty feature switched on for this tenant?
function loyaltyEnabled(cfg) {
  return !!(cfg && cfg.features && cfg.features.loyalty);
}

// Subtotal of order lines (prices already validated against the menu upstream).
function itemsSubtotal(items) {
  return round2((Array.isArray(items) ? items : [])
    .reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0));
}

// Stamp-card reward: a free unit of cfg.loyalty.rewardItemId, only when that item
// is in the cart. amount = -authoritative menu price.
function computeRewardDiscount(cfg, menu, items) {
  if (!loyaltyEnabled(cfg)) return null;
  const L = loyaltyConfig(cfg);
  if (!L.rewardItemId) return null;
  const rewardItem = resolveMenuItem(menu, { id: L.rewardItemId });
  if (!rewardItem) return null;
  // Price the reward at the size actually in the cart (priciest matching unit —
  // "free" must cover what they ordered), not the item's cheapest size.
  let p = null;
  for (const line of (Array.isArray(items) ? items : [])) {
    const mi = resolveMenuItem(menu, line);
    if (!mi || mi.id !== rewardItem.id) continue;
    let u = unitPrice(rewardItem);
    if (line && line.size && rewardItem.sizes && typeof rewardItem.sizes[line.size] === "number") {
      u = rewardItem.sizes[line.size];
    }
    if (typeof u === "number" && (p == null || u > p)) p = u;
  }
  if (typeof p !== "number" || p <= 0) return null;
  return { rewardItemId: rewardItem.id, label: "Loyalty reward · free " + (rewardItem.name || "item"), amount: -round2(p) };
}

// Frequent-customer standing percent: +percentPerVisit per PAID visit
// (customer.loyalty.lifetimeStamps), capped at maxPercent. Server-stored, never client.
function frequentPercent(cfg, customer) {
  if (!loyaltyEnabled(cfg)) return 0;
  const L = loyaltyConfig(cfg);
  if (!L.frequent.enabled || L.frequent.maxPercent <= 0) return 0;
  const visits = Math.max(0, Math.floor((customer && customer.loyalty && customer.loyalty.lifetimeStamps) || 0));
  return Math.min(L.frequent.maxPercent, visits * L.frequent.percentPerVisit);
}

function computeFrequentDiscount(cfg, customer, items) {
  const percent = frequentPercent(cfg, customer);
  if (percent <= 0) return null;
  const sub = itemsSubtotal(items);
  if (sub <= 0) return null;
  const amount = -round2(sub * percent / 100);
  if (amount === 0) return null;
  return { label: "Regular · " + (Math.round(percent * 10) / 10) + "% off", percent, amount };
}

// Apply one earned stamp to a customer's loyalty counters (mutates in place),
// rolling each full card into a redeemable reward.
function earnStamp(loyalty, stampsNeeded) {
  loyalty.stamps = (loyalty.stamps || 0) + 1;
  loyalty.lifetimeStamps = (loyalty.lifetimeStamps || 0) + 1;
  const need = stampsNeeded > 0 ? stampsNeeded : 10;
  while (loyalty.stamps >= need) {
    loyalty.stamps -= need;
    loyalty.rewardsAvailable = (loyalty.rewardsAvailable || 0) + 1;
    loyalty.lifetimeRewards = (loyalty.lifetimeRewards || 0) + 1;
  }
  return loyalty;
}

module.exports = {
  loyaltyConfig, loyaltyEnabled, itemsSubtotal,
  computeRewardDiscount, frequentPercent, computeFrequentDiscount, earnStamp,
};
