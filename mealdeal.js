"use strict";
// Breakfast meal deal — a time-gated, auto-applied promo. Ordering a qualifying
// food item (a breakfast/main) before the daily cutoff unlocks the right to buy
// one eligible drink for a fixed price ($1). One $1 drink per qualifying meal;
// when more eligible drinks than meals are in the cart, the PRICIEST drink units
// are the ones repriced (most generous — honours "any drink for $1").
//
// Pure + unit-testable. The server calls computeMealDeal() in POST /order and
// drops the returned (negative) adjustment into the order's adjustments[]. Like
// promo.js, every price comes from the AUTHORITATIVE menu, never the client's
// line, so a tampered request can't inflate the discount. The deal needs no
// code — it auto-applies, mirroring the frequent-customer discount.

const { parseHHMM, categoryVisibleAt, localMinutesNow } = require("./menu-availability");
const { resolveMenuItem, unitPrice } = require("./promo");

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lineQty(line) {
  const q = Number(line && line.qty);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

// Authoritative unit price for a line, honouring a valid chosen size; else the
// item's base price (fixed, or cheapest size). Never trusts the line's `price`.
function lineUnit(item, line) {
  if (!item) return null;
  if (line && line.size && item.sizes && typeof item.sizes[line.size] === "number") {
    return item.sizes[line.size];
  }
  return unitPrice(item);
}

// Set of item ids belonging to any of the given category slugs.
function idsInCategories(menu, slugs) {
  const set = new Set();
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    const cat = menu && menu.categories && menu.categories[slug];
    if (cat && Array.isArray(cat.items)) for (const it of cat.items) if (it && it.id) set.add(it.id);
  }
  return set;
}

// Minutes-since-midnight to evaluate the window at: an explicit override (tests)
// or the current wall-clock minute in the tenant's timezone.
function nowMinutes(opts) {
  opts = opts || {};
  if (typeof opts.nowMinOverride === "number") return opts.nowMinOverride;
  return localMinutesNow(opts.timezone);
}

// Is the deal live right now? Enabled AND inside its daily window. Reuses the
// menu-availability window logic, but unlike category display (which fails
// open), a money-giving promo fails CLOSED on a supplied-but-unparseable bound.
function mealDealActive(config, opts) {
  if (!config || !config.enabled) return false;
  const win = config.window;
  if (win && typeof win === "object") {
    if (win.from != null && win.from !== "" && parseHHMM(win.from) == null) return false;
    if (win.to != null && win.to !== "" && parseHHMM(win.to) == null) return false;
  }
  return categoryVisibleAt(win, nowMinutes(opts));
}

// Compute the meal-deal adjustment for a set of order lines, or null if nothing
// is eligible. Returns { label, amount, mealDeal:true } with a NEGATIVE amount.
function computeMealDeal(config, items, menu, opts) {
  if (!mealDealActive(config, opts)) return null;
  if (!Array.isArray(items) || !items.length) return null;

  const dp = Number(config.drinkPrice);
  const price = Number.isFinite(dp) && dp >= 0 ? dp : 1;

  const qualifyIds = idsInCategories(menu, config.qualifyCategories);
  const drinkIds = idsInCategories(menu, config.drinkCategories);
  if (!qualifyIds.size || !drinkIds.size) return null;

  let mealUnits = 0;
  const drinkUnits = []; // authoritative unit prices (one per qty) above the deal price
  for (const line of items) {
    const it = resolveMenuItem(menu, line);
    if (!it || !it.id) continue;
    const qty = lineQty(line);
    // An item that is also an eligible drink can't qualify itself for the deal.
    if (qualifyIds.has(it.id) && !drinkIds.has(it.id)) mealUnits += qty;
    if (drinkIds.has(it.id)) {
      const u = lineUnit(it, line);
      if (typeof u === "number" && u > price) {
        for (let i = 0; i < qty; i++) drinkUnits.push(u);
      }
    }
  }
  if (mealUnits < 1 || !drinkUnits.length) return null;

  drinkUnits.sort((a, b) => b - a);
  const n = Math.min(mealUnits, drinkUnits.length);
  let discount = 0;
  for (let i = 0; i < n; i++) discount += drinkUnits[i] - price;
  discount = round2(discount);
  if (discount <= 0) return null;

  const base = (config.label && String(config.label).trim()) || defaultLabel(price);
  const label = n > 1 ? base + " ×" + n : base;
  return { label, amount: -discount, mealDeal: true };
}

function defaultLabel(price) {
  return "Meal deal · drink for $" + (Number(price) || 0);
}

// Validate + clean a meal-deal config against the tenant's menu. Throws
// Error(message) on the first problem (the caller surfaces it as a 400).
function normalizeMealDeal(raw, menu) {
  if (!raw || typeof raw !== "object") throw new Error("Meal deal must be an object.");
  const enabled = raw.enabled === undefined ? true : !!raw.enabled;

  // Window: each bound optional; if present it must be a valid HH:MM time.
  const win = raw.window && typeof raw.window === "object" ? raw.window : {};
  const window = {};
  if (win.from != null && win.from !== "") {
    if (parseHHMM(win.from) == null) throw new Error("Meal deal: invalid start time (use HH:MM).");
    window.from = String(win.from).trim();
  }
  if (win.to != null && win.to !== "") {
    if (parseHHMM(win.to) == null) throw new Error("Meal deal: invalid cutoff time (use HH:MM).");
    window.to = String(win.to).trim();
  }
  if (window.from && window.to && parseHHMM(window.from) === parseHHMM(window.to)) {
    throw new Error("Meal deal: start and cutoff times must differ.");
  }

  // Categories are required only for an ENABLED deal — a disabled deal can be
  // stored half-configured (e.g. the owner just toggled it off). Any slugs that
  // ARE supplied must exist in the menu either way.
  const cleanCats = (label, arr, required) => {
    const list = Array.isArray(arr) ? arr : [];
    if (required && !list.length) throw new Error("Meal deal: choose at least one " + label + " category.");
    const out = [];
    const seen = new Set();
    for (const s of list) {
      const slug = String(s || "");
      if (!menu || !menu.categories || !menu.categories[slug]) {
        throw new Error("Meal deal: unknown " + label + " category “" + slug + "”.");
      }
      if (!seen.has(slug)) { seen.add(slug); out.push(slug); }
    }
    return out;
  };
  const qualifyCategories = cleanCats("qualifying", raw.qualifyCategories, enabled);
  const drinkCategories = cleanCats("drink", raw.drinkCategories, enabled);

  const dpNum = Number(raw.drinkPrice);
  if (!Number.isFinite(dpNum) || dpNum < 0 || dpNum > 9999) {
    throw new Error("Meal deal: price must be between 0 and 9999.");
  }
  const drinkPrice = round2(dpNum);

  const label = String(raw.label || "").trim().slice(0, 120) || defaultLabel(drinkPrice);
  return { enabled, label, window, qualifyCategories, drinkCategories, drinkPrice };
}

module.exports = { mealDealActive, computeMealDeal, normalizeMealDeal };
