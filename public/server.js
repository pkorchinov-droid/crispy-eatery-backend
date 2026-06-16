require("dotenv").config();
// Pin the process timezone to the cafe's local zone so report day-boundaries,
// hourly buckets and date labels are computed in NZ time, not the Render
// container's UTC.  Setting process.env.TZ before Date is used makes Node's
// Date use this zone (getHours/getDate/etc. become Auckland-local).
process.env.TZ = process.env.TZ || "Pacific/Auckland";
const IS_PROD = process.env.NODE_ENV === "production";
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Resend } = require("resend");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3001;
const STAFF_TOKEN = process.env.STAFF_TOKEN || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ""; // comma-separated allowlist; empty = same-origin only
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE === "true";
// /add-items requires the order's billToken by default, locking a tab to the
// device that opened it. This closes unauthenticated bill-inflation: order IDs
// are public (via by-table) and guessable, so a tokenless add let anyone append
// items to a stranger's tab. The customer SPA always creates new orders (its
// add-to-tab path is currently unwired), so this default breaks nothing live.
// Set STRICT_TAB_TOKEN=false to restore the old shared-tab behaviour (only do
// this once a trusted client resends the billToken on add).
const STRICT_TAB_TOKEN = process.env.STRICT_TAB_TOKEN !== "false";
// The "mock" payment provider (and /simulate-payment) skip signature checks and
// can mark orders paid with no real money. They must be EXPLICITLY enabled and
// are never trusted on NODE_ENV alone — an unset NODE_ENV must not open a free
// payment path. Default off → the mock webhook is refused.
const ALLOW_MOCK_PAYMENTS = process.env.ALLOW_MOCK_PAYMENTS === "true";
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// ── Stripe (real online payments) ──────────────────────────
// Online card payment is offered ONLY for the coffee "skip the queue" pickup
// pre-order flow (orderType "pickup-drinks") — never the dine-in / full-food
// QR, which still pays at the counter. The /charge handler enforces that gate.
// Hosted Stripe Checkout: the customer is redirected to Stripe's page (card +
// Apple Pay / Google Pay), so no card data ever touches our SPA or backend.
// Absent STRIPE_SECRET_KEY → the provider is simply unavailable (charges 503),
// so a missing key can never silently fall through to a free order.
let stripeClient = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripeClient = require("stripe")(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) {
  console.warn("[pay] Stripe SDK unavailable:", e && e.message);
}

// ── Self-serve onboarding (Phase 1) ────────────────────────
// Public signup + magic-link sign-in + photo-to-menu import. ANTHROPIC_API_KEY
// powers the menu-photo extractor (absent → manual fallback). AUTH_EMAIL_FROM
// uses the already-verified eatery.crispycatering.com domain. PUBLIC_BASE_URL is
// this backend's external origin (used to build magic links that point back at
// /auth/verify). OWNER_CUSTOMER_ORIGIN is where the customer SPA lives (used to
// build the public ?r=<slug> menu URL). MENU_IMPORT_MODEL picks the model used
// to read a menu photo/PDF.
const AUTH_EMAIL_FROM = process.env.AUTH_EMAIL_FROM || "IT Logistics <login@eatery.crispycatering.com>";
// Neutral platform sender for bill emails when a tenant hasn't set its own
// config.emailFrom — uses the platform's verified domain, never Crispy's brand.
const BILL_EMAIL_FROM = process.env.BILL_EMAIL_FROM || "IT Logistics <bills@eatery.crispycatering.com>";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://crispy-eatery-backend-1.onrender.com";
const OWNER_CUSTOMER_ORIGIN = process.env.OWNER_CUSTOMER_ORIGIN || "https://sparkling-lokum-4e28b8.netlify.app";
const MENU_IMPORT_MODEL = process.env.MENU_IMPORT_MODEL || "claude-sonnet-4-6";

// Secret for signing magic-link tokens. Prefer an explicit AUTH_SECRET; else
// derive a stable one from PLATFORM_ADMIN_TOKEN (so a deployment with an admin
// token gets working auth without a second secret); else "" → auth features
// return 503 rather than minting unsigned links.
function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.PLATFORM_ADMIN_TOKEN) {
    return crypto.createHash("sha256").update("crispy-auth|" + process.env.PLATFORM_ADMIN_TOKEN).digest("hex");
  }
  return "";
}

// ── Supabase mirror (optional persistence layer) ─────────
// The runtime source of truth is still the local JSON file, so all handlers
// stay synchronous.  Supabase is a write-through backup that survives Render's
// ephemeral disk wipe — if it's configured AND the local file is missing on
// boot, we pull from Supabase to seed the file.  Disabled when env vars absent.
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("[storage] Supabase mirroring active");
  } catch (e) {
    console.error("[storage] Supabase init failed:", e.message);
  }
} else {
  console.log("[storage] file-only mode (set SUPABASE_URL + SUPABASE_SERVICE_KEY to enable backup)");
}

// Mirror to Supabase. Returns a promise so destructive ops can await it; never
// rejects (errors are logged) so callers can `await` it safely.
function mirrorToSupabase(key, value) {
  if (!supabase) return Promise.resolve();
  return supabase
    .from("state")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" })
    .then(({ error }) => {
      if (error) console.warn(`[storage] mirror ${key} failed:`, error.message);
    })
    .catch((e) => console.warn(`[storage] mirror ${key} threw:`, e && e.message));
}

// ── Payment provider registry ────────────────────────────
// Each provider exports:
//   name            string identifier (e.g. "stripe", "windcave", "mock")
//   async createIntent({ orderId, amount, currency, metadata, idempotencyKey })
//                   → { id, provider, amount, currency, clientSecret?, hostedUrl?, raw? }
//   verifyWebhook(rawBody, signature, secret)
//                   → { eventType, orderId, transactionId, last4, scheme, method, raw }
//
// `mock` always succeeds — used to build & test the order/webhook flow before
// wiring to a real PSP.  Real providers (stripe.js, windcave.js, worldline.js)
// can be added to the registry without touching the route handlers.
const PAYMENT_PROVIDERS = {
  mock: {
    name: "mock",
    skipSignature: true, // mock does NOT verify HMAC — must be disabled in production
    async createIntent({ orderId, amount, currency, metadata }) {
      const id = "pi_mock_" + crypto.randomBytes(8).toString("hex");
      return {
        id, provider: "mock",
        amount, currency,
        // Embedded providers (e.g. Stripe Elements) return a client secret the
        // SPA uses to confirm in-place.
        clientSecret: id + "_secret_" + crypto.randomBytes(6).toString("hex"),
        // Redirect-style providers (e.g. Windcave PxPay) return a URL.  Mock
        // gives both so we can test either rendering path.
        hostedUrl: `/dashboard/mock-pay.html?intent=${id}&order=${encodeURIComponent(orderId)}`,
        raw: { mock: true, metadata },
      };
    },
    verifyWebhook(rawBody, _signature, _secret) {
      // Mock skips HMAC. Real providers MUST verify before trusting payload.
      const body = typeof rawBody === "string" ? JSON.parse(rawBody) : JSON.parse(rawBody.toString("utf8"));
      const meta = (body.data && body.data.metadata) || {};
      return {
        eventType: body.eventType || body.type || "payment.succeeded",
        orderId: body.orderId || meta.orderId,
        billToken: body.billToken || meta.billToken, // echoed from createIntent metadata
        transactionId: body.transactionId || ("tx_mock_" + crypto.randomBytes(6).toString("hex")),
        last4: body.last4 || "4242",
        scheme: body.scheme || "visa",
        method: body.method || "card",
        raw: body,
      };
    },
  },

  // Real provider — hosted Stripe Checkout (redirect). Used only for coffee
  // pickup pre-orders (gated in /charge). createIntent returns a `hostedUrl`
  // the SPA redirects to; Stripe sends a signed `checkout.session.completed`
  // webhook back, verified with WEBHOOK_SECRET_STRIPE.
  stripe: {
    name: "stripe",
    // NOT skipSignature → webhooks are HMAC-verified and it's allowed in prod.
    async createIntent({ orderId, amount, currency, idempotencyKey, metadata, returnUrl, label }) {
      if (!stripeClient) throw new Error("Stripe not configured (set STRIPE_SECRET_KEY)");
      const base = String(returnUrl || "");
      const sep = base.includes("?") ? "&" : "?";
      const back = (state) =>
        base + sep + "checkout=" + state + "&order=" + encodeURIComponent(orderId);
      const session = await stripeClient.checkout.sessions.create(
        {
          mode: "payment",
          // 'card' surfaces Apple Pay / Google Pay automatically on supported devices.
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: String(currency || "NZD").toLowerCase(),
                product_data: { name: label || ("Order " + orderId) },
                unit_amount: Math.round(Number(amount) * 100), // dollars → cents
              },
              quantity: 1,
            },
          ],
          // Round-trip our ids back to the webhook on BOTH the session and its
          // payment intent so verifyWebhook can resolve the order either way.
          metadata,
          payment_intent_data: { metadata },
          success_url: back("success"),
          cancel_url: back("cancel"),
        },
        { idempotencyKey }
      );
      return {
        id: session.payment_intent || session.id,
        provider: "stripe",
        amount,
        currency,
        clientSecret: null,
        hostedUrl: session.url, // SPA redirects the customer here
        raw: { sessionId: session.id },
      };
    },
    verifyWebhook(rawBody, signature, secret) {
      if (!stripeClient) throw new Error("Stripe not configured");
      // Throws on a bad/absent signature → the route returns 400.
      const evt = stripeClient.webhooks.constructEvent(rawBody, signature, secret);
      const obj = (evt.data && evt.data.object) || {};
      const meta = obj.metadata || {};
      let eventType;
      if (evt.type === "checkout.session.completed") {
        // Card (sync) Checkout is 'paid' at completion; async methods may not be.
        eventType = obj.payment_status === "paid" ? "payment.succeeded" : "payment.pending";
      } else if (evt.type === "checkout.session.async_payment_succeeded") {
        eventType = "payment.succeeded";
      } else if (
        evt.type === "checkout.session.async_payment_failed" ||
        evt.type === "checkout.session.expired" ||
        evt.type === "payment_intent.payment_failed"
      ) {
        eventType = "payment.failed";
      } else {
        // Anything else (incl. charge.refunded — a Charge carries no order
        // metadata synchronously) is left unmapped → the route 200s without
        // acting. Refunds are handled manually by staff.
        eventType = evt.type;
      }
      // Captured amount in the smallest unit (cents) → dollars, for the
      // amount-equality check in the route handler.
      const cents = obj.amount_total != null ? obj.amount_total : obj.amount;
      const amount = cents != null ? Number(cents) / 100 : null;
      const pi = obj.payment_intent;
      return {
        eventType,
        orderId: meta.orderId,
        billToken: meta.billToken, // echoed from createIntent metadata
        transactionId: (typeof pi === "string" ? pi : pi && pi.id) || obj.id,
        amount,
        // last4 / scheme aren't on the session payload synchronously; left null
        // (the GST receipt shows "PAID ONLINE", which doesn't need them).
        last4: null,
        scheme: null,
        method: "card",
        raw: evt,
      };
    },
  },
};
function getPaymentProvider(name) {
  const p = PAYMENT_PROVIDERS[name];
  if (!p) throw new Error("Unknown payment provider: " + name);
  return p;
}

// In-process guard: order IDs with a charge currently being created. Stops two
// concurrent /charge calls from both reaching the PSP and minting duplicate,
// independently-chargeable intents for one order.
const chargeInFlight = new Set();

// Pull a key from Supabase.  Used at boot to seed local files after a wipe.
async function pullFromSupabase(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("state").select("value").eq("key", key).maybeSingle();
    if (error) { console.warn(`[storage] pull ${key} failed:`, error.message); return null; }
    return data ? data.value : null;
  } catch (e) {
    console.warn(`[storage] pull ${key} threw:`, e.message);
    return null;
  }
}

if (!STAFF_TOKEN) {
  console.warn(
    "[boot] STAFF_TOKEN is not set. Staff endpoints (/orders, /customers, PATCH, add-items, DELETE) will refuse all requests. Set STAFF_TOKEN in .env to use the dashboard."
  );
}

// ── Middleware ──────────────────────────────────────────────
const allowedOrigins = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
// A hosted-checkout return URL (Stripe success/cancel) must point back at one of
// our own front-ends — never an attacker-supplied origin (open-redirect / token
// exfil guard). Only the origin is validated; the SPA controls the path/query.
function isAllowedReturnUrl(u) {
  try {
    const parsed = new URL(String(u));
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return false;
    return allowedOrigins.includes(parsed.origin);
  } catch (e) {
    return false;
  }
}
app.use(
  cors({
    origin: function (origin, cb) {
      // Same-origin requests (no Origin header) and curl/server-to-server: allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, false);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
// Webhooks must run BEFORE express.json so the handler sees the raw bytes
// (HMAC signature verification needs them).  Each provider's webhook handler
// will JSON.parse the raw body itself after verifying the signature.
app.use("/webhooks", express.raw({ type: "*/*", limit: "1mb" }));
// /signup can carry a full photo-imported menu (up to ~30×60 items) inline, which can
// exceed 64kb; give just that route a larger cap. Everything else stays tight at 64kb.
const jsonStd = express.json({ limit: "64kb" });
const jsonSignup = express.json({ limit: "512kb" });
app.use((req, res, next) => (req.path === "/signup" ? jsonSignup : jsonStd)(req, res, next));

// ── Security headers (lightweight, dependency-free) ────────
// Render and most hosts terminate TLS upstream; trust the first proxy hop so
// req.ip reflects the real client (X-Forwarded-For). This is required for
// per-IP rate limiting — without it every customer behind the cafe's NAT would
// look like one address and throttle each other.
app.set("trust proxy", 1);
app.disable("x-powered-by"); // stop Express stack fingerprinting
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");          // anti-clickjacking for the staff dashboard
  res.set("Referrer-Policy", "no-referrer");   // don't leak a ?token= URL via Referer
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (IS_PROD) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Conservative CSP for the backend-served pages (dashboard/admin/bill). They
  // use inline scripts/styles, so 'unsafe-inline' is required for now; menu
  // images come from Supabase Storage + data URIs. The customer SPA is hosted
  // separately on Netlify and is unaffected by this header.
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https:; " +
      "script-src 'self' 'unsafe-inline'; font-src 'self' https: data:; connect-src 'self' https:; " +
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  next();
});

// ── Rate limiting (in-memory, per-IP, dependency-free) ─────
// Limits are sized generously for a busy cafe (many diners share one NAT IP)
// while still stopping enumeration, brute force, order/email spam and Resend
// cost amplification. Authenticated staff are exempt. Fixed 60s windows per IP
// per rule. For multi-instance deploys, swap this for a shared store (Redis).
const rlBuckets = new Map();
function rateRule(req) {
  const m = req.method;
  const p = req.path;
  if (m === "POST" && p === "/order") return ["order", 30];
  if (m === "POST" && /^\/orders\/[^/]+\/add-items$/.test(p)) return ["add", 30];
  if (m === "POST" && /^\/orders\/[^/]+\/email-bill$/.test(p)) return ["email", 10];
  if (m === "POST" && /^\/orders\/[^/]+\/charge$/.test(p)) return ["charge", 30];
  if (m === "POST" && p.startsWith("/webhooks/")) return ["webhook", 120];
  if (m === "POST" && p === "/groups") return ["gcreate", 10];
  if (m === "POST" && /^\/groups\/[^/]+\/join$/.test(p)) return ["gjoin", 30];
  if (m === "GET" && /^\/groups\/[^/]+$/.test(p)) return ["gget", 40];
  if (m === "GET" && /^\/orders\/by-table\//.test(p)) return ["bytable", 90];
  if (m === "POST" && p === "/signup") return ["signup", 5];
  if (m === "POST" && p === "/auth/request-link") return ["authlink", 5];
  if (m === "POST" && p === "/menu/extract") return ["extract", 5];
  return null;
}
app.use((req, res, next) => {
  const rule = rateRule(req);
  if (!rule) return next();
  const [name, max] = rule;
  // /menu/extract drives real per-call Claude vision spend; the trusted-staff/owner
  // exemption must NOT cover it — otherwise a single free signup's 30-day session would
  // bypass the cap and run up the platform's Anthropic bill. Every other rule keeps the
  // staff exemption. (Also set an Anthropic-side spend cap as a backstop.)
  if (name !== "extract" && isStaffReq(req)) return next();
  const key = name + "|" + (req.ip || "?");
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60000 }; rlBuckets.set(key, b); }
  b.count += 1;
  if (b.count > max) {
    res.set("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  }
  next();
});
// Periodic cleanup so the bucket map can't grow unbounded across many IPs.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rlBuckets) if (now > v.resetAt) rlBuckets.delete(k);
}, 120000).unref();

// ── Auth & tenant-resolution middleware ────────────────────
// Staff routes: the bearer/query token identifies BOTH the user and the tenant.
// We look up which restaurant owns that token and attach its store.
function requireStaff(req, res, next) {
  const t = tenantFromToken(getReqToken(req));
  if (!t) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.tenant = t;
  req.store = tenantStore(t.slug);
  next();
}

// Public routes: resolve the tenant from a valid staff token if present (so the
// backoffice pages, which always carry the token, hit their own data), else
// from the ?r=<slug> query param / X-Tenant header, else the default tenant.
function resolveTenant(req, res, next) {
  if (req.tenant) return next();
  const byToken = tenantFromToken(getReqToken(req));
  if (byToken) {
    req.tenant = byToken;
    req.store = tenantStore(byToken.slug);
    return next();
  }
  const slug = normalizeSlug((req.query && req.query.r) || req.get("x-tenant") || DEFAULT_TENANT);
  const t = getTenant(slug);
  if (!t) return res.status(404).json({ error: "Unknown restaurant" });
  req.tenant = t;
  req.store = tenantStore(t.slug);
  next();
}

// Platform owner (you) — guards the provisioning console. Separate secret from
// any restaurant's staff token.
function requirePlatformAdmin(req, res, next) {
  const want = process.env.PLATFORM_ADMIN_TOKEN || "";
  if (!want) return res.status(503).json({ error: "Platform admin not configured (set PLATFORM_ADMIN_TOKEN)" });
  const tok = getReqToken(req);
  if (!tok || !safeEqual(String(tok), want)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── File mutex (serialize concurrent writes to JSON stores) ─
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

function atomicWriteSync(filePath, content) {
  const tmp = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ══════════════════════════════════════════════════════════
// ── MULTI-TENANT STORAGE ───────────────────────────────────
// ══════════════════════════════════════════════════════════
// Each restaurant ("tenant") gets its own data namespace. On disk that is
// data/<slug>/{orders,menu,groups,customers}.json; in the Supabase mirror it is
// the key "tenant:<slug>:<name>". The runtime source of truth is still the
// local file (handlers stay synchronous); Supabase is the write-through backup
// that survives Render's ephemeral disk wipe. A request resolves to one tenant
// (by staff token, ?r= slug, or the default) and gets a `req.store` whose
// load*/persist* methods read/write only that tenant's namespace.
const DATA_DIR = path.join(__dirname, "data");
const MENU_SEED_FILE = path.join(__dirname, "menu-seed.json");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
// Requests with no ?r= and no staff token fall back to this tenant, so the QR
// codes already printed for the original café keep working unchanged.
const DEFAULT_TENANT = normalizeSlug(process.env.DEFAULT_TENANT || "crispy");
// The single-tenant-era Supabase rows (un-prefixed "orders"/"menu"/…) belong to the
// ORIGINAL café. Pin the legacy-restore fallback to THAT slug — not to whatever
// DEFAULT_TENANT currently is — so renaming the default tenant can never restore the
// founding café's data (incl. customer PII) into a different tenant's namespace.
const LEGACY_TENANT_SLUG = normalizeSlug(process.env.LEGACY_TENANT_SLUG || "crispy");

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[storage] read " + path.basename(file) + ":", e.message);
  }
  return fallback;
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  atomicWriteSync(file, JSON.stringify(value, null, 2));
}
function emptyMenu() {
  return { version: 1, updatedAt: new Date().toISOString(), categoryOrder: [], categories: {} };
}
function tKey(slug, name) { return "tenant:" + slug + ":" + name; }

// Factory: a per-tenant store with the same load*/persist* surface the handlers
// already use, so call-sites stay `store.loadOrders()` etc.
function tenantStore(slug) {
  const dir = path.join(DATA_DIR, slug);
  const ordersFile = path.join(dir, "orders.json");
  const menuFile = path.join(dir, "menu.json");
  const groupsFile = path.join(dir, "groups.json");
  const customersFile = path.join(dir, "customers.json");
  return {
    slug,
    loadOrders() { const a = readJson(ordersFile, []); return Array.isArray(a) ? a : []; },
    persistOrders(orders) {
      writeJson(ordersFile, orders);
      // Strip ephemeral dedup state from the backup copy (not worth mirroring).
      const forBackup = orders.map((o) => { const { _lastAddHash, _lastAddAt, ...rest } = o; return rest; });
      return mirrorToSupabase(tKey(slug, "orders"), forBackup);
    },
    loadMenu() {
      // The default tenant seeds its first menu from the shipped menu-seed.json;
      // every other restaurant starts empty and is filled via the admin UI.
      if (!fs.existsSync(menuFile) && slug === DEFAULT_TENANT && fs.existsSync(MENU_SEED_FILE)) {
        try {
          ensureDir(dir);
          atomicWriteSync(menuFile, fs.readFileSync(MENU_SEED_FILE, "utf8"));
          console.log("[menu] seeded " + slug + " menu from menu-seed.json");
        } catch (e) { console.error("[menu] seed failed:", e.message); }
      }
      const m = readJson(menuFile, null);
      return (m && typeof m === "object") ? m : emptyMenu();
    },
    persistMenu(menu) {
      menu.version = (menu.version || 0) + 1;
      menu.updatedAt = new Date().toISOString();
      writeJson(menuFile, menu);
      return mirrorToSupabase(tKey(slug, "menu"), menu);
    },
    loadGroups() { const a = readJson(groupsFile, []); return Array.isArray(a) ? a : []; },
    persistGroups(groups) { writeJson(groupsFile, groups); return mirrorToSupabase(tKey(slug, "groups"), groups); },
    loadCustomers() { const a = readJson(customersFile, []); return Array.isArray(a) ? a : []; },
    persistCustomers(customers) { writeJson(customersFile, customers); return mirrorToSupabase(tKey(slug, "customers"), customers); },
  };
}

// ── Tenant registry ────────────────────────────────────────
// One row per restaurant: { slug, name, config, staffTokenHash, createdAt }.
// Stored as data/tenants.json + mirrored to Supabase under the key "tenants".
// config carries everything that used to be hardcoded for Crispy (branding,
// surcharge, GST rate, currency, timezone, email sender, feature flags).
// The neutral platform-default accent for a brand-new tenant that hasn't chosen
// a colour. NOT Crispy's terracotta — a tenant must never inherit Crispy's
// identity by default. Crispy sets its own #c25a3a in ensureDefaultTenant().
const PLATFORM_DEFAULT_THEME = "#475569"; // slate

function baseConfig() {
  return {
    name: "Restaurant",
    established: "",       // masthead tagline e.g. "Est. 2014" ("" hides it)
    themeColor: PLATFORM_DEFAULT_THEME,
    palette: {},          // optional deep theming: { ink, surface, card, line, muted, brand2, success }; empty → SPA neutral defaults
    logoUrl: null,
    heroUrl: "",          // welcome-screen cover image ("" → themed gradient)
    address: "",          // welcome screen + tax receipt ("" hides it)
    phone: "",
    hours: {},            // { display, open, close, pickupOpen, pickupClose } — all optional strings
    currency: "$",        // display symbol
    currencyCode: "NZD",  // ISO code for payment intents
    gstRate: 0.15,        // tax-inclusive rate; receipt GST = total * rate/(1+rate)
    gstNumber: "",        // tax id printed on the receipt ("" → hide the GST block)
    legalName: "",        // legal entity on the receipt (falls back to name)
    locale: "en-NZ",
    timezone: "Pacific/Auckland",
    emailFrom: "",        // "Name <addr@domain>"; empty → generic platform sender
    surcharge: {},        // category slug → dollars added on the online menu
    surchargeDefault: 0,  // applied to categories not in the map
    drinkCategories: [],  // category slugs routed to the barista + eligible for drink pickup
    dessertCategory: "",  // category slug for the dessert-upsell nudge ("" → no nudge)
    i18n: {},             // { enabled, languages:[{code,label}], dictionary:{code:{key:val}} }
    receipt: {},          // { collectible, fortunes:[], wifi, footerNote }
    printerStations: {},  // station → LAN IP (food/drinks/expo/receipt); empty → no station printing
    features: { groups: true, preorder: true, printing: true, dessertNudge: false, drinksPreorder: false, i18n: false, collectibleReceipt: false, stationPrinting: false, poweredBy: true },
  };
}
// Object-valued config keys that DEEP-merge a stored partial onto the defaults
// (so e.g. an uploaded { hours:{display} } keeps the other default hours keys).
const CONFIG_DEEP_KEYS = ["surcharge", "features", "hours", "palette", "i18n", "receipt", "printerStations"];
function mergeConfig(stored) {
  stored = stored || {};
  const b = baseConfig();
  // Copy only DEFINED scalar/array overrides so a partial config (or an explicit
  // `undefined`) never wipes a default. Known object keys deep-merge below.
  for (const k of Object.keys(stored)) {
    if (CONFIG_DEEP_KEYS.includes(k)) continue;
    if (stored[k] !== undefined) b[k] = stored[k];
  }
  for (const k of CONFIG_DEEP_KEYS) {
    if (stored[k] && typeof stored[k] === "object") b[k] = Object.assign({}, b[k], stored[k]);
  }
  return b;
}
const TENANTS = new Map(); // slug → { slug, name, config, staffTokenHash, createdAt }
function hashToken(tok) { return crypto.createHash("sha256").update(String(tok)).digest("hex"); }
function normalizeSlug(s) {
  // Slugify: spaces/underscores → hyphens, drop the rest, collapse/trim hyphens.
  // Idempotent (safe to apply on both write and lookup): "Joe's Diner" →
  // "joes-diner", and "joes-diner" → "joes-diner".
  return String(s || "")
    .toLowerCase().trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
function loadTenantsIntoCache() {
  const obj = readJson(TENANTS_FILE, {}) || {};
  TENANTS.clear();
  for (const slug of Object.keys(obj)) {
    const rec = obj[slug] || {};
    TENANTS.set(slug, {
      slug,
      name: rec.name || slug,
      config: mergeConfig(rec.config),
      staffTokenHash: rec.staffTokenHash || "",
      createdAt: rec.createdAt || null,
    });
  }
}
function tenantsToDisk() {
  const o = {};
  for (const t of TENANTS.values()) {
    o[t.slug] = { name: t.name, config: t.config, staffTokenHash: t.staffTokenHash, createdAt: t.createdAt };
  }
  return o;
}
function persistTenants() {
  const snap = tenantsToDisk();
  writeJson(TENANTS_FILE, snap);
  return mirrorToSupabase("tenants", snap);
}
function getTenant(slug) { return TENANTS.get(normalizeSlug(slug)) || null; }
function allTenants() { return [...TENANTS.values()]; }
function saveTenant(rec) {
  rec.config = mergeConfig(rec.config);
  TENANTS.set(rec.slug, rec);
  persistTenants();
  return rec;
}
// Resolve a tenant from a staff token (sha256 + timing-safe compare across the
// handful of tenants). The token IS the tenant identity for staff requests.
function findTenantByToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  for (const t of TENANTS.values()) {
    if (t.staffTokenHash && safeEqual(h, t.staffTokenHash)) return t;
  }
  return null;
}
// Boot fallback: if no tenants exist yet (fresh checkout, migration not run),
// materialize the default café from the legacy STAFF_TOKEN + menu-seed so the
// app works out of the box. The migration script is only needed to carry over
// existing production data.
// Crispy's full identity — the values that USED to be hardcoded across the
// shared SPA / dashboard / receipt code. Living here (config) is what lets the
// shared files be neutral while Crispy stays byte-identical. Used by both the
// fresh-install creator AND the production backfill below.
const CRISPY_DEFAULTS = {
  name: "Crispy Eatery",
  established: "Est. 2014",
  themeColor: "#c25a3a",                 // Crispy keeps its terracotta (platform default is now neutral slate)
  palette: { ink: "#2b1f17", brand2: "#7a8362", success: "#7a8362" }, // warm-black chrome + sage accents
  address: "341 Remuera Road",
  hours: { display: "7 am — 3:30 pm · daily", open: "7:00", close: "15:30", pickupOpen: "7:00", pickupClose: "15:30" },
  gstNumber: "136-528-536",
  legalName: "Twopeople Ltd",
  drinkCategories: ["coffee", "tea", "signature"],
  dessertCategory: "desserts",
  printerStations: { food: "192.168.1.160", drinks: "192.168.1.76", expo: "192.168.1.210", receipt: "192.168.1.66" },
  surcharge: {},          // no per-dish online cut (owner removed it 2026-06-16; live tenant zeroed via PATCH /admin/tenants/crispy)
  surchargeDefault: 0,
  emailFrom: "Crispy Eatery <bills@eatery.crispycatering.com>",
  // Crispy keeps every bespoke flow it ships today; new tenants start with the clean core.
  features: { groups: true, preorder: true, printing: true, dessertNudge: true, drinksPreorder: true, i18n: true, collectibleReceipt: true, stationPrinting: true, poweredBy: true },
};
function ensureDefaultTenant() {
  if (TENANTS.size > 0) return;
  const cfg = mergeConfig(CRISPY_DEFAULTS);
  saveTenant({
    slug: DEFAULT_TENANT,
    name: "Crispy Eatery",
    config: cfg,
    staffTokenHash: STAFF_TOKEN ? hashToken(STAFF_TOKEN) : "",
    createdAt: new Date().toISOString(),
  });
  console.log("[tenant] auto-created default tenant '" + DEFAULT_TENANT + "'" + (STAFF_TOKEN ? "" : " (no STAFF_TOKEN → its dashboard is locked until a token is set)"));
}

// Production migration: the LIVE Crispy tenant predates the config keys that used
// to be hardcoded (palette, address, hours, GST id, drink/dessert categories,
// printer IPs, bespoke feature flags). ensureDefaultTenant() never runs for it
// (it already exists), so backfill any of those keys that are still empty —
// without ever overwriting a value the owner has actually set. Idempotent.
function backfillDefaultTenantConfig() {
  const t = getTenant(DEFAULT_TENANT);
  if (!t) return;
  const c = t.config;
  const isEmpty = (v) =>
    v == null || v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  let changed = false;
  for (const k of ["palette", "address", "hours", "gstNumber", "legalName", "drinkCategories", "dessertCategory", "printerStations"]) {
    if (isEmpty(c[k]) && !isEmpty(CRISPY_DEFAULTS[k])) { c[k] = CRISPY_DEFAULTS[k]; changed = true; }
  }
  // themeColor: only restore if it's still the neutral platform default (an owner
  // would never deliberately pick the exact platform slate).
  if (c.themeColor === PLATFORM_DEFAULT_THEME) { c.themeColor = CRISPY_DEFAULTS.themeColor; changed = true; }
  // Bespoke flows Crispy already runs: enable unless explicitly turned off.
  for (const f of ["dessertNudge", "drinksPreorder", "i18n", "collectibleReceipt", "stationPrinting"]) {
    if (c.features[f] !== true) { c.features[f] = true; changed = true; }
  }
  if (changed) {
    saveTenant(t);
    console.log("[tenant] backfilled '" + DEFAULT_TENANT + "' config with bespoke defaults (production migration)");
  }
}

// ══════════════════════════════════════════════════════════
// ── OWNER ACCOUNTS + MAGIC-LINK AUTH (self-serve) ──────────
// ══════════════════════════════════════════════════════════
// Mirrors the TENANTS pattern so all lookups stay SYNCHRONOUS: the runtime
// source of truth is an in-memory object, persisted to data/auth.json and
// mirrored to Supabase under the key "auth". An owner SESSION token works
// anywhere a tenant STAFF token works, scoped to that owner's own café.
//   owners[email]   = { email, name, tenants:[slug], createdAt, lastLoginAt }
//   sessions[hash]  = { email, slug, exp }   (hash = sha256 of the session token)
//   usedMagic[jti]  = exp                     (single-use magic-link guard)
const AUTH = { owners: {}, sessions: {}, usedMagic: {} };
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
function pruneAuth() {
  const now = Date.now();
  for (const k of Object.keys(AUTH.sessions)) {
    const rec = AUTH.sessions[k];
    if (!rec || rec.exp <= now) delete AUTH.sessions[k];
  }
  for (const j of Object.keys(AUTH.usedMagic)) {
    if (!(AUTH.usedMagic[j] > now)) delete AUTH.usedMagic[j];
  }
}
function loadAuthIntoCache() {
  const obj = readJson(AUTH_FILE, {}) || {};
  AUTH.owners = obj.owners || {};
  AUTH.sessions = obj.sessions || {};
  AUTH.usedMagic = obj.usedMagic || {};
  pruneAuth();
}
function persistAuth() {
  pruneAuth();
  writeJson(AUTH_FILE, AUTH);
  return mirrorToSupabase("auth", AUTH);
}

// base64url encode a Buffer (no padding, URL-safe).
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Sign a short-lived (15 min) single-use magic token: payload.signature, both
// base64url, signature = HMAC-SHA256(payload, authSecret()).
function signMagicToken(email) {
  if (!authSecret()) return null; // no secret → refuse to mint (empty-key HMAC is forgeable)
  const payload = { e: email, exp: Date.now() + 900000, j: crypto.randomBytes(9).toString("hex") };
  const p = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.createHmac("sha256", authSecret()).update(p).digest());
  return p + "." + sig;
}
function verifyMagicToken(tok) {
  try {
    if (!authSecret()) return null; // no secret → reject all (empty-key HMAC is forgeable)
    const parts = String(tok || "").split(".");
    if (parts.length !== 2) return null;
    const [p, sig] = parts;
    const want = b64url(crypto.createHmac("sha256", authSecret()).update(p).digest());
    if (!safeEqual(sig, want)) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    if (AUTH.usedMagic[payload.j]) return null; // single-use
    return { email: payload.e, jti: payload.j, exp: payload.exp };
  } catch {
    return null;
  }
}
function buildMagicLink(email) {
  return PUBLIC_BASE_URL + "/auth/verify?token=" + encodeURIComponent(signMagicToken(email));
}
// Create a 30-day session bound to one owner + one café. Only the sha256 of the
// token is stored; the raw token is returned to the caller and never logged.
function createSession(email, slug) {
  const token = crypto.randomBytes(32).toString("hex");
  AUTH.sessions[hashToken(token)] = { email, slug, exp: Date.now() + 2592000000 };
  persistAuth();
  return token;
}
function sessionFromToken(tok) {
  if (!tok) return null;
  const rec = AUTH.sessions[hashToken(tok)];
  return (rec && rec.exp > Date.now()) ? rec : null;
}
function deleteSession(tok) {
  delete AUTH.sessions[hashToken(tok)];
  persistAuth();
}
// Resolve a token to a tenant: a tenant STAFF token first (existing behaviour),
// else an owner SESSION token scoped to that owner's café. This is what lets an
// owner session act as staff for ONLY its own tenant.
function tenantFromToken(token) {
  const t = findTenantByToken(token);
  if (t) return t;
  const s = sessionFromToken(token);
  return (s && s.slug) ? getTenant(s.slug) : null;
}
// Owner-only middleware (the owner console's authenticated calls).
function requireOwner(req, res, next) {
  const s = sessionFromToken(getReqToken(req));
  if (!s) return res.status(401).json({ error: "Unauthorized" });
  req.ownerEmail = s.email;
  req.ownerSlug = s.slug;
  next();
}
// Email a magic link. No-op when Resend isn't configured (callers also surface a
// devLink for local testing). Never logs the raw token; masks the address.
async function sendMagicEmail(email, kind) {
  if (!resend) return;
  const link = buildMagicLink(email);
  const subject = kind === "welcome"
    ? "Welcome to IT Logistics — your café is live"
    : "Your IT Logistics sign-in link";
  const text = [
    kind === "welcome"
      ? "Your café is set up and ready. Sign in to your dashboard with the link below:"
      : "Use the link below to sign in to your IT Logistics dashboard:",
    "",
    link,
    "",
    "This link works once and expires in 15 minutes.",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");
  try {
    await resend.emails.send({ from: AUTH_EMAIL_FROM, to: [email], subject, text });
    console.log(`[auth] magic link (${kind}) sent → ${maskPII(email)}`);
  } catch (e) {
    console.error(`[auth] magic link send failed for ${maskPII(email)}:`, e && e.message);
  }
}

// ── Shared provisioning helper ─────────────────────────────
// Used by BOTH POST /admin/tenants and POST /signup so the slug-derivation,
// token minting, tenant save and menu seeding live in one place. onConflict:
//   "error"  → throw a 409-carrying error when the slug is taken
//   "suffix" → append -2, -3, … until a free slug is found
// Returns { slug, name, staffToken } (the staffToken is shown once).
// Callers spread the config overrides at the TOP level of the argument object
// (e.g. { ...configOverridesFromBody(b), name, slug, … }); the rest pattern
// gathers them back into configOverrides, alongside an explicit configOverrides
// key if one is passed directly.
function createTenant({ name, slug, menu, categories, onConflict, configOverrides, ...rest }) {
  configOverrides = Object.assign({}, rest, configOverrides || {});
  let s = normalizeSlug(slug || name);
  if (!s) { const e = new Error("A slug or name is required"); e.status = 400; throw e; }
  if (getTenant(s)) {
    if (onConflict === "suffix") {
      let n = 2;
      let cand = normalizeSlug(s + "-" + n);
      while (getTenant(cand)) { n += 1; cand = normalizeSlug(s + "-" + n); }
      s = cand;
    } else {
      const e = new Error("A restaurant with that slug already exists: " + s);
      e.status = 409;
      throw e;
    }
  }
  const cfg = mergeConfig(Object.assign({}, configOverrides || {}, { name }));
  const staffToken = crypto.randomBytes(24).toString("hex");
  withWriteLock(() => {
    saveTenant({ slug: s, name, config: cfg, staffTokenHash: hashToken(staffToken), createdAt: new Date().toISOString() });
    // Seed the menu exactly as POST /admin/tenants does: a full supplied menu,
    // else a skeleton from a category list, else empty.
    const seedMenu = (menu && typeof menu === "object" && menu.categories)
      ? menu
      : (Array.isArray(categories) && categories.length ? menuFromCategoryList(categories) : emptyMenu());
    tenantStore(s).persistMenu(seedMenu);
    console.log(`[tenant] provisioned '${s}' (${name})`);
  });
  return { slug: s, name, staffToken };
}

function nextOrderId(orders) {
  // IDs must be unique across the WHOLE order log, never reset per day.
  // orders.json survives across midnight, so a per-day counter regenerated
  // #001 every morning. The dashboard and PATCH /orders/:id address orders by
  // id, so duplicate #001s collapsed into a single card and PATCH always hit
  // the oldest match — orders "reappeared" on every poll and could never be
  // cleared. Take the max over ALL orders so the number only ever climbs.
  let max = 0;
  for (const o of orders) {
    const m = typeof o.id === "string" && o.id.match(/^#(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `#${String(max + 1).padStart(3, "0")}`;
}

// ── Group (corporate pre-order) helpers ────────────────────
// A "group" is one booking (company + date + arrival time) that many people join
// by code and add their own NAMED order to — one combined bill. Group storage
// now lives in the per-tenant store (req.store.loadGroups/persistGroups).
const GROUP_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
function genGroupCode(groups) {
  const taken = new Set(groups.map((g) => g.code));
  for (let tries = 0; tries < 80; tries++) {
    let c = "";
    for (let i = 0; i < 6; i++) c += GROUP_CODE_CHARS[crypto.randomInt(GROUP_CODE_CHARS.length)];
    if (!taken.has(c)) return c;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function groupTotal(g) { return clampMoney((g.members || []).reduce((s, m) => s + (Number(m.total) || 0), 0)); }
function groupSurcharge(g) { return clampMoney((g.members || []).reduce((s, m) => s + (Number(m.onlineSurcharge) || 0), 0)); }
function publicGroupView(g) {
  return {
    code: g.code, company: g.company, date: g.date, arrivalTime: g.arrivalTime,
    status: g.status, guestCount: g.guestCount,
    organizerName: (g.organizer && g.organizer.name) || "",
    memberCount: (g.members || []).length,
    // Public view exposes only per-member item counts, not names — a guessed
    // code must not hand a stranger the company's attendee roster. Staff get
    // names via fullGroupView (token-gated).
    members: (g.members || []).map((m) => ({ itemCount: (m.items || []).reduce((n, i) => n + (i.qty || 1), 0) })),
    total: groupTotal(g),
  };
}
function fullGroupView(g) { return Object.assign({}, g, { total: groupTotal(g), onlineSurcharge: groupSurcharge(g) }); }
// Extract a bearer/query staff token from a request (no tenant resolution).
function getReqToken(req) {
  const h = req.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : (req.query && req.query.token) || "";
}
// "Is this request from staff of ANY tenant?" — used by the rate limiter (runs
// before tenant resolution) to exempt trusted staff.
function isStaffReq(req) {
  return !!tenantFromToken(getReqToken(req));
}
function validGroupDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const min = new Date(today.getTime() - 86400000);  // small tz slack
  const max = new Date(today); max.setDate(max.getDate() + 180);
  return d >= min && d <= max;
}
function validGroupTime(v) { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }

// ── Menu helpers ───────────────────────────────────────────
// Menu storage now lives in the per-tenant store (req.store.loadMenu /
// persistMenu). The default tenant seeds its first menu from menu-seed.json;
// other restaurants start empty and are filled via the admin UI.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

function findItem(menu, id) {
  for (const slug of menu.categoryOrder) {
    const cat = menu.categories[slug];
    if (!cat || !Array.isArray(cat.items)) continue;
    const idx = cat.items.findIndex((it) => it && it.id === id);
    if (idx >= 0) return { categorySlug: slug, category: cat, index: idx, item: cat.items[idx] };
  }
  return null;
}

// Build a starter menu skeleton (empty categories) from a list of names or
// {title, subtitle} — used when provisioning a new restaurant so its owner can
// start adding items in the existing menu-admin screen immediately.
function menuFromCategoryList(list) {
  const menu = emptyMenu();
  if (!Array.isArray(list)) return menu;
  for (const c of list) {
    const title = (typeof c === "string" ? c : (c && c.title) || "").trim();
    if (!title) continue;
    let slug = slugify(c && c.slug ? c.slug : title);
    let n = 1;
    while (menu.categories[slug]) { n += 1; slug = slugify(title) + "-" + n; }
    menu.categoryOrder.push(slug);
    menu.categories[slug] = {
      title: title.slice(0, 40),
      subtitle: (c && c.subtitle) ? String(c.subtitle).slice(0, 80) : "",
      items: [],
    };
  }
  return menu;
}

// ── Customer email helpers ─────────────────────────────────
// Customer storage now lives in the per-tenant store; saveCustomerEmail takes
// the resolved req.store so a returning-customer record lands in the right
// restaurant's namespace.
function saveCustomerEmail(store, email, orderId, tableNumber, total) {
  const customers = store.loadCustomers();
  const existing = customers.find((c) => c.email === email);
  if (existing) {
    // Idempotent per order: re-emailing the same bill (customer taps "email me the
    // bill" twice, or replays the link) must not double-count visits/spend in the CRM.
    if (!existing.orders.includes(orderId)) {
      existing.visits += 1;
      existing.totalSpent += total;
      existing.orders.push(orderId);
    }
    existing.lastVisit = new Date().toISOString();
  } else {
    customers.push({
      email,
      firstVisit: new Date().toISOString(),
      lastVisit: new Date().toISOString(),
      visits: 1,
      totalSpent: total,
      orders: [orderId],
    });
  }
  store.persistCustomers(customers);
  console.log(`[customers] Saved ${maskPII(email)} (${existing ? "returning" : "new"} customer)`);
}

// ── Validators ────────────────────────────────────────────
const VALID_STATUSES = new Set([
  "received",
  "preparing",
  "ready",
  "picked_up",
  "done",
]);
const VALID_PAYMENT_STATUSES = new Set([
  "unpaid",
  "pending",
  "paid",
  "failed",
  "refunded",
]);
const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;

function toFiniteNumber(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampMoney(n) {
  // 0 ≤ price ≤ 9999.99, integer-cent precision.
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 9999.99) return 9999.99;
  return Math.round(n * 100) / 100;
}

function clampQty(n) {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 99) return 99;
  return Math.floor(n);
}

function sanitizeString(s, maxLen) {
  if (typeof s !== "string") return "";
  // Strip control chars (incl. CR/LF used for header-injection-style attacks)
  return s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, maxLen);
}

// Redact most of a PII string for logs — Render's stdout is persisted, so full
// phone numbers / emails should not land there. Keeps a short tail for triage.
function maskPII(s) {
  const v = String(s || "");
  if (!v) return "";
  if (v.includes("@")) {
    const at = v.indexOf("@");
    return v.slice(0, Math.min(2, at)) + "***@" + v.slice(at + 1);
  }
  return v.length <= 3 ? "***" : "***" + v.slice(-3);
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map((item) => {
    const id = typeof (item && item.id) === "string" ? sanitizeString(item.id, 60) : "";
    return {
      // Menu item id, when the client sends one (POST /order does). Kept so the
      // server can price-check against the authoritative menu. undefined (not "")
      // so it's omitted from stored JSON when absent (e.g. /add-items).
      id: id || undefined,
      name: sanitizeString(item && item.name, 120),
      size: sanitizeString(item && item.size, 80),
      qty: clampQty(toFiniteNumber(item && (item.qty != null ? item.qty : item.quantity), 1)),
      price: clampMoney(toFiniteNumber(item && item.price, 0)),
      notes: sanitizeString(item && item.notes, 300),
      // lineId is always server-generated — never trust client input. If a
      // customer harvested a lineId from their own bill (which exposes them)
      // and reused it via /add-items, two rows could collide on dashboard state.
      lineId: crypto.randomBytes(8).toString("hex"),
    };
  });
}

// Authoritative minimum price for a menu item (base price, or cheapest size).
function itemMinPrice(it) {
  if (!it) return null;
  if (typeof it.price === "number") return it.price;
  if (it.sizes && typeof it.sizes === "object") {
    const vals = Object.values(it.sizes).filter((v) => typeof v === "number");
    if (vals.length) return Math.min(...vals);
  }
  return null;
}

// Resolve an order line to its menu item: by id (preferred) or by stripped name.
function findMenuItem(menu, line) {
  if (line.id) {
    const f = findItem(menu, line.id);
    if (f) return f.item;
  }
  if (line.name) {
    const base = String(line.name).replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    for (const slug of (menu.categoryOrder || [])) {
      const cat = menu.categories[slug];
      if (!cat || !Array.isArray(cat.items)) continue;
      const hit = cat.items.find((x) => String(x.name || "").trim().toLowerCase() === base);
      if (hit) return hit;
    }
  }
  return null;
}

// Reject client-supplied prices that fall BELOW the menu's legitimate minimum
// (add-ons/sizes only ever ADD, so the real charged price is always >= min).
// Returns an error string on violation, or null if all items are acceptable.
// When the menu is empty (not yet loaded) validation is skipped so we never
// hard-fail ordering on a cold/missing menu.
function priceViolation(items, menu) {
  if (!menu || !(menu.categoryOrder || []).length) return null;
  for (const it of items) {
    const mi = findMenuItem(menu, it);
    if (!mi) {
      // A client that supplied an id we can't resolve is suspicious — reject.
      // Lines without an id (legacy /add-items) are left alone to avoid breaking
      // the shared-tab flow on a renamed/removed dish.
      if (it.id) return `Unknown menu item: ${it.name || it.id}`;
      continue;
    }
    const min = itemMinPrice(mi);
    if (min != null && it.price < min - 0.01) {
      return `Price too low for "${mi.name}" (minimum $${min.toFixed(2)})`;
    }
  }
  return null;
}

// The category slugs that count as "drinks" for THIS tenant — barista routing
// and pickup-pre-order eligibility both read it from config.drinkCategories.
function drinkCategorySet(cfg) {
  const list = cfg && Array.isArray(cfg.drinkCategories) ? cfg.drinkCategories : [];
  return new Set(list);
}

// Pickup pre-orders are drinks only — every line must resolve (same id-then-name
// matching as findMenuItem, via findItemCategory) to one of the tenant's drink
// categories. Returns an error string on violation, or null. Skipped when the
// menu is empty (same cold-start guard as priceViolation) so a missing menu
// never hard-fails.
function pickupDrinksViolation(items, menu, cfg) {
  if (!menu || !(menu.categoryOrder || []).length) return null;
  const drinks = drinkCategorySet(cfg);
  for (const it of items) {
    const slug = findItemCategory(menu, it);
    if (!slug || !drinks.has(slug)) {
      return `Pickup pre-orders are drinks only — "${it.name || it.id || "item"}" is not a drink`;
    }
    // The stored/printed name is client-supplied; require it to match the item
    // the id resolved to, so a drink id can't smuggle a food label onto tickets.
    if (it.id) {
      const f = findItem(menu, it.id);
      const base = String(it.name || "").replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
      if (f && base && String(f.item.name || "").trim().toLowerCase() !== base) {
        return `Item name mismatch for "${it.name}"`;
      }
    }
  }
  return null;
}

// The dashboard treats the tableNumber sentinel as pickup too — so anything
// that will RENDER as pickup must also pass pickup validation.
function isPickupSentinel(v) {
  return /^\s*pickup\s*$/i.test(typeof v === "string" ? v : "");
}

// Stable hash of an items array — used to dedup near-simultaneous /add-items submits.
function itemsHash(items) {
  const norm = items.map((i) =>
    [i.name, i.size, i.qty, i.price, i.notes].join("|")
  );
  return crypto.createHash("sha256").update(norm.join("\n")).digest("hex").slice(0, 16);
}

// Timing-safe string compare for short tokens (24-byte hex = 48 chars).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Per-order bill token check. Legacy orders without billToken: token not required.
// New orders (with billToken): require ?t= or body.token to match.
function checkBillToken(order, req) {
  if (!order.billToken) return true; // legacy, grandfathered
  const supplied =
    (req.query && typeof req.query.t === "string" && req.query.t) ||
    (req.body && typeof req.body.token === "string" && req.body.token) ||
    "";
  return safeEqual(supplied, order.billToken);
}

// ── Health check (platform-level) ──────────────────────────
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    mode: "multi-tenant",
    tenants: TENANTS.size,
    note: "Doshii integration pending — orders stored locally",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "multi-tenant", tenants: TENANTS.size });
});

// ══════════════════════════════════════════════════════════
// ── TENANTS: public branding + platform-admin provisioning ─
// ══════════════════════════════════════════════════════════

// Public branding config the customer SPA fetches on boot to rebrand itself
// (name, theme colour, logo, currency, GST rate). No secrets — safe to expose.
app.get("/tenant/:slug", (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t) return res.status(404).json({ error: "Unknown restaurant" });
  const c = t.config || {};
  res.set("Cache-Control", "no-cache");
  res.json({
    slug: t.slug,
    name: c.name || t.name,
    established: c.established || "",
    themeColor: c.themeColor || PLATFORM_DEFAULT_THEME,
    palette: c.palette || {},
    logoUrl: c.logoUrl || null,
    heroUrl: c.heroUrl || "",
    address: c.address || "",
    phone: c.phone || "",
    hours: c.hours || {},
    currency: c.currency || "$",
    currencyCode: c.currencyCode || "NZD",
    gstRate: typeof c.gstRate === "number" ? c.gstRate : 0.15,
    locale: c.locale || "en-NZ",
    timezone: c.timezone || "Pacific/Auckland",
    drinkCategories: Array.isArray(c.drinkCategories) ? c.drinkCategories : [],
    dessertCategory: c.dessertCategory || "",
    i18n: c.i18n || {},
    receipt: c.receipt || {},
    features: c.features || {},
  });
});

// The provisioning console — a static form (no secrets in the HTML; it prompts
// for the platform token and uses it for the API calls below).
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin-console.html")));

// The public self-serve owner console — the signup + sign-in + post-login home
// screen. Served by the backend itself (same-origin) so the owner-session calls
// to /me, /dashboard, /qr-pack, /menu/extract need no extra CORS entries. /start
// is the marketing-friendly alias; /owner is where /auth/verify lands.
app.get("/start", (_req, res) => res.sendFile(path.join(__dirname, "public", "owner-console.html")));
app.get("/owner", (_req, res) => res.sendFile(path.join(__dirname, "public", "owner-console.html")));

// Admin view of a tenant (never leaks the token, only whether one is set).
function tenantAdminView(t) {
  return { slug: t.slug, name: t.name, createdAt: t.createdAt, hasToken: !!t.staffTokenHash, config: t.config };
}
// Fields a platform admin may set on create/update (everything else is derived).
function configOverridesFromBody(b) {
  const o = {};
  for (const k of ["name", "established", "themeColor", "palette", "logoUrl", "heroUrl", "address", "phone", "hours", "currency", "currencyCode", "gstRate", "gstNumber", "legalName", "locale", "timezone", "emailFrom", "surcharge", "surchargeDefault", "drinkCategories", "dessertCategory", "i18n", "receipt", "printerStations", "features"]) {
    if (b[k] !== undefined) o[k] = b[k];
  }
  return o;
}
// Public self-serve signup is UNTRUSTED, so it only gets a safe branding subset.
// Deliberately excluded vs the admin allow-list above: emailFrom (flows into the
// Resend From header → header-injection / sender spoofing), logoUrl (arbitrary
// off-site <img> on the customer menu), surcharge/surchargeDefault, and features
// (e.g. setting poweredBy:false would white-label for free). emailFrom/logoUrl/
// features stay platform-admin-only; the signup route sets ownerEmail +
// features.poweredBy itself, server-side.
function publicConfigOverridesFromBody(b) {
  // Untrusted (public /signup) input: sanitise + validate every field at the trust
  // boundary so XSS-capable / malformed values can never be stored, rather than
  // relying on every downstream renderer to escape perfectly.
  const o = {};
  if (b.name !== undefined) o.name = sanitizeString(b.name, 80);
  if (b.established !== undefined) o.established = sanitizeString(b.established, 60);
  if (b.themeColor !== undefined) o.themeColor = /^#[0-9a-fA-F]{6}$/.test(String(b.themeColor)) ? String(b.themeColor) : PLATFORM_DEFAULT_THEME;
  if (b.currency !== undefined) o.currency = sanitizeString(b.currency, 4);
  if (b.currencyCode !== undefined) o.currencyCode = sanitizeString(b.currencyCode, 8);
  if (b.gstRate !== undefined) { const g = Number(b.gstRate); o.gstRate = Number.isFinite(g) && g >= 0 && g <= 1 ? g : 0.15; }
  if (b.gstNumber !== undefined) o.gstNumber = sanitizeString(b.gstNumber, 30);
  if (b.legalName !== undefined) o.legalName = sanitizeString(b.legalName, 80);
  if (b.address !== undefined) o.address = sanitizeString(b.address, 120);
  if (b.phone !== undefined) o.phone = sanitizeString(b.phone, 30);
  if (b.locale !== undefined) o.locale = sanitizeString(b.locale, 20);
  if (b.timezone !== undefined) o.timezone = sanitizeString(b.timezone, 40);
  return o;
}

// Sanitise a client-supplied menu before persisting it via public /signup (the
// authoritative /menu routes already clamp/cap/sanitise; this path did not). Caps
// counts, slugifies category keys, sanitises all strings, clamps prices, DROPS any
// img/imgUrl (owners add photos later in the editor), and strips proto-pollution keys.
function sanitizeSignupMenu(menu) {
  if (!menu || typeof menu !== "object" || !menu.categories || typeof menu.categories !== "object") return null;
  const out = emptyMenu();
  const order = Array.isArray(menu.categoryOrder) && menu.categoryOrder.length ? menu.categoryOrder : Object.keys(menu.categories);
  for (const rawKey of order.slice(0, 40)) {
    if (rawKey === "__proto__" || rawKey === "constructor" || rawKey === "prototype") continue;
    const cat = menu.categories[rawKey];
    if (!cat || typeof cat !== "object") continue;
    let slug = slugify(cat.slug || rawKey || cat.title || "menu");
    let n = 1; while (out.categories[slug]) { n += 1; slug = slugify(rawKey || cat.title || "menu") + "-" + n; }
    const items = (Array.isArray(cat.items) ? cat.items : []).slice(0, 200).map((it, i) => ({
      id: sanitizeString((it && it.id) || "", 60) || (slug + "-" + (i + 1)),
      name: sanitizeString(it && it.name, 120),
      price: clampMoney(toFiniteNumber(it && it.price, 0)),
      desc: sanitizeString(it && it.desc, 300),
    })).filter((it) => it.name);
    out.categoryOrder.push(slug);
    out.categories[slug] = { title: sanitizeString(cat.title, 40) || "Menu", subtitle: sanitizeString(cat.subtitle, 80), items };
  }
  return out.categoryOrder.length ? out : null;
}

app.get("/admin/tenants", requirePlatformAdmin, (_req, res) => {
  res.json(allTenants().map(tenantAdminView));
});

// Provision a new restaurant. Returns the staff token ONCE (only its hash is
// stored). Seeds an empty menu (or an optional supplied menu) so the owner can
// start editing in the existing /dashboard/menu-admin.html screen.
app.post("/admin/tenants", requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  // Preserve the legacy "name defaults to slug" behaviour: derive the slug the
  // same way createTenant will, then fall back to it for a missing name.
  const preSlug = normalizeSlug(b.slug || b.name || "");
  if (!preSlug) return res.status(400).json({ error: "A slug or name is required" });
  const name = sanitizeString(b.name, 80) || preSlug;
  try {
    const { slug, staffToken } = createTenant({
      ...configOverridesFromBody(b),
      name,
      slug: b.slug,
      menu: b.menu,
      categories: b.categories,
      onConflict: "error",
    });
    res.json({
      success: true,
      slug,
      name,
      staffToken,                                  // SHOW ONCE — not recoverable
      dashboardUrl: `/dashboard?token=${staffToken}`,
      menuAdminUrl: `/dashboard/menu-admin.html?token=${staffToken}`,
      customerQuery: `?r=${slug}`,
      note: "Save the staffToken now — only its hash is stored.",
    });
  } catch (e) {
    if (e && e.status === 409) return res.status(409).json({ error: e.message });
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    console.error("[tenant] provision error:", e && e.message);
    res.status(500).json({ error: "Failed to provision restaurant" });
  }
});

// ══════════════════════════════════════════════════════════
// ── SELF-SERVE SIGNUP + MAGIC-LINK AUTH ───────────────────
// ══════════════════════════════════════════════════════════

// POST /signup — public, rate-limited. One link, owner self-onboards: creates
// the café (via the shared createTenant), opens an owner account, returns a
// 30-day session (so the owner is signed in immediately) and emails a welcome
// magic link. The owner's email is recorded on the tenant and the "powered by"
// footer defaults on.
app.post("/signup", (req, res) => {
  try {
    // No auth secret → magic-link login can't work (request-link 503s, verify rejects
    // all), so an account created now could never sign back in. Refuse rather than
    // mint un-loginable accounts. (Prod has PLATFORM_ADMIN_TOKEN → secret derived.)
    if (authSecret() === "") return res.status(503).json({ error: "Sign-up is temporarily unavailable." });
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    const name = sanitizeString(body.name, 80);
    if (!name) return res.status(400).json({ error: "Your café's name is required." });
    if (AUTH.owners[email]) {
      return res.status(409).json({ error: "You already have a café — sign in instead.", code: "exists" });
    }
    const cfgOv = publicConfigOverridesFromBody(body);
    // ownerEmail + poweredBy are stamped via createTenant's config so they're
    // saved atomically with the tenant. (createTenant's save runs under the
    // write lock, which defers to a microtask, so a getTenant() right after the
    // call would race and return null.) features.poweredBy defaults on; the
    // public override subset can't set it, so self-serve cafés are never
    // white-labelled for free.
    const { slug } = createTenant({
      ...cfgOv,
      ownerEmail: email,
      features: { poweredBy: true },
      name,
      slug: body.slug,
      menu: sanitizeSignupMenu(body.menu),
      categories: body.categories,
      onConflict: "suffix",
    });
    // Open the owner account.
    AUTH.owners[email] = {
      email,
      name,
      tenants: [slug],
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    persistAuth();
    const session = createSession(email, slug);
    try { sendMagicEmail(email, "welcome"); } catch {}
    console.log(`[signup] new café '${slug}' for ${maskPII(email)}`);
    res.json({
      success: true,
      session,
      slug,
      name,
      dashboardUrl: "/dashboard?token=" + session,
      menuAdminUrl: "/dashboard/menu-admin.html?token=" + session,
      qrPackUrl: "/qr-pack?token=" + session,
      customerUrl: OWNER_CUSTOMER_ORIGIN + "/?r=" + slug,
    });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    console.error("[signup] error:", e && e.message);
    res.status(500).json({ error: "Couldn't create your café — please try again." });
  }
});

// POST /auth/request-link — public, rate-limited. ALWAYS responds { ok:true } so
// it never reveals whether an email is registered. ONLY in non-prod does it also
// return a devLink (for local testing without email), and only when a real account
// exists. In production the link is delivered SOLELY via Resend; if Resend is
// unconfigured the route still must NOT hand a sign-in token to the caller — doing
// so is anonymous account takeover — so the operator must fix email delivery.
app.post("/auth/request-link", (req, res) => {
  if (authSecret() === "") return res.status(503).json({ error: "Auth not configured" });
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const out = { ok: true };
  if (EMAIL_RE.test(email) && email.length <= 254 && AUTH.owners[email]) {
    if (resend) sendMagicEmail(email, "login");
    if (!IS_PROD) out.devLink = buildMagicLink(email); // dev-only — NEVER gated on Resend
  }
  res.json(out);
});

// GET /auth/verify — public. Validates the signed single-use magic token; on
// success 302-redirects to /owner#s=<session> (session in the URL FRAGMENT, so
// it never lands in a Referer/server log), else /owner?err=link.
app.get("/auth/verify", (req, res) => {
  const v = verifyMagicToken(req.query.token);
  if (!v) return res.redirect("/owner?err=link");
  const owner = AUTH.owners[v.email];
  if (!owner) return res.redirect("/owner?err=link");
  AUTH.usedMagic[v.jti] = v.exp;       // burn the token (single-use)
  owner.lastLoginAt = new Date().toISOString();
  const session = createSession(v.email, owner.tenants[0]);
  persistAuth();
  return res.redirect("/owner#s=" + session);
});

// POST /auth/logout — owner session. Invalidates the current session.
app.post("/auth/logout", requireOwner, (req, res) => {
  deleteSession(getReqToken(req));
  res.json({ ok: true });
});

// GET /me — owner session. The owner console's "who am I + my café" call.
app.get("/me", requireOwner, (req, res) => {
  const owner = AUTH.owners[req.ownerEmail];
  const t = getTenant(req.ownerSlug);
  if (!t) return res.status(404).json({ error: "Café not found" });
  const c = t.config || {};
  res.json({
    email: req.ownerEmail,
    cafe: {
      slug: t.slug,
      name: t.name,
      config: {
        name: c.name || t.name,
        established: c.established || "",
        themeColor: c.themeColor || "#c25a3a",
        logoUrl: c.logoUrl || null,
        currency: c.currency || "$",
        currencyCode: c.currencyCode || "NZD",
        gstRate: typeof c.gstRate === "number" ? c.gstRate : 0.15,
        features: c.features || {},
      },
      customerUrl: OWNER_CUSTOMER_ORIGIN + "/?r=" + t.slug,
    },
  });
});

// Update a restaurant's config and/or rotate its staff token.
app.patch("/admin/tenants/:slug", requirePlatformAdmin, (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t) return res.status(404).json({ error: "Unknown restaurant" });
  const b = req.body || {};
  const out = { success: true, slug: t.slug };
  withWriteLock(() => {
    if (b.name != null) t.name = sanitizeString(b.name, 80) || t.name;
    t.config = mergeConfig(Object.assign({}, t.config, configOverridesFromBody(b)));
    if (b.name != null) t.config.name = t.name;
    if (b.regenerateToken) {
      const staffToken = crypto.randomBytes(24).toString("hex");
      t.staffTokenHash = hashToken(staffToken);
      out.staffToken = staffToken;
      out.dashboardUrl = `/dashboard?token=${staffToken}`;
    }
    saveTenant(t);
    console.log(`[tenant] updated '${t.slug}'${b.regenerateToken ? " (token rotated)" : ""}`);
  });
  res.json(out);
});

// ── Printable QR pack for a restaurant (platform admin) ────
// Renders a print-ready page of QR codes — one per table — each encoding
// <base>/?r=<slug>&table=<n>. Server-generates the QR PNGs as data URIs so it
// works under the strict CSP (no external scripts needed).
function parseTableList(spec) {
  const s = String(spec || "").trim();
  if (/^\d+$/.test(s)) {
    const n = Math.min(parseInt(s, 10), 300);
    return Array.from({ length: Math.max(n, 0) }, (_, i) => String(i + 1));
  }
  const out = [];
  for (const tok of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) { const z = a; a = b; b = z; }
      for (let i = a; i <= b && out.length < 300; i++) out.push(String(i));
    } else if (/^[A-Za-z0-9]{1,4}$/.test(tok)) {
      out.push(tok);
    }
  }
  return out;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function qrPackHtml(name, slug, themeColor, cards) {
  const safeName = escapeHtml(name);
  const accent = /^#[0-9a-fA-F]{6}$/.test(themeColor || "") ? themeColor : "#c25a3a";
  const cells = cards.map((c) => `
    <div class="card">
      <div class="tnum">Table ${escapeHtml(c.tn)}</div>
      <img src="${c.dataUri}" alt="QR code for table ${escapeHtml(c.tn)}" />
      <div class="rname">${safeName}</div>
      <div class="hint">Scan · Order · Pay at counter</div>
    </div>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeName} — QR codes</title>
<style>
  :root{ --accent:${accent}; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:#f3f1ec; color:#1c1813; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .bar{ position:sticky; top:0; background:#fff; border-bottom:1px solid #e2ddd2; padding:14px 22px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .bar h1{ font-size:17px; margin:0; font-weight:600; }
  .bar .meta{ color:#7a7060; font-size:13px; }
  .bar button{ margin-left:auto; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:14px; font-weight:600; cursor:pointer; }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; padding:22px; }
  .card{ background:#fff; border:1px solid #e2ddd2; border-radius:12px; padding:18px 14px 14px; text-align:center; break-inside:avoid; }
  .card .tnum{ font-size:13px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); margin-bottom:8px; }
  .card img{ width:100%; max-width:200px; height:auto; image-rendering:pixelated; }
  .card .rname{ font-size:15px; font-weight:600; margin-top:8px; }
  .card .hint{ font-size:11px; color:#8a8070; margin-top:2px; letter-spacing:.04em; }
  @media print{ .bar{ display:none; } body{ background:#fff; } .grid{ padding:0; gap:10px; } .card{ border-color:#ccc; } }
</style></head><body>
<div class="bar">
  <h1>${safeName}</h1>
  <span class="meta">${cards.length} QR code${cards.length === 1 ? "" : "s"} · ?r=${escapeHtml(slug)}</span>
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="grid">${cells}</div>
</body></html>`;
}

app.get("/admin/qr-pack", requirePlatformAdmin, async (req, res) => {
  try {
    const slug = normalizeSlug(req.query.slug || "");
    const t = getTenant(slug);
    if (!t) return res.status(404).send("Unknown restaurant — check the slug.");
    const base = String(req.query.base || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      return res.status(400).send("Add a valid customer site URL, e.g. ?base=https://yourapp.netlify.app");
    }
    const tables = parseTableList(req.query.tables || "12");
    if (!tables.length) return res.status(400).send("No tables — pass a count (?tables=20) or a range (?tables=1-22).");
    const cards = [];
    for (const tn of tables) {
      const url = `${base}/?r=${encodeURIComponent(slug)}&table=${encodeURIComponent(tn)}`;
      const dataUri = await QRCode.toDataURL(url, { margin: 1, width: 512, errorCorrectionLevel: "M" });
      cards.push({ tn, url, dataUri });
    }
    const cfg = t.config || {};
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(qrPackHtml(cfg.name || t.name, slug, cfg.themeColor, cards));
  } catch (e) {
    console.error("[qr] pack error:", e.message);
    res.status(500).send("Failed to build QR pack.");
  }
});

// ── Owner/staff QR pack (scoped to your OWN café) ──────────
// Same printable page as /admin/qr-pack, but the slug is fixed to the caller's
// tenant (resolved from the staff OR owner-session token) — any ?slug param is
// ignored, so an owner can only ever print QR codes for their own restaurant.
app.get("/qr-pack", requireStaff, async (req, res) => {
  try {
    const t = req.tenant;
    const slug = t.slug;
    const base = String(req.query.base || OWNER_CUSTOMER_ORIGIN).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) {
      return res.status(400).send("Add a valid customer site URL, e.g. ?base=https://yourapp.netlify.app");
    }
    const tables = parseTableList(req.query.tables || "12");
    if (!tables.length) return res.status(400).send("No tables — pass a count (?tables=20) or a range (?tables=1-22).");
    const cards = [];
    for (const tn of tables) {
      const url = `${base}/?r=${encodeURIComponent(slug)}&table=${encodeURIComponent(tn)}`;
      const dataUri = await QRCode.toDataURL(url, { margin: 1, width: 512, errorCorrectionLevel: "M" });
      cards.push({ tn, url, dataUri });
    }
    const cfg = t.config || {};
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(qrPackHtml(cfg.name || t.name, slug, cfg.themeColor, cards));
  } catch (e) {
    console.error("[qr] owner pack error:", e.message);
    res.status(500).send("Failed to build QR pack.");
  }
});

// ── POST /order — receive order from QR menu (PUBLIC) ─────
app.post("/order", resolveTenant, (req, res) => {
  const { loadOrders, persistOrders, loadMenu } = req.store;
  withWriteLock(() => {
    try {
      const { tableNumber, items, notes, guestCount, phoneNumber, orderType, customerName, pickupTime } = req.body || {};

      const normalizedItems = normalizeItems(items);
      if (normalizedItems.length === 0) {
        res.status(400).json({ error: "No items in order" });
        return;
      }

      // Drinks-only pickup pre-order (tableNumber "PICKUP", collected at counter).
      // The sentinel alone also counts as pickup — otherwise a crafted request
      // could render as pickup on the dashboard while skipping pickup checks.
      const isPickup = orderType === "pickup-drinks" || isPickupSentinel(tableNumber);
      const pickupName = isPickup ? sanitizeString(customerName, 40).trim() : "";
      if (isPickup && !pickupName) {
        res.status(400).json({ error: "Please tell us your name for the pickup" });
        return;
      }
      // "ASAP", a clock time ("8:30 am"), or a next-day pickup ("Tomorrow 8:30 am")
      // for 1-day-advance orders. Anything else is free text headed for a staff
      // ticket, so fall back to ASAP. (Within-hours is enforced client-side by the
      // slot list; this just whitelists the shape.)
      const pickupWhen = isPickup ? (() => {
        const v = sanitizeString(pickupTime, 24).trim();
        return /^(asap|(tomorrow\s+)?\d{1,2}:\d{2}\s?(am|pm))$/i.test(v) ? v : "ASAP";
      })() : undefined;

      // Reject forged/underpriced items against the authoritative menu.
      const menu = loadMenu();
      if (isPickup) {
        const dv = pickupDrinksViolation(normalizedItems, menu, req.tenant.config);
        if (dv) {
          res.status(400).json({ error: dv });
          return;
        }
      }
      const pv = priceViolation(normalizedItems, menu);
      if (pv) {
        res.status(400).json({ error: pv });
        return;
      }

      // Reject an order whose true total exceeds the storable maximum rather than
      // silently clamping it to $9999.99 (which would undercharge while the
      // kitchen still makes everything).
      const rawTotal = normalizedItems.reduce((s, i) => s + i.price * i.qty, 0);
      if (rawTotal > 9999.99) {
        res.status(400).json({ error: "Order total too large — please split into separate orders." });
        return;
      }

      const orders = loadOrders();
      const order = {
        id: nextOrderId(orders),
        billToken: crypto.randomBytes(24).toString("hex"),
        // Only coerce primitives; an object/array body value would otherwise
        // become garbage like "[object " — fall back to "?" instead. Pickup
        // orders are pinned to the canonical sentinel regardless of input so
        // they can't land on (and pollute) a real table's open-tab feed.
        tableNumber: isPickup ? "PICKUP" : (sanitizeString(
          (typeof tableNumber === "string" || typeof tableNumber === "number") ? String(tableNumber) : "?",
          8
        ) || "?"),
        guestCount: clampQty(toFiniteNumber(guestCount, 1)),
        items: normalizedItems,
        phoneNumber: sanitizeString(phoneNumber, 30),
        notes: sanitizeString(notes, 500),
        // Pickup pre-order fields — undefined for dine-in so the keys are
        // omitted from stored JSON.
        orderType: isPickup ? "pickup-drinks" : undefined,
        customerName: isPickup ? pickupName : undefined,
        pickupTime: pickupWhen,
        total: normalizedItems.reduce(
          (sum, i) => sum + i.price * i.qty,
          0
        ),
        status: "received",
        paymentStatus: "unpaid",   // unpaid | pending | paid | failed | refunded
        createdAt: new Date().toISOString(),
      };
      order.total = clampMoney(order.total);
      order.onlineSurcharge = orderSurcharge(normalizedItems, menu, req.tenant.config);

      orders.push(order);
      persistOrders(orders);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`🔔 NEW ORDER ${order.id}`);
      console.log(`   Table: ${order.tableNumber} | Guests: ${order.guestCount}${order.phoneNumber ? ` | Phone: ${maskPII(order.phoneNumber)}` : ""}`);
      if (isPickup) console.log(`   Pickup: ${maskPII(order.customerName)} | Ready by: ${order.pickupTime}`);
      console.log(`   Items:`);
      order.items.forEach((item) => {
        console.log(
          `     • ${item.qty}x ${item.name}${item.size ? ` (${item.size})` : ""} — $${item.price.toFixed(2)}${item.notes ? ` [${item.notes}]` : ""}`
        );
      });
      console.log(`   Total: $${order.total.toFixed(2)}`);
      if (order.notes) console.log(`   Notes: ${order.notes}`);
      console.log(`   Time: ${order.createdAt}`);
      console.log(`${"═".repeat(50)}\n`);

      res.json({
        success: true,
        orderId: order.id,
        billToken: order.billToken,
        message: isPickup
          ? `Order received — Pickup for ${order.customerName}`
          : `Order received — Table ${order.tableNumber}`,
        total: order.total,
      });
    } catch (err) {
      console.error("[order] Error:", err.message);
      res.status(500).json({ error: "Failed to process order" });
    }
  });
});

// ── Static dashboard & bill ───────────────────────────────
// Dashboard is staff-only — gate it before serving HTML.
app.get("/dashboard", requireStaff, (_req, res, next) => next());
app.use(
  "/dashboard",
  requireStaff,
  express.static(path.join(__dirname, "public"), { index: "index-full-workflow.html" })
);
// Bill page is customer-facing (lookup by order ID via URL).
app.use("/bill", express.static(path.join(__dirname, "public", "bill")));

// ── GET /orders — staff ────────────────────────────────────
app.get("/orders", requireStaff, (req, res) => {
  let orders = req.store.loadOrders();
  const status = req.query.status;
  if (status) {
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }
    orders = orders.filter((o) => o.status === status);
  }
  const table = req.query.table;
  if (table) {
    orders = orders.filter((o) => String(o.tableNumber) === String(table));
  }
  const since = req.query.since;
  if (since) {
    const t = new Date(since).getTime();
    if (Number.isNaN(t)) {
      return res.status(400).json({ error: "Invalid 'since' timestamp" });
    }
    orders = orders.filter((o) => new Date(o.createdAt).getTime() > t);
  }
  res.json({
    count: orders.length,
    orders: orders.slice().reverse(),
    serverTime: new Date().toISOString(),
  });
});

// ── GET /orders/by-table/:table — public, for QR "add to tab" ─
// Returns minimal info (no PII) so the customer page can detect an open tab.
app.get("/orders/by-table/:table", resolveTenant, (req, res) => {
  const table = String(req.params.table || "");
  // The PICKUP pseudo-table is not a shared tab — aggregating every pickup
  // order into one public feed would let anyone enumerate the pickup queue.
  if (isPickupSentinel(table)) {
    return res.json({ count: 0, orders: [] });
  }
  const orders = req.store.loadOrders().filter(
    (o) => String(o.tableNumber) === table && o.status !== "done"
  );
  res.json({
    count: orders.length,
    // Minimal, no-PII view: enough for the customer SPA to detect an existing
    // open tab, but no longer leaks per-table spend or payment status to an
    // unauthenticated sweep. (Rate-limited above; staff use GET /orders.)
    orders: orders.map((o) => ({
      id: o.id,
      tableNumber: o.tableNumber,
      itemCount: o.items.length,
      status: o.status,
      createdAt: o.createdAt,
    })),
  });
});

// ──────────────────────────────────────────────────────────
// ── MENU API ───────────────────────────────────────────────
// ──────────────────────────────────────────────────────────

// ── Online ordering surcharge ──────────────────────────────
// A few cents added to each item's price ON THE CUSTOMER MENU ONLY. It is baked
// into the displayed (GST-inclusive) price — NOT a separate checkout fee — per
// NZ Fair Trading guidance (avoids "drip pricing"). Base prices in the menu,
// the admin (/menu?raw=1) and the in-store/Lightspeed flow are untouched.
// The per-category map + default now come from each tenant's config
// (config.surcharge / config.surchargeDefault), so every restaurant sets its
// own (or none).
function categorySurcharge(slug, cfg) {
  cfg = cfg || {};
  const map = cfg.surcharge || {};
  const v = map[slug];
  return typeof v === "number" ? v : (Number(cfg.surchargeDefault) || 0);
}
function bumpPrice(n, add) {
  return typeof n === "number" ? Math.round((n + add) * 100) / 100 : n;
}
// Return a COPY of the menu with the per-category surcharge added to every
// price/size. Never mutates the cached base menu.
function withOnlineSurcharge(menu, cfg) {
  cfg = cfg || {};
  const out = JSON.parse(JSON.stringify(menu || {}));
  for (const slug of (out.categoryOrder || [])) {
    const cat = out.categories && out.categories[slug];
    if (!cat || !Array.isArray(cat.items)) continue;
    const add = categorySurcharge(slug, cfg);
    if (!add) continue;
    for (const it of cat.items) {
      if (typeof it.price === "number") it.price = bumpPrice(it.price, add);
      if (it.sizes && typeof it.sizes === "object") {
        for (const k of Object.keys(it.sizes)) it.sizes[k] = bumpPrice(it.sizes[k], add);
      }
    }
  }
  out.onlineSurcharge = {
    drink: categorySurcharge("coffee", cfg),
    food: categorySurcharge("mains", cfg),
    sides: categorySurcharge("sides", cfg),
  };
  return out;
}

// Which category an order line belongs to (by id, then stripped name).
function findItemCategory(menu, line) {
  if (!menu || !Array.isArray(menu.categoryOrder)) return null;
  if (line && line.id) {
    for (const slug of menu.categoryOrder) {
      const cat = menu.categories[slug];
      if (cat && Array.isArray(cat.items) && cat.items.some((x) => x.id === line.id)) return slug;
    }
  }
  if (line && line.name) {
    const base = String(line.name).replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    for (const slug of menu.categoryOrder) {
      const cat = menu.categories[slug];
      if (cat && Array.isArray(cat.items) && cat.items.some((x) => String(x.name || "").trim().toLowerCase() === base)) return slug;
    }
  }
  return null;
}
// Online-surcharge INCOME earned on a set of order lines (the per-category fee
// × qty). This is the "developer fee" the owner keeps from online ordering.
function orderSurcharge(items, menu, cfg) {
  let s = 0;
  for (const it of (items || [])) {
    const slug = findItemCategory(menu, it);
    if (slug == null) continue;
    s += categorySurcharge(slug, cfg) * (Number(it.qty) || 1);
  }
  return Math.round(s * 100) / 100;
}

// GET /menu — public, returns the current menu.  The customer SPA fetches
// this on boot and falls back to the bundled menu if we're unreachable.
// ?raw=1 returns BASE prices (used by the staff menu admin); the default
// response has the online surcharge baked into each price.
app.get("/menu", resolveTenant, (req, res) => {
  const menu = req.store.loadMenu();
  res.set("Cache-Control", "no-cache");
  const raw = req.query && (req.query.raw === "1" || req.query.raw === "true");
  const out = raw ? Object.assign({}, menu) : withOnlineSurcharge(menu, req.tenant.config);
  // Brand fields so the customer SPA can render the right name/tagline on first
  // paint (the menu is fetched before the app renders).
  const c = req.tenant.config || {};
  out.slug = req.tenant.slug;                  // lets the backoffice pages build a tenant-correct "Live menu" link
  out.isDefaultTenant = req.tenant.slug === DEFAULT_TENANT; // legacy flag (Crispy); per-feature gating now uses out.features
  out.restaurantName = c.name || req.tenant.name;
  out.established = c.established || "";
  out.themeColor = c.themeColor || PLATFORM_DEFAULT_THEME;
  out.palette = c.palette || {};
  out.logoUrl = c.logoUrl || null;
  out.heroUrl = c.heroUrl || "";
  out.address = c.address || "";
  out.phone = c.phone || "";
  out.hours = c.hours || {};
  out.currency = c.currency || "$";
  out.gstRate = typeof c.gstRate === "number" ? c.gstRate : 0.15;
  out.gstNumber = c.gstNumber || "";       // printed on the tax receipt (public on the receipt itself)
  out.legalName = c.legalName || "";
  out.drinkCategories = Array.isArray(c.drinkCategories) ? c.drinkCategories : [];
  out.dessertCategory = c.dessertCategory || "";
  out.i18n = c.i18n || {};
  out.receipt = c.receipt || {};
  out.features = c.features || {};
  // Internal LAN printer IPs are exposed ONLY to this tenant's authenticated
  // staff (resolveTenant pins req.tenant to the token's own tenant), never on the
  // public customer fetch.
  if (findTenantByToken(getReqToken(req))) out.printerStations = c.printerStations || {};
  res.json(out);
});

// PATCH /menu/items/:id — staff, update any subset of an item's fields.
// Allowed fields: name, desc, price, sizes, tags, outOfStock, imgRight, img.
app.patch("/menu/items/:id", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const found = findItem(menu, req.params.id);
      if (!found) return res.status(404).json({ error: "Item not found" });
      const body = req.body || {};
      const ALLOWED = ["name", "desc", "price", "sizes", "tags", "outOfStock", "imgRight", "img", "imgUrl"];
      const it = found.item;
      for (const k of ALLOWED) {
        if (k in body) {
          if (k === "price") {
            const n = Number(body.price);
            if (!Number.isFinite(n) || n < 0 || n > 9999) {
              return res.status(400).json({ error: "Invalid price" });
            }
            it.price = Math.round(n * 100) / 100;
            // If they set a fixed price, drop sizes (mutually exclusive)
            if ("price" in body && !("sizes" in body)) delete it.sizes;
          } else if (k === "sizes") {
            if (body.sizes && typeof body.sizes === "object" && !Array.isArray(body.sizes)) {
              const keys = Object.keys(body.sizes).filter((sk) => sk !== "__proto__" && sk !== "constructor" && sk !== "prototype");
              if (keys.length === 0) {
                return res.status(400).json({ error: "sizes must have at least one entry" });
              }
              const cleaned = {};
              for (const sk of keys) {
                const n = Number(body.sizes[sk]);
                if (!Number.isFinite(n) || n < 0 || n > 9999) {
                  return res.status(400).json({ error: "Invalid size price for " + sk });
                }
                cleaned[String(sk).slice(0, 20)] = Math.round(n * 100) / 100;
              }
              it.sizes = cleaned;
              delete it.price; // mutually exclusive
            } else {
              delete it.sizes;
            }
          } else if (k === "tags") {
            if (Array.isArray(body.tags)) {
              it.tags = body.tags.map((t) => String(t).slice(0, 24)).slice(0, 6);
            }
          } else if (k === "outOfStock") {
            it.outOfStock = Boolean(body.outOfStock);
          } else if (k === "name" || k === "desc" || k === "imgRight" || k === "img" || k === "imgUrl") {
            const v = body[k];
            if (v === null || v === undefined || v === "") delete it[k];
            else it[k] = String(v).slice(0, 500);
          }
        }
      }
      persistMenu(menu);
      console.log(`[menu] PATCH item ${req.params.id} → ${Object.keys(body).join(", ")}`);
      res.json({ success: true, item: it, version: menu.version });
    } catch (err) {
      console.error("[menu] PATCH error:", err.message);
      res.status(500).json({ error: "Failed to update item" });
    }
  });
});

// POST /menu/items — staff, add a new item to a category.
// Body: { categorySlug, name, price (or sizes), desc?, tags?, img?, imgRight? }
app.post("/menu/items", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const body = req.body || {};
      const slug = String(body.categorySlug || "").trim();
      const cat = menu.categories[slug];
      if (!cat) return res.status(400).json({ error: "Unknown category: " + slug });
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) return res.status(400).json({ error: "Name required (≤80 chars)" });

      // Generate a unique id from the name
      let id = slugify(name);
      let suffix = 1;
      while (findItem(menu, id)) { suffix += 1; id = `${slugify(name)}-${suffix}`; }

      const item = { id, name };
      // Price OR sizes
      const sizeKeys = (body.sizes && typeof body.sizes === "object" && !Array.isArray(body.sizes))
        ? Object.keys(body.sizes).filter((sk) => sk !== "__proto__" && sk !== "constructor" && sk !== "prototype")
        : [];
      if (sizeKeys.length > 0) {
        const cleaned = {};
        for (const sk of sizeKeys) {
          const n = Number(body.sizes[sk]);
          if (!Number.isFinite(n) || n < 0 || n > 9999) return res.status(400).json({ error: "Invalid size price for " + sk });
          cleaned[String(sk).slice(0, 20)] = Math.round(n * 100) / 100;
        }
        item.sizes = cleaned;
      } else {
        const n = Number(body.price);
        if (!Number.isFinite(n) || n < 0 || n > 9999) return res.status(400).json({ error: "Price required (or sizes)" });
        item.price = Math.round(n * 100) / 100;
      }
      if (body.desc) item.desc = String(body.desc).slice(0, 500);
      if (Array.isArray(body.tags)) {
        item.tags = body.tags.map((t) => String(t).slice(0, 24)).slice(0, 6);
      }
      if (body.img) item.img = String(body.img).slice(0, 200);
      if (body.imgRight) item.imgRight = String(body.imgRight).slice(0, 20);

      if (!Array.isArray(cat.items)) cat.items = [];
      cat.items.push(item);
      persistMenu(menu);
      console.log(`[menu] POST item ${id} → ${slug}`);
      res.json({ success: true, item, categorySlug: slug, version: menu.version });
    } catch (err) {
      console.error("[menu] POST error:", err.message);
      res.status(500).json({ error: "Failed to add item" });
    }
  });
});

// POST /menu/items/:id/image — staff, upload an image for an item.
// Multipart: field "image" carries the file (jpeg/png/webp/heic, ≤10 MB).
// Sharp resizes to ≤1024 wide, encodes JPEG q85, uploads to Supabase Storage
// bucket "menu-images" and saves the public URL as item.imgUrl.
const multer = require("multer");
const sharp  = require("sharp");
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)/i.test(file.mimetype)) {
      return cb(new Error("Only image files (jpeg/png/webp/heic) are allowed"));
    }
    cb(null, true);
  },
});

// Menu-photo import accepts a photo OR a PDF, so it can't reuse imageUpload's
// image-only fileFilter. Same memoryStorage + 10 MB cap; the handler does the
// fine-grained type check (and returns a friendly 415).
const menuImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// POST /menu/extract — public, rate-limited. Reads a menu photo/PDF with Claude
// and returns a flat { categories:[{title,items:[{name,price,desc}]}] } the
// signup/admin wizard can drop straight into the menu builder. Never invents
// items; prices are plain numbers (no symbol). Falls back to manual entry when
// ANTHROPIC_API_KEY is unset (503 code:"no_ai").
const EXTRACT_PROMPT = [
  "You are digitizing a restaurant's menu from the attached image or PDF.",
  "Extract every printed section and dish into the required JSON structure.",
  "Rules:",
  "- Output ONLY items that are actually printed on the menu. Never invent, guess, or pad with example dishes.",
  "- price: a plain number in the menu's own currency with NO symbol or currency code (e.g. 12.5, not \"$12.50\"). If a dish has no printed price, use 0. If it lists several sizes/prices, use the lowest.",
  "- name: the dish name as printed, kept short (drop long marketing taglines).",
  "- desc: the menu's printed description for that dish, or an empty string if none is printed. Do not write your own description.",
  "- Group dishes under their printed section titles (e.g. \"Breakfast\", \"Coffee\"). If the menu has no sections, put everything under a single category titled \"Menu\".",
  "Return the structured JSON only.",
].join("\n");
const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                desc: { type: "string" },
              },
              required: ["name", "price", "desc"],
            },
          },
        },
        required: ["title", "items"],
      },
    },
  },
  required: ["categories"],
};
app.post("/menu/extract", menuImportUpload.single("file"), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: "Photo import isn't set up yet — add items manually.", code: "no_ai" });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field 'file')." });
    const mt = req.file.mimetype;
    const okImg = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mt);
    const isPdf = mt === "application/pdf";
    if (!okImg && !isPdf) {
      return res.status(415).json({ error: "Upload a photo (JPG/PNG) or a PDF of your menu." });
    }
    const b64 = req.file.buffer.toString("base64");
    const srcBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: mt, data: b64 } };

    // Node 18+ has global fetch — no new npm dependency. Time out after ~60s so
    // a slow/hung model call can't pin the request open.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MENU_IMPORT_MODEL,
          max_tokens: 4000,
          messages: [{ role: "user", content: [srcBlock, { type: "text", text: EXTRACT_PROMPT }] }],
          output_config: { effort: "low", format: { type: "json_schema", schema: MENU_SCHEMA } },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 300); } catch {}
      console.error(`[menu] extract upstream ${r.status}: ${detail}`);
      return res.status(502).json({ error: "Couldn't read that menu — try a clearer photo or add items manually." });
    }
    const data = await r.json();
    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    // Strip a leading/trailing markdown code fence if the model wrapped the JSON.
    text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      console.error("[menu] extract JSON parse failed:", e.message);
      return res.status(502).json({ error: "Couldn't read that menu — try a clearer photo or add items manually." });
    }
    const categories = (Array.isArray(obj.categories) ? obj.categories : []).slice(0, 30).map((c) => ({
      title: sanitizeString(c && c.title, 40) || "Menu",
      items: (Array.isArray(c && c.items) ? c.items : []).slice(0, 60).map((i) => ({
        name: sanitizeString(i && i.name, 120),
        price: clampMoney(toFiniteNumber(i && i.price, 0)),
        desc: sanitizeString(i && i.desc, 200),
      })).filter((i) => i.name),
    })).filter((c) => c.title);
    res.json({ success: true, categories });
  } catch (err) {
    console.error("[menu] extract error:", err && err.message);
    res.status(500).json({ error: "Couldn't read that menu — please try again or add items manually." });
  }
});

app.post("/menu/items/:id/image", requireStaff, imageUpload.single("image"), async (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  try {
    if (!supabase) {
      return res.status(503).json({
        error: "Image upload requires Supabase Storage. Set SUPABASE_URL + SUPABASE_SERVICE_KEY and create a public 'menu-images' bucket.",
      });
    }
    if (!req.file) return res.status(400).json({ error: "No image file provided (field 'image')" });
    const found = findItem(loadMenu(), req.params.id);
    if (!found) return res.status(404).json({ error: "Item not found" });

    // Resize + re-encode
    const resized = await sharp(req.file.buffer)
      .rotate()  // auto-orient based on EXIF
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    // Namespace the object by tenant so two restaurants can't collide on an id.
    const fileName = `${req.store.slug}/${req.params.id}-${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from("menu-images")
      .upload(fileName, resized, { contentType: "image/jpeg", upsert: false });
    if (upErr) {
      console.error("[menu] supabase upload error:", upErr.message);
      return res.status(502).json({ error: "Upload failed: " + upErr.message });
    }
    const { data: { publicUrl } } = supabase.storage
      .from("menu-images")
      .getPublicUrl(fileName);

    // Save URL onto the item
    await new Promise((resolve, reject) => {
      withWriteLock(() => {
        try {
          const menu = loadMenu();
          const f = findItem(menu, req.params.id);
          if (!f) return reject(new Error("Item disappeared mid-upload"));
          f.item.imgUrl = publicUrl;
          persistMenu(menu);
          resolve();
        } catch (e) { reject(e); }
      });
    });

    console.log(`[menu] image uploaded for ${req.params.id} → ${publicUrl}`);
    res.json({ success: true, imgUrl: publicUrl });
  } catch (err) {
    console.error("[menu] image upload error:", err.message);
    res.status(500).json({ error: "Failed to upload image: " + err.message });
  }
});

// POST /admin/tenants/:slug/logo — platform admin, upload a restaurant logo.
// Multipart field "logo". Resized to ≤512px square (contain), stored in Supabase
// Storage, saved as config.logoUrl. Sent as a separate multipart request (not in
// the JSON create body) so it isn't bound by the 64kb json limit.
async function processLogo(slug, buffer) {
  const resized = await sharp(buffer)
    .rotate()
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const fileName = slug + "/logo-" + Date.now() + ".png";
  const { error } = await supabase.storage.from("menu-images").upload(fileName, resized, { contentType: "image/png", upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from("menu-images").getPublicUrl(fileName).data.publicUrl;
}
app.post("/admin/tenants/:slug/logo", requirePlatformAdmin, imageUpload.single("logo"), async (req, res) => {
  try {
    const t = getTenant(req.params.slug);
    if (!t) return res.status(404).json({ error: "Unknown restaurant" });
    if (!supabase) return res.status(503).json({ error: "Logo upload requires Supabase Storage (SUPABASE_URL + SUPABASE_SERVICE_KEY)." });
    if (!req.file) return res.status(400).json({ error: "No logo file provided (field 'logo')" });
    const url = await processLogo(t.slug, req.file.buffer);
    await new Promise((resolve, reject) => withWriteLock(() => {
      try { t.config = mergeConfig(Object.assign({}, t.config, { logoUrl: url })); saveTenant(t); resolve(); }
      catch (e) { reject(e); }
    }));
    console.log(`[tenant] logo uploaded for '${t.slug}' → ${url}`);
    res.json({ success: true, logoUrl: url });
  } catch (err) {
    console.error("[tenant] logo upload error:", err.message);
    res.status(500).json({ error: "Failed to upload logo: " + err.message });
  }
});

// DELETE /menu/items/:id — staff, remove an item from the menu.
app.delete("/menu/items/:id", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const found = findItem(menu, req.params.id);
      if (!found) return res.status(404).json({ error: "Item not found" });
      found.category.items.splice(found.index, 1);
      persistMenu(menu);
      console.log(`[menu] DELETE item ${req.params.id}`);
      res.json({ success: true, version: menu.version });
    } catch (err) {
      console.error("[menu] DELETE error:", err.message);
      res.status(500).json({ error: "Failed to delete item" });
    }
  });
});

// PATCH /menu/specials — staff, set or clear the "today's specials" banner.
// Body: { text: "..." } to set, { text: null } or { text: "" } to clear.
// Banner is part of the menu payload returned to customers via GET /menu.
app.patch("/menu/specials", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const text = req.body && req.body.text != null ? String(req.body.text).slice(0, 240).trim() : "";
      if (text) {
        menu.specials = { text, updatedAt: new Date().toISOString() };
      } else {
        delete menu.specials;
      }
      persistMenu(menu);
      console.log(`[menu] specials ${text ? "set" : "cleared"}`);
      res.json({ success: true, specials: menu.specials || null, version: menu.version });
    } catch (err) {
      console.error("[menu] specials error:", err.message);
      res.status(500).json({ error: "Failed to update specials" });
    }
  });
});

// POST /menu/categories/:slug/sold-out-all — staff, flip every item in a
// category to outOfStock (or back). Useful for shift handover when a section
// (e.g. breakfast) closes for the day.
// Body: { soldOut: boolean }  (default true)
app.post("/menu/categories/:slug/sold-out-all", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const slug = req.params.slug;
      const cat = menu.categories[slug];
      if (!cat) return res.status(404).json({ error: "Unknown category: " + slug });
      const soldOut = req.body && req.body.soldOut === false ? false : true;
      const items = Array.isArray(cat.items) ? cat.items : [];
      let changed = 0;
      for (const it of items) {
        if ((!!it.outOfStock) !== soldOut) { it.outOfStock = soldOut; changed += 1; }
      }
      persistMenu(menu);
      console.log(`[menu] category ${slug} bulk soldOut=${soldOut} (${changed} changed)`);
      res.json({ success: true, slug, soldOut, changed, version: menu.version });
    } catch (err) {
      console.error("[menu] bulk sold-out error:", err.message);
      res.status(500).json({ error: "Failed to bulk sold-out" });
    }
  });
});

// POST /menu/reorder — staff, replace the item order within a category.
// Body: { categorySlug, itemIds: ["id-1", "id-2", ...] }
// Must list every item currently in the category (no add/remove via this endpoint).
app.post("/menu/reorder", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const body = req.body || {};
      const slug = String(body.categorySlug || "").trim();
      const cat = menu.categories[slug];
      if (!cat) return res.status(400).json({ error: "Unknown category: " + slug });
      const ids = Array.isArray(body.itemIds) ? body.itemIds.map(String) : null;
      if (!ids) return res.status(400).json({ error: "itemIds required (array of ids)" });
      const existing = new Set((cat.items || []).map((it) => it.id));
      const incoming = new Set(ids);
      if (ids.length !== existing.size || [...existing].some((id) => !incoming.has(id))) {
        return res.status(400).json({
          error: "itemIds must exactly match the current items in the category",
          expected: [...existing],
          got: ids,
        });
      }
      const byId = new Map(cat.items.map((it) => [it.id, it]));
      cat.items = ids.map((id) => byId.get(id));
      persistMenu(menu);
      console.log(`[menu] reorder ${slug} (${ids.length} items)`);
      res.json({ success: true, version: menu.version });
    } catch (err) {
      console.error("[menu] reorder error:", err.message);
      res.status(500).json({ error: "Failed to reorder" });
    }
  });
});

// ── Menu category management (staff) ───────────────────────
// Lets a restaurant define its own sections (e.g. "Breakfast", "Coffee") so a
// brand-new tenant can build its menu from scratch.
// POST /menu/categories — add a category. Body: { title, slug?, subtitle? }
app.post("/menu/categories", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const b = req.body || {};
      const title = String(b.title || "").trim();
      if (!title || title.length > 40) return res.status(400).json({ error: "Title required (≤40 chars)" });
      let slug = slugify(b.slug ? b.slug : title);
      let n = 1;
      while (menu.categories[slug]) { n += 1; slug = slugify(title) + "-" + n; }
      if (!Array.isArray(menu.categoryOrder)) menu.categoryOrder = [];
      if (!menu.categories) menu.categories = {};
      menu.categoryOrder.push(slug);
      menu.categories[slug] = { title: title.slice(0, 40), subtitle: b.subtitle ? String(b.subtitle).slice(0, 80) : "", items: [] };
      persistMenu(menu);
      console.log(`[menu] category added ${slug}`);
      res.json({ success: true, slug, category: menu.categories[slug], version: menu.version });
    } catch (err) {
      console.error("[menu] category add error:", err.message);
      res.status(500).json({ error: "Failed to add category" });
    }
  });
});

// PATCH /menu/categories/:slug — rename a category (title/subtitle).
app.patch("/menu/categories/:slug", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const cat = menu.categories[req.params.slug];
      if (!cat) return res.status(404).json({ error: "Unknown category" });
      const b = req.body || {};
      if (b.title != null) { const t = String(b.title).trim(); if (t) cat.title = t.slice(0, 40); }
      if (b.subtitle != null) cat.subtitle = String(b.subtitle).slice(0, 80);
      persistMenu(menu);
      res.json({ success: true, slug: req.params.slug, category: cat, version: menu.version });
    } catch (err) {
      console.error("[menu] category rename error:", err.message);
      res.status(500).json({ error: "Failed to rename category" });
    }
  });
});

// DELETE /menu/categories/:slug — remove an empty category (force=1 to drop a
// non-empty one and all its items).
app.delete("/menu/categories/:slug", requireStaff, (req, res) => {
  const { loadMenu, persistMenu } = req.store;
  withWriteLock(() => {
    try {
      const menu = loadMenu();
      const slug = req.params.slug;
      const cat = menu.categories[slug];
      if (!cat) return res.status(404).json({ error: "Unknown category" });
      const force = req.query && (req.query.force === "1" || req.query.force === "true");
      if ((cat.items || []).length > 0 && !force) {
        return res.status(409).json({ error: "Category not empty — pass ?force=1 to delete it and its items" });
      }
      delete menu.categories[slug];
      menu.categoryOrder = (menu.categoryOrder || []).filter((s) => s !== slug);
      persistMenu(menu);
      console.log(`[menu] category deleted ${slug}`);
      res.json({ success: true, version: menu.version });
    } catch (err) {
      console.error("[menu] category delete error:", err.message);
      res.status(500).json({ error: "Failed to delete category" });
    }
  });
});

// ── GET /orders/:id — public (for bill page lookup) ───────
// Requires ?t=<billToken> for orders created with a token. Returns redacted
// data (no phone, no cooked/picked state, no internal fields).
app.get("/orders/:id", resolveTenant, (req, res) => {
  const orders = req.store.loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!checkBillToken(order, req)) {
    // Don't distinguish "wrong token" from "no token" — both look like 404.
    // Prevents enumeration of valid order IDs.
    return res.status(404).json({ error: "Order not found" });
  }
  const oc = req.tenant.config || {};
  res.json({
    id: order.id,
    tableNumber: order.tableNumber,
    // Tenant identity so the (static, same-origin) bill page renders the right
    // restaurant name/address/hours/currency for every tenant — Crispy included
    // (its config supplies its exact values).
    restaurantName: oc.name || req.tenant.name,
    address: oc.address || "",
    hours: oc.hours || {},
    currency: oc.currency || "$",
    // Pickup pre-order fields — undefined (omitted) for dine-in orders.
    orderType: order.orderType,
    customerName: order.customerName,
    pickupTime: order.pickupTime,
    // Strip lineId from bill response — it's an internal kitchen-state key
    // and isn't needed for rendering the bill.
    items: order.items.map((i) => ({
      name: i.name,
      size: i.size,
      qty: i.qty,
      price: i.price,
      notes: i.notes,
    })),
    adjustments: (Array.isArray(order.adjustments) ? order.adjustments : []).map((a) => ({ label: a.label, amount: a.amount })),
    total: order.total,
    status: order.status,
    createdAt: order.createdAt,
    // Payment fields the customer SPA needs to drive a Pay button + read
    // confirmation back.  Sensitive bits (transactionId, authCode) are kept
    // server-side; only the user-facing slice surfaces here.
    paymentStatus: order.paymentStatus || "unpaid",
    paymentIntent: order.paymentIntent
      ? {
          id: order.paymentIntent.id,
          provider: order.paymentIntent.provider,
          amount: order.paymentIntent.amount,
          currency: order.paymentIntent.currency,
          clientSecret: order.paymentIntent.clientSecret,
          hostedUrl: order.paymentIntent.hostedUrl,
        }
      : null,
    payment: order.payment
      ? {
          method: order.payment.method,
          scheme: order.payment.scheme,
          last4: order.payment.last4,
          capturedAt: order.payment.capturedAt,
        }
      : null,
  });
});

// ── POST /orders/:id/add-items — public (QR "add to order") ─
app.post("/orders/:id/add-items", resolveTenant, (req, res) => {
  const { loadOrders, persistOrders, loadMenu } = req.store;
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: "Order not found" });
        return;
      }

      // Don't let a closed order be reopened by appending items.
      if (orders[idx].status === "done") {
        res.status(409).json({ error: "Order is already closed" });
        return;
      }

      // If a bill token is supplied it MUST match (validates the owning device);
      // in STRICT_TAB_TOKEN mode a matching token is required for every add.
      const tokenSupplied = !!(req.query && req.query.t) || !!(req.body && req.body.token);
      if ((STRICT_TAB_TOKEN || tokenSupplied) && !checkBillToken(orders[idx], req)) {
        res.status(404).json({ error: "Order not found" });
        return;
      }

      // Can't append to an order that's mid-payment or already paid — the
      // captured/authorised amount would no longer match the order total.
      if (["pending", "paid", "refunded"].includes(orders[idx].paymentStatus)) {
        res.status(409).json({ error: "Order is being paid, already paid, or refunded — cannot add items" });
        return;
      }

      const newItems = normalizeItems(req.body && req.body.items);
      if (newItems.length === 0) {
        res.status(400).json({ error: "No items to add" });
        return;
      }

      // Reject forged/underpriced additions against the menu (best-effort:
      // /add-items lines carry no id, so this matches by name).
      const addMenu = loadMenu();
      const pv = priceViolation(newItems, addMenu);
      if (pv) {
        res.status(400).json({ error: pv });
        return;
      }

      // A pickup pre-order stays drinks-only even via add-items.
      if (orders[idx].orderType === "pickup-drinks" || isPickupSentinel(orders[idx].tableNumber)) {
        const dv = pickupDrinksViolation(newItems, addMenu, req.tenant.config);
        if (dv) {
          res.status(400).json({ error: dv });
          return;
        }
      }

      // N7: dedup window — if the exact same items batch arrives within 5s of
      // the previous add (cross-tab race, accidental double-tap), no-op and
      // return success without appending.
      const newHash = itemsHash(newItems);
      const lastHash = orders[idx]._lastAddHash;
      const lastAt = orders[idx]._lastAddAt || 0;
      if (newHash === lastHash && Date.now() - lastAt < 5000) {
        console.log(`[add-items] DEDUP: ignoring duplicate batch for ${orders[idx].id} (${newItems.length} items, within 5s)`);
        res.json({
          success: true,
          orderId: orders[idx].id,
          message: "Items already added (duplicate within 5s)",
          total: orders[idx].total,
          deduped: true,
        });
        return;
      }

      // Bound how large a single tab can grow. Limits the blast radius of an
      // abusive/erroneous add (a real table tab is far under these) without
      // requiring the bill token on the shared-tab path.
      const mergedItems = [...orders[idx].items, ...newItems];
      const projectedTotal = mergedItems.reduce((sum, i) => sum + (i.price || 0) * (i.qty || 1), 0);
      if (mergedItems.length > 120 || projectedTotal > 9999.99) {
        res.status(409).json({ error: "This tab is already at its maximum — please ask staff or start a new order." });
        return;
      }

      orders[idx].items = mergedItems;
      orders[idx].total = clampMoney(projectedTotal + adjustmentsTotal(orders[idx]));
      orders[idx].onlineSurcharge = clampMoney((orders[idx].onlineSurcharge || 0) + orderSurcharge(newItems, loadMenu(), req.tenant.config));
      // Only (re)flag a brand-new/idle tab as "received". Don't drag an order
      // that's already preparing/ready/picked_up back to the start of the board.
      if (!["preparing", "ready", "picked_up"].includes(orders[idx].status)) {
        orders[idx].status = "received";
      }
      orders[idx].updatedAt = new Date().toISOString();
      orders[idx]._lastAddHash = newHash;
      orders[idx]._lastAddAt = Date.now();
      persistOrders(orders);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`➕ ITEMS ADDED to ${orders[idx].id} (Table ${orders[idx].tableNumber})`);
      newItems.forEach((item) => {
        console.log(
          `     • ${item.qty}x ${item.name}${item.size ? ` (${item.size})` : ""} — $${item.price.toFixed(2)}${item.notes ? ` [${item.notes}]` : ""}`
        );
      });
      console.log(`   New total: $${orders[idx].total.toFixed(2)}`);
      console.log(`${"═".repeat(50)}\n`);

      res.json({
        success: true,
        orderId: orders[idx].id,
        message: `Items added to order ${orders[idx].id}`,
        total: orders[idx].total,
      });
    } catch (err) {
      console.error("[add-items] Error:", err.message);
      res.status(500).json({ error: "Failed to add items" });
    }
  });
});

// ── PATCH /orders/:id — staff ──────────────────────────────
app.patch("/orders/:id", requireStaff, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: "Order not found" });
        return;
      }

      const { status, cookedItems, pickedItems, paymentStatus, paymentMethod } =
        req.body || {};
      if (
        !status &&
        cookedItems === undefined &&
        pickedItems === undefined &&
        paymentStatus === undefined &&
        paymentMethod === undefined
      ) {
        res.status(400).json({ error: "Status or item state required" });
        return;
      }
      if (status && !VALID_STATUSES.has(status)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      if (paymentStatus !== undefined && !VALID_PAYMENT_STATUSES.has(paymentStatus)) {
        res.status(400).json({ error: "Invalid paymentStatus" });
        return;
      }

      // cookedItems/pickedItems: must be an object of stringKey -> boolean.
      function sanitizeStateMap(m) {
        if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
        const out = {};
        for (const k of Object.keys(m).slice(0, 200)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          out[sanitizeString(k, 40)] = !!m[k];
        }
        return out;
      }

      if (status) orders[idx].status = status;
      if (cookedItems !== undefined) {
        const m = sanitizeStateMap(cookedItems);
        if (m === undefined) {
          res.status(400).json({ error: "Invalid cookedItems" });
          return;
        }
        orders[idx].cookedItems = m;
      }
      if (pickedItems !== undefined) {
        const m = sanitizeStateMap(pickedItems);
        if (m === undefined) {
          res.status(400).json({ error: "Invalid pickedItems" });
          return;
        }
        orders[idx].pickedItems = m;
      }
      // Payment confirmation — staff tapping "PAID BY CUSTOMER" records the order
      // as paid (cash or card) at the counter. Stamp paidAt once so reports and
      // the GST receipt have a payment time. paymentMethod is sanitized before
      // it is stored or logged.
      const cleanMethod =
        paymentMethod !== undefined ? sanitizeString(paymentMethod, 24) : undefined;
      if (paymentStatus !== undefined) {
        orders[idx].paymentStatus = paymentStatus;
        if (paymentStatus === "paid" && !orders[idx].paidAt) {
          orders[idx].paidAt = new Date().toISOString();
        }
      }
      if (cleanMethod !== undefined) {
        orders[idx].paymentMethod = cleanMethod;
      }
      orders[idx].updatedAt = new Date().toISOString();
      persistOrders(orders);

      console.log(
        `[orders] ${orders[idx].id} → ${status || "(state update)"}` +
          (paymentStatus !== undefined
            ? ` [${paymentStatus}${orders[idx].paymentMethod ? " · " + orders[idx].paymentMethod : ""}]`
            : "")
      );
      res.json({ success: true, order: orders[idx] });
    } catch (err) {
      console.error("[patch] Error:", err.message);
      res.status(500).json({ error: "Failed to update order" });
    }
  });
});

// ── POST /orders/merge — staff: combine a table's orders into one ──────────
// Body: { table } merges ALL open (non-done, unpaid, dine-in) orders for that
// table, OR { orderIds:[...] } merges a specific set. The earliest order is the
// "primary" (keeps its id + billToken); the others' items fold into it and are
// removed, so one table = one order + one bill.
const STATUS_ORDER = ["received", "preparing", "ready", "picked_up", "done"];
function leastProgressed(statuses) {
  let best = "done", bestIdx = STATUS_ORDER.length;
  for (const s of statuses) {
    const i = STATUS_ORDER.indexOf(s);
    if (i >= 0 && i < bestIdx) { bestIdx = i; best = s; }
  }
  return best === "done" ? (statuses[0] || "received") : best;
}
function isPickupOrderRec(o) {
  return o.orderType === "pickup-drinks" || isPickupSentinel(o.tableNumber);
}
app.post("/orders/merge", requireStaff, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  withWriteLock(() => {
    try {
      const b = req.body || {};
      const orders = loadOrders();
      let targets;
      if (Array.isArray(b.orderIds) && b.orderIds.length) {
        const want = new Set(b.orderIds.map(String));
        targets = orders.filter((o) => want.has(o.id));
      } else if (b.table != null && String(b.table).trim() !== "") {
        const tbl = String(b.table);
        targets = orders.filter((o) => String(o.tableNumber) === tbl && o.status !== "done" && !isPickupOrderRec(o));
      } else {
        return res.status(400).json({ error: "Provide a table or orderIds to combine." });
      }

      if (targets.length < 2) {
        return res.status(400).json({ error: "Need at least two open orders to combine." });
      }
      if (targets.some(isPickupOrderRec)) {
        return res.status(400).json({ error: "Pickup orders can't be combined." });
      }
      const tableSet = new Set(targets.map((o) => String(o.tableNumber)));
      if (tableSet.size > 1) {
        return res.status(400).json({ error: "Those orders are from different tables." });
      }
      if (targets.some((o) => ["paid", "pending", "refunded"].includes(o.paymentStatus))) {
        return res.status(409).json({ error: "One or more of these orders is paid or being paid — combine before taking payment." });
      }

      // Earliest order is the primary (keeps id + billToken so its bill link survives).
      targets.sort((a, b2) => new Date(a.createdAt || 0) - new Date(b2.createdAt || 0));
      const primary = targets[0];
      const others = targets.slice(1);

      const mergedItems = targets.reduce((acc, o) => acc.concat(Array.isArray(o.items) ? o.items : []), []);
      const projectedTotal = mergedItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
      if (mergedItems.length > 200 || projectedTotal > 9999.99) {
        return res.status(409).json({ error: "Combined order would be too large — keep them separate." });
      }

      primary.items = mergedItems;
      // Carry every order's manual bill adjustments into the combined bill.
      primary.adjustments = targets.reduce((acc, o) => acc.concat(Array.isArray(o.adjustments) ? o.adjustments : []), []);
      primary.total = clampMoney(projectedTotal + adjustmentsTotal(primary));
      primary.onlineSurcharge = clampMoney(targets.reduce((s, o) => s + (Number(o.onlineSurcharge) || 0), 0));
      primary.guestCount = clampQty(targets.reduce((s, o) => s + (Number(o.guestCount) || 0), 0));
      const allNotes = targets.map((o) => (o.notes || "").trim()).filter(Boolean);
      if (allNotes.length) primary.notes = sanitizeString(allNotes.join(" | "), 500);
      primary.phoneNumber = primary.phoneNumber || (others.map((o) => o.phoneNumber).find(Boolean) || "");
      primary.status = leastProgressed(targets.map((o) => o.status));
      // Item indices shift on merge, so cooked/picked maps no longer line up —
      // clear them; the combined order is re-cooked/printed fresh.
      delete primary.cookedItems;
      delete primary.pickedItems;
      delete primary._lastAddHash;
      delete primary._lastAddAt;
      primary.mergedFrom = (primary.mergedFrom || []).concat(others.map((o) => o.id));
      primary.updatedAt = new Date().toISOString();

      const removeIds = new Set(others.map((o) => o.id));
      const next = orders.filter((o) => !removeIds.has(o.id));
      persistOrders(next);

      console.log(`[orders] combined ${targets.length} orders on table ${primary.tableNumber} → ${primary.id} (folded in ${[...removeIds].join(", ")})`);
      res.json({ success: true, order: primary, mergedCount: targets.length, removed: [...removeIds] });
    } catch (err) {
      console.error("[merge] Error:", err.message);
      res.status(500).json({ error: "Failed to combine orders" });
    }
  });
});

// ── Manual bill adjustments (staff) ────────────────────────
// A per-order list of manual charges/discounts the bill couldn't capture from
// the QR menu — e.g. "Decaf shot +1.00", "Extra dish +12.00", "Discount -5.00".
// They never reach the kitchen ticket; they only adjust the bill total (which is
// re-derived as items + adjustments wherever the total is set).
function adjustmentsTotal(order) {
  const list = order && Array.isArray(order.adjustments) ? order.adjustments : [];
  return list.reduce((s, a) => s + (Number(a.amount) || 0), 0);
}
function recomputeOrderTotal(order) {
  const itemsSum = (order.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  order.total = clampMoney(itemsSum + adjustmentsTotal(order));
  return order.total;
}

// POST /orders/:id/adjust — add a manual charge/discount to the bill.
// Body: { label, amount }  (amount may be negative for a discount/comp)
app.post("/orders/:id/adjust", requireStaff, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: "Order not found" });
      const o = orders[idx];
      if (["paid", "pending", "refunded"].includes(o.paymentStatus)) {
        return res.status(409).json({ error: "Order is paid or being paid — can't change the bill." });
      }
      const b = req.body || {};
      const label = sanitizeString(b.label, 40).trim();
      const amount = toFiniteNumber(b.amount, NaN);
      if (!label) return res.status(400).json({ error: "A label is required (e.g. Decaf shot)" });
      if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "Enter a non-zero amount" });
      if (Math.abs(amount) > 9999.99) return res.status(400).json({ error: "Amount is too large" });
      if (!Array.isArray(o.adjustments)) o.adjustments = [];
      if (o.adjustments.length >= 30) return res.status(409).json({ error: "Too many adjustments on this order" });
      const adj = { id: crypto.randomBytes(6).toString("hex"), label, amount: Math.round(amount * 100) / 100, addedAt: new Date().toISOString() };
      o.adjustments.push(adj);
      recomputeOrderTotal(o);
      o.updatedAt = new Date().toISOString();
      persistOrders(orders);
      console.log(`[orders] ${o.id} adjust "${label}" ${amount >= 0 ? "+" : ""}${amount} → total $${o.total.toFixed(2)}`);
      res.json({ success: true, order: o, adjustment: adj });
    } catch (e) {
      console.error("[adjust] Error:", e.message);
      res.status(500).json({ error: "Failed to adjust the bill" });
    }
  });
});

// DELETE /orders/:id/adjust/:adjId — remove a manual adjustment.
app.delete("/orders/:id/adjust/:adjId", requireStaff, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: "Order not found" });
      const o = orders[idx];
      if (["paid", "pending", "refunded"].includes(o.paymentStatus)) {
        return res.status(409).json({ error: "Order is paid or being paid — can't change the bill." });
      }
      if (!Array.isArray(o.adjustments)) o.adjustments = [];
      const before = o.adjustments.length;
      o.adjustments = o.adjustments.filter((a) => a.id !== req.params.adjId);
      if (o.adjustments.length === before) return res.status(404).json({ error: "Adjustment not found" });
      recomputeOrderTotal(o);
      o.updatedAt = new Date().toISOString();
      persistOrders(orders);
      res.json({ success: true, order: o });
    } catch (e) {
      console.error("[adjust] delete error:", e.message);
      res.status(500).json({ error: "Failed to remove the adjustment" });
    }
  });
});

// ── POST /orders/:id/email-bill — public ──────────────────
app.post("/orders/:id/email-bill", resolveTenant, async (req, res) => {
  const store = req.store;
  const cfg = req.tenant.config;
  try {
    const rawEmail = (req.body && req.body.email) || "";
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Check order existence + token BEFORE checking Resend availability,
    // otherwise a probe (no token) would leak "email service not configured"
    // for an order ID the caller can't see. Keep 404 to avoid enumeration.
    const orders = store.loadOrders();
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!checkBillToken(order, req)) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!resend) {
      return res.status(503).json({ error: "Email service not configured" });
    }

    const cur = cfg.currency || "$";
    const itemLines = order.items
      .map(
        (i) =>
          `  ${i.qty}x ${i.name}${i.size ? ` (${i.size})` : ""}  —  ${cur}${(i.price * i.qty).toFixed(2)}${i.notes ? `  [${i.notes}]` : ""}`
      )
      .join("\n");

    const orderTime = new Date(order.createdAt).toLocaleString(cfg.locale || "en-NZ", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const adjLines = (Array.isArray(order.adjustments) ? order.adjustments : [])
      .map((a) => `  ${a.label}  —  ${a.amount < 0 ? "-" : "+"}${cur}${Math.abs(Number(a.amount) || 0).toFixed(2)}`)
      .join("\n");

    const restaurantName = cfg.name || req.tenant.name;
    const textBody = [
      `${restaurantName} — Your Bill`,
      `═══════════════════════════════`,
      ``,
      `Order: ${order.id}`,
      `Table: ${order.tableNumber}`,
      `Date:  ${orderTime}`,
      ``,
      `Items:`,
      itemLines,
      ...(adjLines ? [``, `Adjustments:`, adjLines] : []),
      ``,
      `───────────────────────────────`,
      `TOTAL:  ${cur}${order.total.toFixed(2)}`,
      `───────────────────────────────`,
      ``,
      `Thank you for dining with us!`,
    ].join("\n");

    // Per-tenant sender if configured; otherwise fall back to the platform's
    // verified domain with the restaurant's name on the From line.
    const fromAddr = cfg.emailFrom || BILL_EMAIL_FROM;
    const { data, error } = await resend.emails.send({
      from: fromAddr,
      to: [email],
      subject: `Your Bill — ${restaurantName} ${order.id}`,
      text: textBody,
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return res.status(502).json({ error: "Failed to send email" });
    }

    // Persist customer record under the write lock so concurrent emails don't race.
    withWriteLock(() => {
      try {
        saveCustomerEmail(store, email, order.id, order.tableNumber, order.total);
      } catch (e) {
        console.error("[customers] Persist error:", e.message);
      }
    });

    console.log(`[email] Bill sent for ${order.id} → ${maskPII(email)} (${data && data.id})`);
    res.json({ success: true, message: "Bill sent to " + email });
  } catch (err) {
    console.error("[email] Error:", err.message);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// ──────────────────────────────────────────────────────────
// ── PAYMENTS (provider-agnostic scaffolding) ──────────────
// ──────────────────────────────────────────────────────────

// POST /orders/:id/charge — initiate a payment for an order.
//
// Public (gated by billToken, like the bill lookup).  Body:
//   { provider?: "mock"|"stripe"|"windcave"|...,  returnUrl?: string }
//
// Idempotent: if the order already has a pending intent, returns that one
// instead of creating a new one.  Refuses if the order is already paid.
//
// Response shape is provider-agnostic.  Embedded providers (Stripe Elements)
// use `clientSecret`; redirect providers (Windcave PxPay, Worldline) use
// `hostedUrl`.  The customer SPA picks whichever is present.
app.post("/orders/:id/charge", resolveTenant, async (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  try {
    const orders = loadOrders();
    const idx = orders.findIndex((o) => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Order not found" });
    const order = orders[idx];
    if (!checkBillToken(order, req)) return res.status(404).json({ error: "Order not found" });

    // Fast-path guards on the snapshot (re-checked authoritatively under the lock below).
    if (order.paymentStatus === "paid") {
      return res.status(409).json({ error: "Order already paid", paymentStatus: order.paymentStatus });
    }
    if (order.paymentStatus === "pending" && order.paymentIntent) {
      return res.json({
        success: true,
        intent: order.paymentIntent,
        client: { clientSecret: order.paymentIntent.clientSecret, hostedUrl: order.paymentIntent.hostedUrl },
        reused: true,
      });
    }

    // Concurrency guard: only one in-flight charge per order.
    if (chargeInFlight.has(order.id)) {
      return res.status(409).json({ error: "A charge is already in progress for this order" });
    }
    chargeInFlight.add(order.id);
    try {
      const providerName = (req.body && req.body.provider) || "mock";
      const provider = getPaymentProvider(providerName);

      // This café takes payment at the counter after the meal. Don't let a
      // customer push their own order into a "pending"/mock payment state when
      // no real PSP is configured — an order's payment state must only ever be
      // moved by staff (the counter) or a real, signature-verified provider.
      // A signature-skipping (mock) provider is refused unless explicitly enabled.
      if (provider.skipSignature && (!ALLOW_MOCK_PAYMENTS || IS_PROD)) {
        return res.status(403).json({ error: "Online payment isn't available — please pay at the counter." });
      }

      // Online payment (a real PSP, e.g. Stripe) is offered ONLY for the coffee
      // "skip the queue" pickup pre-order — never the dine-in / full-food QR,
      // which settles at the counter. This is the server-side half of that gate
      // (the SPA only shows it in pickup mode; this stops a forged charge).
      if (!provider.skipSignature && !isPickupOrderRec(order)) {
        return res.status(403).json({ error: "Online payment is only available for coffee pickup pre-orders — please pay at the counter." });
      }

      // Real providers redirect the customer to a hosted page and need a return
      // URL to send them back to. Require + validate it (must be one of our own
      // front-ends). Mock has no redirect, so it doesn't need one.
      const returnUrl = sanitizeString((req.body && req.body.returnUrl) || "", 300).trim();
      if (!provider.skipSignature && !isAllowedReturnUrl(returnUrl)) {
        return res.status(400).json({ error: "Invalid or missing returnUrl" });
      }

      const amount = Number(order.total || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "Order total must be > 0" });

      const idempotencyKey = "ord_" + order.id.replace(/[^A-Za-z0-9]/g, "") + "_" +
        (order.paymentRetryCount || 0);

      const created = await provider.createIntent({
        orderId: order.id,
        amount,
        currency: req.tenant.config.currencyCode || "NZD",
        idempotencyKey,
        returnUrl,
        label: (req.tenant.name ? req.tenant.name + " — " : "") + "Coffee pickup " + order.id,
        metadata: {
          orderId: order.id,
          tableNumber: order.tableNumber,
          billToken: order.billToken, // round-trip in webhook for double-check
        },
      });

      // Persist intent under the lock, RE-CHECKING state on the fresh copy so a
      // concurrent webhook 'paid' or an existing pending intent isn't clobbered.
      const outcome = await new Promise((resolve, reject) => {
        withWriteLock(() => {
          try {
            const all = loadOrders();
            const j = all.findIndex((o) => o.id === order.id);
            if (j === -1) return reject(new Error("Order disappeared"));
            const cur = all[j];
            if (cur.paymentStatus === "paid") return resolve({ kind: "paid" });
            if (cur.paymentStatus === "pending" && cur.paymentIntent) {
              return resolve({ kind: "reused", intent: cur.paymentIntent });
            }
            cur.paymentStatus = "pending";
            cur.paymentIntent = {
              id: created.id,
              provider: created.provider,
              amount: created.amount,
              currency: created.currency,
              clientSecret: created.clientSecret || null,
              hostedUrl: created.hostedUrl || null,
              createdAt: new Date().toISOString(),
            };
            cur.paymentRetryCount = (cur.paymentRetryCount || 0) + 1;
            persistOrders(all);
            resolve({ kind: "created" });
          } catch (e) { reject(e); }
        });
      });

      // NOTE: on 'paid'/'reused' the intent we just created at the PSP is now
      // orphaned. Real adapters should cancel created.id in these branches.
      if (outcome.kind === "paid") {
        return res.status(409).json({ error: "Order already paid", paymentStatus: "paid" });
      }
      if (outcome.kind === "reused") {
        return res.json({
          success: true,
          intent: outcome.intent,
          client: { clientSecret: outcome.intent.clientSecret, hostedUrl: outcome.intent.hostedUrl },
          reused: true,
        });
      }

      console.log(`[pay] ${provider.name} intent ${created.id} for order ${order.id} ($${amount.toFixed(2)})`);
      res.json({
        success: true,
        intent: {
          id: created.id, provider: created.provider,
          amount: created.amount, currency: created.currency,
        },
        client: { clientSecret: created.clientSecret || null, hostedUrl: created.hostedUrl || null },
      });
    } finally {
      chargeInFlight.delete(order.id);
    }
  } catch (err) {
    console.error("[pay] charge error:", err.message);
    res.status(500).json({ error: "Failed to create payment intent" });
  }
});

// POST /webhooks/:provider — receive payment confirmation.
//
// Public, signature-verified inside the provider adapter.  Must run BEFORE
// express.json so the raw bytes are available for HMAC (configured at the top
// of this file via app.use("/webhooks", express.raw(...))).
app.post("/webhooks/:provider", resolveTenant, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  const providerName = req.params.provider;
  let event;
  try {
    const provider = getPaymentProvider(providerName);
    // Security: a provider that skips signature verification (mock) must never
    // be reachable in production — otherwise anyone can mark any order paid.
    // A provider that skips signature verification (mock) must be EXPLICITLY
    // enabled and is never reachable in production. Crucially this no longer
    // depends on NODE_ENV being set — an unset/misconfigured NODE_ENV must not
    // open a free-payment path.
    if (provider.skipSignature && (!ALLOW_MOCK_PAYMENTS || IS_PROD)) {
      console.warn(`[pay] refused unsigned webhook for '${providerName}' (ALLOW_MOCK_PAYMENTS not set, or production)`);
      return res.status(403).json({ error: "Provider not enabled" });
    }
    const sig = req.get("x-webhook-signature") || req.get("stripe-signature") || "";
    const secret = process.env[("WEBHOOK_SECRET_" + providerName).toUpperCase()] || "";
    // Real (signature-verifying) providers must have a configured secret —
    // refuse rather than silently accept unverified events on misconfig.
    if (!provider.skipSignature && !secret) {
      console.error(`[pay] webhook secret missing for '${providerName}' (set WEBHOOK_SECRET_${providerName.toUpperCase()})`);
      return res.status(503).json({ error: "Webhook not configured" });
    }
    event = provider.verifyWebhook(req.body, sig, secret);
  } catch (err) {
    console.error(`[pay] webhook ${providerName} verify failed:`, err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (!event || !event.orderId) {
    return res.status(400).json({ error: "No orderId in webhook payload" });
  }

  withWriteLock(() => {
    try {
      const all = loadOrders();
      const j = all.findIndex((o) => o.id === event.orderId);
      if (j === -1) {
        console.warn(`[pay] webhook for unknown order ${event.orderId}`);
        return res.status(200).json({ received: true, note: "unknown order" });
      }
      const o = all[j];

      // Defense-in-depth: if the provider echoed our metadata billToken, it
      // must match the order's. Real providers always echo it (set at
      // createIntent); only enforce when present so mock tests can omit it.
      if (event.billToken && o.billToken && !safeEqual(String(event.billToken), o.billToken)) {
        console.warn(`[pay] webhook billToken mismatch for order ${o.id} — rejecting`);
        return res.status(400).json({ error: "Token mismatch" });
      }

      // Verify the captured amount matches the order total. A real provider
      // always echoes the captured amount; if it's present it MUST match so a
      // tampered/partial-capture webhook can't settle an order at the wrong
      // price. (Mock/omitted amount skips this check.)
      const evAmount = event.amount != null ? Number(event.amount) : null;
      if (evAmount != null && Number.isFinite(evAmount) && Math.abs(evAmount - Number(o.total || 0)) > 0.01) {
        console.warn(`[pay] webhook amount ${evAmount} != order total ${o.total} for ${o.id} — rejecting`);
        return res.status(400).json({ error: "Amount mismatch" });
      }

      if (event.eventType === "payment.succeeded" || event.eventType === "succeeded") {
        if (o.paymentStatus === "paid") {
          // Idempotent: already processed.
          return res.status(200).json({ received: true, deduped: true });
        }
        o.paymentStatus = "paid";
        o.payment = {
          transactionId: event.transactionId,
          method: event.method || "card",
          scheme: event.scheme || null,
          last4: event.last4 || null,
          authCode: event.authCode || null,
          provider: providerName,
          capturedAt: new Date().toISOString(),
        };
        persistOrders(all);
        console.log(`[pay] ${providerName} order ${o.id} → paid (${event.scheme || "card"} •••${event.last4 || "????"})`);
        return res.status(200).json({ received: true, processed: true });
      }

      if (event.eventType === "payment.failed" || event.eventType === "failed") {
        // Never downgrade an already-captured payment — providers can deliver
        // a stale 'failed' after a 'succeeded' (out-of-order webhooks).
        if (o.paymentStatus === "paid" || o.paymentStatus === "refunded") {
          return res.status(200).json({ received: true, deduped: true, note: "already settled" });
        }
        o.paymentStatus = "failed";
        if (o.paymentIntent) o.paymentIntent.failedAt = new Date().toISOString();
        persistOrders(all);
        console.log(`[pay] ${providerName} order ${o.id} → failed`);
        return res.status(200).json({ received: true, processed: true });
      }

      if (event.eventType === "payment.refunded" || event.eventType === "refunded") {
        // Only a previously-paid order can be refunded.
        if (o.paymentStatus !== "paid") {
          return res.status(200).json({ received: true, note: "ignored, not paid" });
        }
        o.paymentStatus = "refunded";
        if (o.payment) o.payment.refundedAt = new Date().toISOString();
        persistOrders(all);
        return res.status(200).json({ received: true, processed: true });
      }

      // Unknown event type — log and 200 so the provider doesn't retry forever.
      console.warn(`[pay] webhook ${providerName} unhandled eventType: ${event.eventType}`);
      res.status(200).json({ received: true, note: "unhandled event" });
    } catch (err) {
      console.error("[pay] webhook handler error:", err.message);
      res.status(500).json({ error: "Webhook handler failed" });
    }
  });
});

// POST /orders/:id/simulate-payment — staff-only, fakes a successful webhook.
// Used to test the order → paid flow end-to-end before real PSP integration.
app.post("/orders/:id/simulate-payment", requireStaff, (req, res) => {
  // Test-only: fakes a successful capture with no real money. Gated behind the
  // same explicit flag as the mock provider so it can never fake payments in a
  // misconfigured prod.
  if (!ALLOW_MOCK_PAYMENTS || IS_PROD) {
    return res.status(403).json({ error: "simulate-payment disabled (set ALLOW_MOCK_PAYMENTS=true in a non-production env)" });
  }
  const { loadOrders, persistOrders } = req.store;
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  withWriteLock(() => {
    try {
      const all = loadOrders();
      const j = all.findIndex((o) => o.id === order.id);
      if (j === -1) { res.status(404).json({ error: "Order not found" }); return; }
      const o = all[j];
      o.paymentStatus = "paid";
      o.payment = {
        transactionId: "tx_sim_" + crypto.randomBytes(6).toString("hex"),
        method: "card",
        scheme: req.body && req.body.scheme || "visa",
        last4: req.body && req.body.last4 || "4242",
        authCode: "SIM" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        provider: "simulated",
        capturedAt: new Date().toISOString(),
      };
      persistOrders(all);
      console.log(`[pay] simulated payment for ${o.id}`);
      res.json({ success: true, order: o });
    } catch (err) {
      console.error("[pay] simulate error:", err.message);
      res.status(500).json({ error: "Failed to simulate payment" });
    }
  });
});

// ──────────────────────────────────────────────────────────
// ── REPORTS ────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────

// ── Timezone helpers ───────────────────────────────────────
// Report day-boundaries and hourly buckets are computed in the TENANT's
// timezone (config.timezone), not the server process TZ — so "today's sales"
// is correct for a restaurant in any timezone, not just NZ.
function tzParts(date, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = {};
    for (const part of dtf.formatToParts(date)) if (part.type !== "literal") p[part.type] = part.value;
    let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
    return { year: +p.year, month: +p.month, day: +p.day, hour, minute: +p.minute, second: +p.second };
  } catch {
    const d = date;
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
}
// ms to add to a UTC instant so it reads as local wall-clock time in `timeZone`.
function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}
// Real Date for local midnight at the start of "today" in `timeZone`.
function tzDayStart(now, timeZone) {
  const p = tzParts(now, timeZone);
  const wallMidnightAsUTC = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  return new Date(wallMidnightAsUTC - tzOffsetMs(now, timeZone));
}
// YYYY-MM-DD for an instant as seen in `timeZone`.
function tzDateStr(date, timeZone) {
  const p = tzParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Helpers: build a date range filter, aggregate orders into report shape.
function ordersBetween(orders, fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return orders.filter((o) => {
    if (!o.createdAt) return false;
    const t = new Date(o.createdAt).getTime();
    return t >= from && t < to;
  });
}

function aggregateReport(orders, timeZone) {
  const items = new Map();         // name → { qty, revenue }
  const hourly = new Array(24).fill(0).map((_, h) => ({ hour: h, orders: 0, revenue: 0 }));
  const tableSet = new Set();
  let totalRevenue = 0;
  let onlineIncome = 0;
  for (const o of orders) {
    const h = timeZone ? tzParts(new Date(o.createdAt), timeZone).hour : new Date(o.createdAt).getHours();
    hourly[h].orders += 1;
    hourly[h].revenue += Number(o.total || 0);
    totalRevenue += Number(o.total || 0);
    onlineIncome += Number(o.onlineSurcharge || 0);
    if (o.tableNumber != null) tableSet.add(String(o.tableNumber));
    for (const it of (o.items || [])) {
      const key = it.name || "(unknown)";
      const cur = items.get(key) || { name: key, qty: 0, revenue: 0 };
      const qty = Number(it.qty || it.quantity || 1);
      const price = Number(it.price || 0);
      cur.qty += qty;
      cur.revenue += qty * price;
      items.set(key, cur);
    }
  }
  const itemsSold = Array.from(items.values()).sort((a, b) => b.revenue - a.revenue);
  // Round currency to 2dp
  itemsSold.forEach((i) => { i.revenue = Math.round(i.revenue * 100) / 100; });
  hourly.forEach((h) => { h.revenue = Math.round(h.revenue * 100) / 100; });
  return {
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    onlineIncome: Math.round(onlineIncome * 100) / 100,
    avgOrder: orders.length ? Math.round((totalRevenue / orders.length) * 100) / 100 : 0,
    tableCount: tableSet.size,
    itemsSold,
    hourly,
  };
}

// GET /reports/today — sales for "today" in the tenant's timezone.
app.get("/reports/today", requireStaff, (req, res) => {
  const tz = req.tenant.config.timezone;
  const all = req.store.loadOrders();
  const now = new Date();
  const dayStart = tzDayStart(now, tz);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const orders = ordersBetween(all, dayStart.toISOString(), dayEnd.toISOString());
  const agg = aggregateReport(orders, tz);
  // Per-bill list (newest first) for the "Today's bills" view + day report.
  const bills = orders.slice().reverse().map((o) => ({
    id: o.id,
    billToken: o.billToken, // staff-only (requireStaff); powers the click-to-open bill link in reports.html
    createdAt: o.createdAt,
    tableNumber: o.tableNumber,
    total: Number(o.total) || 0,
    onlineSurcharge: Number(o.onlineSurcharge) || 0,
    paymentStatus: o.paymentStatus || "unpaid",
    items: (o.items || []).map((i) => ({ qty: Number(i.qty) || 1, name: i.name, size: i.size || "" })),
  }));
  res.json({
    date: tzDateStr(now, tz),
    serverTime: now.toISOString(),
    ...agg,
    bills,
  });
});

// GET /reports/week — last 7 days incl. today; daily totals + aggregated top items.
app.get("/reports/week", requireStaff, (req, res) => {
  const tz = req.tenant.config.timezone;
  const locale = req.tenant.config.locale || "en-NZ";
  const all = req.store.loadOrders();
  const now = new Date();
  const dayStart = tzDayStart(now, tz);
  const weekStart = new Date(dayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const orders = ordersBetween(all, weekStart.toISOString(), new Date(dayStart.getTime() + 24 * 60 * 60 * 1000).toISOString());
  // Per-day buckets
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
    const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    const dayOrders = ordersBetween(orders, d.toISOString(), next.toISOString());
    const revenue = dayOrders.reduce((s, o) => s + Number(o.total || 0), 0);
    days.push({
      date: tzDateStr(d, tz),
      label: d.toLocaleDateString(locale, { weekday: "short", day: "numeric", timeZone: tz }),
      orders: dayOrders.length,
      revenue: Math.round(revenue * 100) / 100,
    });
  }
  const agg = aggregateReport(orders, tz);
  res.json({
    from: tzDateStr(weekStart, tz),
    to: tzDateStr(dayStart, tz),
    serverTime: now.toISOString(),
    days,
    ...agg,
  });
});

// ── GET /customers — staff ────────────────────────────────
app.get("/customers", requireStaff, (req, res) => {
  const customers = req.store.loadCustomers();
  res.json({
    count: customers.length,
    customers: customers.slice().sort((a, b) => b.visits - a.visits),
  });
});

// ── DELETE /orders — staff + extra safety ──────────────────
app.delete("/orders", requireStaff, (req, res) => {
  if (!ALLOW_DESTRUCTIVE) {
    return res.status(403).json({
      error: "Destructive endpoint disabled. Set ALLOW_DESTRUCTIVE=true in .env to enable.",
    });
  }
  if (req.get("x-confirm-wipe") !== "yes") {
    return res.status(400).json({
      error: "Add header X-Confirm-Wipe: yes to confirm destruction",
    });
  }
  const { persistOrders } = req.store;
  withWriteLock(async () => {
    await persistOrders([]); // await the Supabase mirror so the wipe is durable before we ack
    console.log(`[orders] All orders cleared for ${req.store.slug}`);
    res.json({ success: true, message: "All orders cleared" });
  });
});

// ── DELETE /orders/:id — staff: remove ONE order ───────────
// A routine correction (test order, mistaken/duplicate ticket), so unlike the
// bulk wipe above it isn't behind ALLOW_DESTRUCTIVE — it's staff-only and
// targets a single explicit id. Removing it also drops it from the sales
// reports (which read the same store), so a test order stops inflating totals.
app.delete("/orders/:id", requireStaff, (req, res) => {
  const { loadOrders, persistOrders } = req.store;
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) { res.status(404).json({ error: "Order not found" }); return; }
      const removed = orders.splice(idx, 1)[0];
      persistOrders(orders);
      console.log(`[orders] deleted ${removed.id} (table ${removed.tableNumber}) for ${req.store.slug}`);
      res.json({ success: true, id: removed.id });
    } catch (err) {
      console.error("[orders] delete error:", err.message);
      res.status(500).json({ error: "Failed to delete order" });
    }
  });
});

// ── Terminal error handler ─────────────────────────────────
// Maps middleware-layer errors (multer uploads, body-parser size/parse) to
// clean JSON instead of Express's default HTML 500. Must be registered after
// all routes.
// ── Corporate / group pre-orders ───────────────────────────
// Create a group. Public (self-serve via the corporate QR); staff may also create.
app.post("/groups", resolveTenant, (req, res) => {
  const { loadGroups, persistGroups } = req.store;
  withWriteLock(() => {
    try {
      const b = req.body || {};
      const company = sanitizeString(b.company, 80);
      if (!company) { res.status(400).json({ error: "Group / company name is required" }); return; }
      if (!validGroupDate(b.date)) { res.status(400).json({ error: "A valid date (YYYY-MM-DD, today or later) is required" }); return; }
      if (!validGroupTime(b.arrivalTime)) { res.status(400).json({ error: "A valid arrival time (HH:MM) is required" }); return; }
      const groups = loadGroups();
      const now = new Date().toISOString();
      const group = {
        id: "g-" + crypto.randomBytes(8).toString("hex"),
        code: genGroupCode(groups),
        company,
        date: b.date,
        arrivalTime: b.arrivalTime,
        guestCount: clampQty(toFiniteNumber(b.guestCount, 0)),
        tableNumbers: sanitizeString(b.tableNumbers, 40),
        organizer: { name: sanitizeString(b.organizerName, 60), phone: sanitizeString(b.organizerPhone, 30) },
        status: "open",            // open | locked | preparing | done | cancelled
        members: [],
        source: isStaffReq(req) ? "staff" : "self",
        createdAt: now,
        updatedAt: now,
      };
      groups.push(group);
      persistGroups(groups);
      console.log(`\n👥 NEW GROUP ${group.code} — ${group.company} · ${group.date} ${group.arrivalTime} (${group.source})`);
      res.json({ success: true, code: group.code, id: group.id, joinPath: "/?r=" + req.store.slug + "&group=" + group.code, group: publicGroupView(group) });
    } catch (e) {
      console.error("[groups] create error:", e.message);
      res.status(500).json({ error: "Failed to create group" });
    }
  });
});

// Look up a group by code. Public → redacted view; staff token → full (with items).
app.get("/groups/:code", resolveTenant, (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const g = req.store.loadGroups().find((x) => x.code === code);
  if (!g) { res.status(404).json({ error: "Group not found" }); return; }
  res.json(isStaffReq(req) ? fullGroupView(g) : publicGroupView(g));
});

// A person joins a group with their NAME + order. Public.
app.post("/groups/:code/join", resolveTenant, (req, res) => {
  const { loadGroups, persistGroups, loadMenu } = req.store;
  withWriteLock(() => {
    try {
      const code = String(req.params.code || "").toUpperCase();
      const groups = loadGroups();
      const g = groups.find((x) => x.code === code);
      if (!g) { res.status(404).json({ error: "Group not found" }); return; }
      if (g.status !== "open") { res.status(409).json({ error: "This group is locked — orders are closed" }); return; }
      const b = req.body || {};
      const name = sanitizeString(b.name, 40);
      if (!name) { res.status(400).json({ error: "Your name is required" }); return; }
      const items = normalizeItems(b.items);
      if (items.length === 0) { res.status(400).json({ error: "No items in your order" }); return; }
      const menu = loadMenu();
      const pv = priceViolation(items, menu);
      if (pv) { res.status(400).json({ error: pv }); return; }
      const member = {
        memberId: crypto.randomBytes(6).toString("hex"),
        name,
        items,
        notes: sanitizeString(b.notes, 300),
        total: clampMoney(items.reduce((s, i) => s + i.price * i.qty, 0)),
        onlineSurcharge: orderSurcharge(items, menu, req.tenant.config),
        createdAt: new Date().toISOString(),
      };
      g.members.push(member);
      g.updatedAt = new Date().toISOString();
      persistGroups(groups);
      console.log(`   ➕ ${g.code}: ${name} added ${items.length} item(s) — $${member.total.toFixed(2)}`);
      res.json({ success: true, memberId: member.memberId, name: member.name, total: member.total, groupTotal: groupTotal(g), memberCount: g.members.length });
    } catch (e) {
      console.error("[groups] join error:", e.message);
      res.status(500).json({ error: "Failed to add your order" });
    }
  });
});

// List all groups (staff) — powers the dashboard "Upcoming" view.
app.get("/groups", requireStaff, (req, res) => {
  const groups = req.store.loadGroups().map(fullGroupView);
  groups.sort((a, b) => String((a.date || "") + (a.arrivalTime || "")).localeCompare(String((b.date || "") + (b.arrivalTime || ""))));
  res.json(groups);
});

// Edit a group (staff): company/date/time/table/guestCount/status.
app.patch("/groups/:id", requireStaff, (req, res) => {
  const { loadGroups, persistGroups } = req.store;
  withWriteLock(() => {
    try {
      const key = String(req.params.id || "");
      const groups = loadGroups();
      const g = groups.find((x) => x.id === key || x.code === key.toUpperCase());
      if (!g) { res.status(404).json({ error: "Group not found" }); return; }
      const b = req.body || {};
      if (b.company != null) g.company = sanitizeString(b.company, 80) || g.company;
      if (b.date != null) { if (!validGroupDate(b.date)) { res.status(400).json({ error: "Invalid date" }); return; } g.date = b.date; }
      if (b.arrivalTime != null) { if (!validGroupTime(b.arrivalTime)) { res.status(400).json({ error: "Invalid time" }); return; } g.arrivalTime = b.arrivalTime; }
      if (b.tableNumbers != null) g.tableNumbers = sanitizeString(b.tableNumbers, 40);
      if (b.guestCount != null) g.guestCount = clampQty(toFiniteNumber(b.guestCount, 0));
      if (b.organizerName != null || b.organizerPhone != null) {
        g.organizer = g.organizer || {};
        if (b.organizerName != null) g.organizer.name = sanitizeString(b.organizerName, 60);
        if (b.organizerPhone != null) g.organizer.phone = sanitizeString(b.organizerPhone, 30);
      }
      if (b.status != null) {
        const allowed = ["open", "locked", "preparing", "done", "cancelled"];
        if (!allowed.includes(b.status)) { res.status(400).json({ error: "Invalid status" }); return; }
        g.status = b.status;
      }
      g.updatedAt = new Date().toISOString();
      persistGroups(groups);
      res.json({ success: true, group: fullGroupView(g) });
    } catch (e) {
      console.error("[groups] patch error:", e.message);
      res.status(500).json({ error: "Failed to update group" });
    }
  });
});

// Remove one member from a group (staff) — fix a mistake / no-show.
app.delete("/groups/:id/members/:memberId", requireStaff, (req, res) => {
  const { loadGroups, persistGroups } = req.store;
  withWriteLock(() => {
    try {
      const key = String(req.params.id || "");
      const groups = loadGroups();
      const g = groups.find((x) => x.id === key || x.code === key.toUpperCase());
      if (!g) { res.status(404).json({ error: "Group not found" }); return; }
      const before = (g.members || []).length;
      g.members = (g.members || []).filter((m) => m.memberId !== req.params.memberId);
      if (g.members.length === before) { res.status(404).json({ error: "Member not found" }); return; }
      g.updatedAt = new Date().toISOString();
      persistGroups(groups);
      res.json({ success: true, memberCount: g.members.length, total: groupTotal(g) });
    } catch (e) {
      console.error("[groups] member delete error:", e.message);
      res.status(500).json({ error: "Failed to remove member" });
    }
  });
});

// Delete a whole group (staff) — cleanup test/cancelled bookings.
app.delete("/groups/:id", requireStaff, (req, res) => {
  const { loadGroups, persistGroups } = req.store;
  withWriteLock(() => {
    try {
      const key = String(req.params.id || "");
      const groups = loadGroups();
      const idx = groups.findIndex((x) => x.id === key || x.code === key.toUpperCase());
      if (idx < 0) { res.status(404).json({ error: "Group not found" }); return; }
      const removed = groups.splice(idx, 1)[0];
      persistGroups(groups);
      res.json({ success: true, removed: removed.code });
    } catch (e) {
      console.error("[groups] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete group" });
    }
  });
});

app.use((err, req, res, _next) => {
  if (res.headersSent) return _next(err);
  if (err && err.name === "MulterError") {
    const code = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(code).json({ error: "Upload error: " + err.message });
  }
  if (err && typeof err.message === "string" && /Only image files/.test(err.message)) {
    return res.status(415).json({ error: err.message });
  }
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "Payload too large" });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  console.error("[error]", err && err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── Boot-time Supabase restore ───────────────────────────
// If Supabase is configured, pull the tenant registry and each tenant's blobs
// and seed the corresponding local file when it's missing or empty (the
// post-Render-wipe scenario). A populated local file is trusted as-is. The
// local file remains the runtime source of truth — this just gives us survival
// across deploys.
async function restoreFromSupabase() {
  if (!supabase) return;
  // 1) The tenant registry itself.
  try {
    const localExists = fs.existsSync(TENANTS_FILE) && fs.readFileSync(TENANTS_FILE, "utf8").trim();
    if (!localExists) {
      const remote = await pullFromSupabase("tenants");
      if (remote && typeof remote === "object" && !Array.isArray(remote)) {
        writeJson(TENANTS_FILE, remote);
        console.log("[storage] restored tenants registry from Supabase");
      }
    }
  } catch (e) { console.warn("[storage] restore tenants failed:", e.message); }
  loadTenantsIntoCache();

  // 1b) The owner-accounts / sessions store (data/auth.json ↔ Supabase "auth").
  try {
    const localExists = fs.existsSync(AUTH_FILE) && fs.readFileSync(AUTH_FILE, "utf8").trim();
    if (!localExists) {
      const remote = await pullFromSupabase("auth");
      if (remote && typeof remote === "object" && !Array.isArray(remote)) {
        writeJson(AUTH_FILE, remote);
        console.log("[storage] restored owner-accounts (auth) from Supabase");
      }
    }
  } catch (e) { console.warn("[storage] restore auth failed:", e.message); }
  loadAuthIntoCache();

  // 2) Each tenant's data blobs (tenant:<slug>:<name>).
  for (const t of TENANTS.values()) {
    const dir = path.join(DATA_DIR, t.slug);
    const targets = [
      { name: "menu",      file: path.join(dir, "menu.json"),      valid: (v) => v && typeof v === "object" && !Array.isArray(v) && v.categories },
      { name: "orders",    file: path.join(dir, "orders.json"),    valid: (v) => Array.isArray(v) && v.every((o) => o && typeof o === "object" && typeof o.id === "string" && Array.isArray(o.items)) },
      { name: "customers", file: path.join(dir, "customers.json"), valid: (v) => Array.isArray(v) && v.every((c) => c && typeof c === "object" && typeof c.email === "string") },
      { name: "groups",    file: path.join(dir, "groups.json"),    valid: (v) => Array.isArray(v) && v.every((g) => g && typeof g === "object" && typeof g.code === "string") },
    ];
    for (const tg of targets) {
      try {
        const exists = fs.existsSync(tg.file);
        const empty = exists && !fs.readFileSync(tg.file, "utf8").trim();
        if (exists && !empty) continue; // local already has data — trust it
        let remote = await pullFromSupabase(tKey(t.slug, tg.name));
        // Back-compat: the single-tenant era stored data under un-prefixed keys
        // ("orders","menu",…). On the first multi-tenant boot the default
        // tenant's namespaced key is still empty, so fall back to the legacy key
        // — the original café's live menu/orders carry over with NO migration
        // step (the legacy rows are left untouched as a backup).
        if (remote == null && t.slug === LEGACY_TENANT_SLUG) {
          remote = await pullFromSupabase(tg.name);
          if (remote != null) console.log(`[storage] ${t.slug}/${tg.name}: using legacy key "${tg.name}"`);
        }
        if (remote == null) continue;
        if (!tg.valid(remote)) {
          console.warn(`[storage] restore ${t.slug}/${tg.name} skipped — unexpected shape`);
          continue;
        }
        writeJson(tg.file, remote);
        console.log(`[storage] restored ${t.slug}/${tg.name} from Supabase`);
      } catch (e) {
        console.warn(`[storage] restore ${t.slug}/${tg.name} failed:`, e.message);
      }
    }
  }
}

let server;
async function boot() {
  loadTenantsIntoCache();      // file-mode: load whatever is on disk
  loadAuthIntoCache();         // owner accounts + sessions
  await restoreFromSupabase(); // supabase-mode: pull registry + per-tenant blobs, reload cache
  ensureDefaultTenant();       // fresh install fallback: materialize the default café
  backfillDefaultTenantConfig(); // production migration: fill Crispy's new config keys if missing
  server = app.listen(PORT, () => {
  console.log(`\n🍽  Multi-tenant ordering backend running on http://localhost:${PORT}`);
  console.log(`   Mode    : Per-tenant storage (data/<slug>/) ${supabase ? "+ Supabase mirror" : "(file-only)"}`);
  console.log(`   Tenants : ${TENANTS.size} (${allTenants().map((t) => t.slug).join(", ") || "none"})`);
  console.log(`   Default : ${DEFAULT_TENANT} (used when a request has no ?r= and no staff token)`);
  console.log(`   Admin   : ${process.env.PLATFORM_ADMIN_TOKEN ? "PLATFORM_ADMIN_TOKEN set" : "PLATFORM_ADMIN_TOKEN NOT SET (/admin/* → 503)"}`);
  console.log(`   CORS    : ${allowedOrigins.length ? allowedOrigins.join(", ") : "same-origin only (set FRONTEND_ORIGIN to allow browsers)"}`);
  console.log(`\n   Endpoints:`);
  console.log(`     POST   /admin/tenants                 (platform) provision a new restaurant`);
  console.log(`     GET    /admin/tenants                 (platform) list restaurants`);
  console.log(`     GET    /start  /owner                 (public)  self-serve owner console`);
  console.log(`     POST   /signup                        (public)  self-serve café signup`);
  console.log(`     POST   /auth/request-link             (public)  email a sign-in magic link`);
  console.log(`     GET    /auth/verify                   (public)  consume magic link → session`);
  console.log(`     POST   /auth/logout                   (owner)   end the session`);
  console.log(`     GET    /me                            (owner)   account + café summary`);
  console.log(`     GET    /qr-pack                       (owner/staff) printable QR pack for your café`);
  console.log(`     POST   /menu/extract                  (public)  photo/PDF → menu items (AI)`);
  console.log(`     GET    /tenant/:slug                  (public)  branding config for the SPA`);
  console.log(`     POST   /order                         (public)  receive order from QR menu`);
  console.log(`     POST   /orders/:id/add-items          (public)  add items to open tab`);
  console.log(`     GET    /orders/:id                    (public)  bill lookup`);
  console.log(`     GET    /orders/by-table/:table        (public)  open-tab detection (no PII)`);
  console.log(`     POST   /orders/:id/email-bill         (public)  email bill`);
  console.log(`     POST   /orders/:id/charge             (public)  create payment intent (billToken)`);
  console.log(`     POST   /webhooks/:provider            (public, signed)  payment confirmation`);
  console.log(`     POST   /orders/:id/simulate-payment   (staff)   test the paid flow without a PSP`);
  console.log(`     GET    /menu                          (public)  current menu for customer SPA`);
  console.log(`     GET    /orders                        (staff)`);
  console.log(`     PATCH  /orders/:id                    (staff)`);
  console.log(`     PATCH  /menu/items/:id                (staff)   edit / toggle outOfStock`);
  console.log(`     POST   /menu/items                    (staff)   add new dish`);
  console.log(`     DELETE /menu/items/:id                (staff)   remove dish`);
  console.log(`     POST   /menu/reorder                  (staff)   reorder items in a category`);
  console.log(`     POST   /menu/items/:id/image          (staff)   upload + resize image (Supabase Storage)`);
  console.log(`     PATCH  /menu/specials                 (staff)   set/clear today's specials banner`);
  console.log(`     POST   /menu/categories/:slug/sold-out-all  (staff)  bulk sold-out toggle`);
  console.log(`     GET    /reports/today                 (staff)   today's sales report`);
  console.log(`     GET    /reports/week                  (staff)   last 7 days report`);
  console.log(`     GET    /dashboard/reports.html        (staff)   reports admin page`);
  console.log(`     GET    /customers                     (staff)`);
  console.log(`     DELETE /orders                        (staff + ALLOW_DESTRUCTIVE + X-Confirm-Wipe header)`);
  console.log(`     GET    /dashboard                     (staff, token via ?token= or Bearer)`);
  console.log(`     GET    /dashboard/menu-admin.html     (staff)   backoffice — edit menu`);
  console.log(`     GET    /health                        (public)\n`);
  });
}
boot().catch((err) => { console.error("[boot] failed:", err); process.exit(1); });

// Graceful shutdown so an in-flight write completes before exit.
function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, draining writes…`);
  const t = setTimeout(() => process.exit(0), 5000);
  writeChain.finally(() => {
    clearTimeout(t);
    // `server` is undefined if a signal arrives during boot() (while
    // restoreFromSupabase awaits network) — guard before closing.
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
