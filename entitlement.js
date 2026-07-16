// Pure entitlement gate. Decides whether a tenant may serve its PUBLIC menu.
// OPT-IN BY DATA: a tenant with no `billing` block (every existing tenant —
// Crispy, Bodrum, admin-provisioned) is always active, so this feature never
// changes their behaviour and needs no migration.
"use strict";

function toMs(v) {
  if (v == null) return NaN;
  return typeof v === "number" ? v : new Date(v).getTime();
}

// billing: the tenant's config.billing block (or undefined for legacy tenants)
// now: epoch ms (defaults to Date.now()); passed explicitly by tests + callers
function isActive(billing, now = Date.now()) {
  if (!billing || billing.exempt) return true;            // legacy / admin / exempt
  const t = typeof now === "number" ? now : new Date(now).getTime();
  switch (billing.purchaseType) {
    case "lifetime":
      return true;
    case "trial": {
      const exp = toMs(billing.entitlementExpiresAt);
      return Number.isFinite(exp) && t < exp;
    }
    case "subscription":
      // Stripe status is the source of truth; a failed payment / cancel flips it
      // via webhook → hard-cut. No period-end math (avoids clock-skew false cuts).
      return billing.status === "active" || billing.status === "trialing";
    default:
      return false;
  }
}

module.exports = { isActive };
