// Pure billing catalogue. Maps a plan slug → Stripe checkout mode + price-id env
// var, and builds the `billing` block persisted onto a tenant's config.
// Prices themselves live in the Stripe dashboard (env-referenced), never here.
"use strict";

const DAY = 86400000;

const PLAN_CATALOG = {
  trial:   { mode: "payment",      priceEnv: "PRICE_TRIAL",   purchaseType: "trial",        trialDays: 7 },
  monthly: { mode: "subscription", priceEnv: "PRICE_MONTHLY", purchaseType: "subscription" },
  annual:  { mode: "subscription", priceEnv: "PRICE_ANNUAL",  purchaseType: "subscription" },
  onetime: { mode: "payment",      priceEnv: "PRICE_ONETIME", purchaseType: "lifetime" },
};

function planSpec(plan) {
  return (plan && PLAN_CATALOG[plan]) || null;
}

// Build the persisted billing block. `now` is epoch ms (default Date.now()).
function buildBilling({ plan, customerId, subscriptionId, status, now = Date.now() }) {
  const spec = planSpec(plan);
  if (!spec) throw new Error("unknown plan: " + plan);
  const t = typeof now === "number" ? now : new Date(now).getTime();
  const b = {
    provider: "stripe",
    plan,
    purchaseType: spec.purchaseType,
    customerId: customerId || null,
    subscriptionId: subscriptionId || null,
    status: status || "active",
  };
  if (spec.purchaseType === "trial") {
    b.entitlementExpiresAt = new Date(t + spec.trialDays * DAY).toISOString();
  }
  if (spec.purchaseType === "lifetime") {
    b.status = "active";
  }
  return b;
}

module.exports = { PLAN_CATALOG, planSpec, buildBilling };
