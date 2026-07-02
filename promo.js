"use strict";
// Promo-code discounts — a small, pure, unit-testable engine.
//
// A promo is a CONFIG OBJECT stored per-tenant (config.promos), shaped:
//   { id, code, label, enabled, discount: { mode, value }, target: { scope, ref } }
//   • discount.mode: "percent" (value 1–100) | "amount" (value 1–9999 dollars)
//   • target.scope:  "order"     — whole items subtotal
//                    "category"  — ref = category slug; that category's subtotal
//                    "item"      — ref = item id; the priciest matching unit (one)
//                    "honeycake" — legacy KATYUSHA family rule (percent only)
//
// Every discount is derived from the AUTHORITATIVE menu price here on the server,
// never from a client-supplied line amount, so a tampered request can't inflate
// it. POST /order seeds the result into the order's existing `adjustments[]`,
// which already flows into the bill total, the dashboard and the GST receipt.

// The carried-over Crispy promo. Used as the fallback for the default tenant
// until its owner saves their own promo list in the ops console.
const LEGACY_KATYUSHA = {
  id: "katyusha",
  code: "KATYUSHA",
  label: "KATYUSHA · 50% off honeycake",
  enabled: true,
  discount: { mode: "percent", value: 50 },
  target: { scope: "honeycake" },
};

const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lineQty(line) {
  const q = Number(line && line.qty);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

// Resolve an order line to its menu item: by id (preferred) or by stripped name.
// Mirrors the server's findMenuItem so detection/pricing use the real menu item,
// not whatever the client claimed on the line.
function resolveMenuItem(menu, line) {
  if (!menu || !Array.isArray(menu.categoryOrder)) return null;
  if (line && line.id) {
    for (const slug of menu.categoryOrder) {
      const cat = menu.categories[slug];
      if (cat && Array.isArray(cat.items)) {
        const hit = cat.items.find((x) => x.id === line.id);
        if (hit) return hit;
      }
    }
  }
  if (line && line.name) {
    const base = String(line.name).replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    for (const slug of menu.categoryOrder) {
      const cat = menu.categories[slug];
      if (cat && Array.isArray(cat.items)) {
        const hit = cat.items.find((x) => String(x.name || "").trim().toLowerCase() === base);
        if (hit) return hit;
      }
    }
  }
  return null;
}

// A honeycake is identified by its stable id prefix `honeycake-`, with a name
// fallback (normalised letters contain "honeycake"). "Honey Mustard Bowl" and the
// like do NOT match — only an actual *honeycake* does.
function isHoneycake(item) {
  if (!item) return false;
  const id = String(item.id || "").toLowerCase();
  if (id === "honeycake" || id.startsWith("honeycake-")) return true;
  const name = String(item.name || "").toLowerCase().replace(/[^a-z]/g, "");
  return name.includes("honeycake");
}

// Authoritative base unit price for a menu item (fixed price, or cheapest size).
function unitPrice(item) {
  if (!item) return null;
  if (typeof item.price === "number") return item.price;
  if (item.sizes && typeof item.sizes === "object") {
    const vals = Object.values(item.sizes).filter((v) => typeof v === "number");
    if (vals.length) return Math.min(...vals);
  }
  return null;
}

// Authoritative unit price for a specific line: honours the line's chosen size
// (validated against the menu's own size prices) else falls back to unitPrice.
// Never trusts the line's claimed `price`.
function authoritativeLineUnit(item, line) {
  if (!item) return null;
  if (line && line.size && item.sizes && typeof item.sizes[line.size] === "number") {
    return item.sizes[line.size];
  }
  return unitPrice(item);
}

// Set of item ids belonging to a category slug.
function categoryItemIds(menu, slug) {
  const ids = new Set();
  const cat = menu && menu.categories && menu.categories[slug];
  if (cat && Array.isArray(cat.items)) for (const it of cat.items) if (it && it.id) ids.add(it.id);
  return ids;
}

// Sum of authoritative (unit × qty) over lines for which keep(item) is true.
function authoritativeSubtotal(items, menu, keep) {
  let sum = 0;
  for (const line of Array.isArray(items) ? items : []) {
    const it = resolveMenuItem(menu, line);
    if (!it || !keep(it)) continue;
    const u = authoritativeLineUnit(it, line);
    if (typeof u !== "number") continue;
    sum += u * lineQty(line);
  }
  return round2(sum);
}

// Priciest authoritative unit among lines for which keep(item) is true, or null.
function priciestUnit(items, menu, keep) {
  let best = null;
  for (const line of Array.isArray(items) ? items : []) {
    const it = resolveMenuItem(menu, line);
    if (!it || !keep(it)) continue;
    const u = authoritativeLineUnit(it, line);
    if (typeof u !== "number") continue;
    if (best == null || u > best) best = u;
  }
  return best;
}

// Compute the discount a promo config earns on a set of order lines, or null if
// nothing is eligible / the promo is disabled. The returned `amount` is NEGATIVE
// (a discount) and rounded to cents, ready to drop into adjustments[].
function computePromoDiscount(promo, items, menu) {
  if (!promo || promo.enabled === false) return null;
  const code = String(promo.code || "").trim().toUpperCase();
  if (!code) return null;
  const mode = promo.discount && promo.discount.mode;
  const value = Number(promo.discount && promo.discount.value);
  if ((mode !== "percent" && mode !== "amount") || !Number.isFinite(value) || value <= 0) return null;
  const scope = promo.target && promo.target.scope;
  const ref = promo.target && promo.target.ref;

  // A "base" the discount is taken against, OR a single unit price for the
  // single-unit scopes. percent → value% of it; amount → min(value, it).
  let base = null;
  if (scope === "order") {
    base = authoritativeSubtotal(items, menu, () => true);
  } else if (scope === "category") {
    const ids = categoryItemIds(menu, String(ref || ""));
    if (!ids.size) return null;
    base = authoritativeSubtotal(items, menu, (it) => ids.has(it.id));
  } else if (scope === "item") {
    base = priciestUnit(items, menu, (it) => it.id === ref);
  } else if (scope === "honeycake") {
    if (mode !== "percent") return null; // legacy scope is percent-only
    base = priciestUnit(items, menu, isHoneycake);
  } else {
    return null;
  }
  if (base == null || base <= 0) return null;

  // Defense-in-depth: normalizePromos enforces percent ≤ 100, but a hand-edited
  // config could bypass it — never discount more than the base itself.
  const amount = round2(mode === "amount" ? Math.min(value, base) : base * (Math.min(value, 100) / 100));
  if (amount <= 0) return null;
  return { code, label: promo.label || code, amount: -amount, promo: code };
}

// Human label auto-generated when the owner leaves it blank.
function summaryLabel(p) {
  const disc = p.discount.mode === "amount" ? ("$" + p.discount.value + " off") : (p.discount.value + "% off");
  const where = p.target.scope === "order" ? "whole order"
    : p.target.scope === "honeycake" ? "honeycake"
    : p.target.scope === "category" ? "a category"
    : "an item";
  return p.code + " · " + disc + " " + where;
}

// Validate + clean a promo list against the tenant's menu. Throws Error(message)
// on the first problem (the caller surfaces it as a 400). Returns the cleaned
// array: codes uppercased + unique, ids minted, labels defaulted, enabled coerced.
function normalizePromos(list, menu) {
  if (!Array.isArray(list)) throw new Error("Promos must be a list.");
  if (list.length > 50) throw new Error("Too many promo codes (max 50).");
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") throw new Error("Each promo must be an object.");
    const code = String(raw.code || "").trim().toUpperCase();
    if (!code) throw new Error("Each promo needs a code.");
    if (!CODE_RE.test(code)) throw new Error("Invalid code “" + code + "”: letters, numbers, . _ - only (max 32).");
    if (seen.has(code)) throw new Error("Duplicate code: " + code + ".");
    seen.add(code);

    const mode = (raw.discount && raw.discount.mode) === "amount" ? "amount"
      : (raw.discount && raw.discount.mode) === "percent" ? "percent" : null;
    if (!mode) throw new Error("Promo " + code + " needs a discount type (percent or amount).");
    const value = Number(raw.discount && raw.discount.value);
    if (mode === "percent" && !(Number.isFinite(value) && value > 0 && value <= 100)) {
      throw new Error("Promo " + code + ": percentage must be 1–100.");
    }
    if (mode === "amount" && !(Number.isFinite(value) && value > 0 && value <= 9999)) {
      throw new Error("Promo " + code + ": amount must be between 0 and 9999.");
    }

    const scope = raw.target && raw.target.scope;
    const target = { scope };
    if (scope === "order") {
      // no ref
    } else if (scope === "honeycake") {
      if (mode !== "percent") throw new Error("Promo " + code + ": a honeycake promo must be a percentage.");
    } else if (scope === "category") {
      const r = String((raw.target && raw.target.ref) || "");
      if (!menu || !menu.categories || !menu.categories[r]) throw new Error("Promo " + code + ": unknown category.");
      target.ref = r;
    } else if (scope === "item") {
      const r = String((raw.target && raw.target.ref) || "");
      if (!resolveMenuItem(menu, { id: r })) throw new Error("Promo " + code + ": unknown item.");
      target.ref = r;
    } else {
      throw new Error("Promo " + code + ": choose what the code applies to.");
    }

    const p = {
      id: String(raw.id || "").trim() || code.toLowerCase(),
      code,
      enabled: raw.enabled === undefined ? true : !!raw.enabled,
      discount: { mode, value: mode === "amount" ? round2(value) : value },
      target,
    };
    p.label = String(raw.label || "").trim().slice(0, 120) || summaryLabel(p);
    out.push(p);
  }
  // ids must be unique too (console edits/deletes address promos by id).
  const seenIds = new Set();
  for (const p of out) {
    if (seenIds.has(p.id)) throw new Error("Duplicate promo id: " + p.id + ".");
    seenIds.add(p.id);
  }
  return out;
}

module.exports = {
  LEGACY_KATYUSHA,
  isHoneycake,
  unitPrice,
  resolveMenuItem,
  computePromoDiscount,
  normalizePromos,
};
