"use strict";
// Promo-code discounts. Currently one code, KATYUSHA, scoped to the Crispy menu
// (the server only consults this module for the default tenant — see server.js).
//
// KATYUSHA gives 50% off ONE honeycake: the single most expensive honeycake unit
// in the order, regardless of quantity or anything else in the cart. The discount
// is always derived from the AUTHORITATIVE menu price here on the server — never
// from a client-supplied amount — so a tampered request can't inflate it.
//
// Kept as a tiny pure module so the discount logic is unit-testable in isolation;
// POST /order seeds the result into the order's existing `adjustments[]` list,
// which already flows into the bill total, the dashboard and the GST receipt.

const PROMOS = {
  KATYUSHA: { label: "KATYUSHA · 50% off honeycake", percent: 50, scope: "honeycake" },
};

function round2(n) {
  return Math.round(n * 100) / 100;
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

// Authoritative unit price for a menu item (base price, or cheapest size).
function unitPrice(item) {
  if (!item) return null;
  if (typeof item.price === "number") return item.price;
  if (item.sizes && typeof item.sizes === "object") {
    const vals = Object.values(item.sizes).filter((v) => typeof v === "number");
    if (vals.length) return Math.min(...vals);
  }
  return null;
}

// Compute the discount a promo code earns on a set of order lines, or null if the
// code is unknown or nothing in the cart is eligible. The returned `amount` is
// NEGATIVE (a discount) and rounded to cents, ready to drop into adjustments[].
function computePromoDiscount(code, items, menu) {
  const key = String(code || "").trim().toUpperCase();
  const promo = PROMOS[key];
  if (!promo || promo.scope !== "honeycake") return null;

  let best = null; // priciest honeycake unit price seen
  for (const line of Array.isArray(items) ? items : []) {
    const mi = resolveMenuItem(menu, line);
    if (!isHoneycake(mi)) continue;
    const p = unitPrice(mi);
    if (typeof p !== "number") continue;
    if (best == null || p > best) best = p;
  }
  if (best == null) return null;

  const amount = -round2(best * (promo.percent / 100));
  if (amount === 0) return null;
  return { code: key, label: promo.label, amount, promo: key };
}

module.exports = { PROMOS, isHoneycake, computePromoDiscount, resolveMenuItem, unitPrice };
