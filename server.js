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

const app = express();
const PORT = process.env.PORT || 3001;
const STAFF_TOKEN = process.env.STAFF_TOKEN || "";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ""; // comma-separated allowlist; empty = same-origin only
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE === "true";
// Tabs are table-shared by default (anyone at the table can add to the open
// order — the intended QR UX). Set STRICT_TAB_TOKEN=true to require the order's
// billToken on /add-items, locking tabs to the device that created them.
const STRICT_TAB_TOKEN = process.env.STRICT_TAB_TOKEN === "true";
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

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
app.use(express.json({ limit: "64kb" }));

// ── Auth middleware ────────────────────────────────────────
function requireStaff(req, res, next) {
  if (!STAFF_TOKEN) {
    return res.status(503).json({ error: "Staff auth not configured" });
  }
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (!token || token !== STAFF_TOKEN) {
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

// ── Order storage ──────────────────────────────────────────
const ORDERS_FILE = path.join(__dirname, "orders.json");

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const raw = fs.readFileSync(ORDERS_FILE, "utf8");
      if (!raw.trim()) return [];
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[orders] Error loading orders file:", e.message);
  }
  return [];
}

function persistOrders(orders) {
  atomicWriteSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  // Strip ephemeral dedup state from the backup copy (not worth mirroring).
  const forBackup = orders.map((o) => {
    const { _lastAddHash, _lastAddAt, ...rest } = o;
    return rest;
  });
  return mirrorToSupabase("orders", forBackup);
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

// ── Group (corporate pre-order) storage ────────────────────
// A "group" is one booking (company + date + arrival time) that many people join
// by code and add their own NAMED order to — one combined bill. Mirrored to
// Supabase (key "groups") like orders, so a booking survives a redeploy.
const GROUPS_FILE = path.join(__dirname, "groups.json");
function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      const raw = fs.readFileSync(GROUPS_FILE, "utf8");
      if (!raw.trim()) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) { console.error("[groups] load error:", e.message); }
  return [];
}
function persistGroups(groups) {
  atomicWriteSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
  return mirrorToSupabase("groups", groups);
}
const GROUP_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
function genGroupCode(groups) {
  const taken = new Set(groups.map((g) => g.code));
  for (let tries = 0; tries < 80; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += GROUP_CODE_CHARS[crypto.randomInt(GROUP_CODE_CHARS.length)];
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
    members: (g.members || []).map((m) => ({ name: m.name, itemCount: (m.items || []).reduce((n, i) => n + (i.qty || 1), 0) })),
    total: groupTotal(g),
  };
}
function fullGroupView(g) { return Object.assign({}, g, { total: groupTotal(g), onlineSurcharge: groupSurcharge(g) }); }
function isStaffReq(req) {
  if (!STAFF_TOKEN) return false;
  const h = req.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : req.query.token;
  return !!tok && tok === STAFF_TOKEN;
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

// ── Menu storage ───────────────────────────────────────────
// menu-seed.json ships with the repo and is the canonical default; menu.json
// is the runtime mutable copy. On Render free-tier the disk is ephemeral, so
// edits made via the backoffice survive UNTIL the next backend deploy (same
// caveat as orders.json — fix later with a real DB).
const MENU_FILE = path.join(__dirname, "menu.json");
const MENU_SEED_FILE = path.join(__dirname, "menu-seed.json");

function loadMenu() {
  // Boot path: if menu.json missing, seed from menu-seed.json
  if (!fs.existsSync(MENU_FILE) && fs.existsSync(MENU_SEED_FILE)) {
    try {
      const seed = fs.readFileSync(MENU_SEED_FILE, "utf8");
      atomicWriteSync(MENU_FILE, seed);
      console.log("[menu] seeded menu.json from menu-seed.json");
    } catch (e) {
      console.error("[menu] Failed to seed:", e.message);
    }
  }
  try {
    if (fs.existsSync(MENU_FILE)) {
      const raw = fs.readFileSync(MENU_FILE, "utf8");
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[menu] Error loading menu file:", e.message);
  }
  // Last-resort empty menu — shouldn't happen if seed file is present
  return { version: 1, updatedAt: new Date().toISOString(), categoryOrder: [], categories: {} };
}

function persistMenu(menu) {
  menu.version = (menu.version || 0) + 1;
  menu.updatedAt = new Date().toISOString();
  atomicWriteSync(MENU_FILE, JSON.stringify(menu, null, 2));
  mirrorToSupabase("menu", menu);
}

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

// ── Customer email storage ─────────────────────────────────
const CUSTOMERS_FILE = path.join(__dirname, "customers.json");

function loadCustomers() {
  try {
    if (fs.existsSync(CUSTOMERS_FILE)) {
      const raw = fs.readFileSync(CUSTOMERS_FILE, "utf8");
      if (!raw.trim()) return [];
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[customers] Error loading file:", e.message);
  }
  return [];
}

function persistCustomers(customers) {
  atomicWriteSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
  mirrorToSupabase("customers", customers);
}

function saveCustomerEmail(email, orderId, tableNumber, total) {
  const customers = loadCustomers();
  const existing = customers.find((c) => c.email === email);
  if (existing) {
    existing.visits += 1;
    existing.totalSpent += total;
    existing.lastVisit = new Date().toISOString();
    existing.orders.push(orderId);
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
  persistCustomers(customers);
  console.log(`[customers] Saved ${email} (${existing ? "returning" : "new"} customer)`);
}

// ── Validators ────────────────────────────────────────────
const VALID_STATUSES = new Set([
  "received",
  "preparing",
  "ready",
  "picked_up",
  "done",
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

// ── Health check ───────────────────────────────────────────
app.get("/", (_req, res) => {
  const orders = loadOrders();
  res.json({
    status: "ok",
    mode: "local",
    totalOrders: orders.length,
    note: "Doshii integration pending — orders stored locally",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: "local",
    totalOrders: loadOrders().length,
  });
});

// ── POST /order — receive order from QR menu (PUBLIC) ─────
app.post("/order", (req, res) => {
  withWriteLock(() => {
    try {
      const { tableNumber, items, notes, guestCount, phoneNumber } = req.body || {};

      const normalizedItems = normalizeItems(items);
      if (normalizedItems.length === 0) {
        res.status(400).json({ error: "No items in order" });
        return;
      }

      // Reject forged/underpriced items against the authoritative menu.
      const menu = loadMenu();
      const pv = priceViolation(normalizedItems, menu);
      if (pv) {
        res.status(400).json({ error: pv });
        return;
      }

      const orders = loadOrders();
      const order = {
        id: nextOrderId(orders),
        billToken: crypto.randomBytes(24).toString("hex"),
        // Only coerce primitives; an object/array body value would otherwise
        // become garbage like "[object " — fall back to "?" instead.
        tableNumber: sanitizeString(
          (typeof tableNumber === "string" || typeof tableNumber === "number") ? String(tableNumber) : "?",
          8
        ) || "?",
        guestCount: clampQty(toFiniteNumber(guestCount, 1)),
        items: normalizedItems,
        phoneNumber: sanitizeString(phoneNumber, 30),
        notes: sanitizeString(notes, 500),
        total: normalizedItems.reduce(
          (sum, i) => sum + i.price * i.qty,
          0
        ),
        status: "received",
        paymentStatus: "unpaid",   // unpaid | pending | paid | failed | refunded
        createdAt: new Date().toISOString(),
      };
      order.total = clampMoney(order.total);
      order.onlineSurcharge = orderSurcharge(normalizedItems, menu);

      orders.push(order);
      persistOrders(orders);

      console.log(`\n${"═".repeat(50)}`);
      console.log(`🔔 NEW ORDER ${order.id}`);
      console.log(`   Table: ${order.tableNumber} | Guests: ${order.guestCount}${order.phoneNumber ? ` | Phone: ${order.phoneNumber}` : ""}`);
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
        message: `Order received — Table ${order.tableNumber}`,
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
  let orders = loadOrders();
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
app.get("/orders/by-table/:table", (req, res) => {
  const table = String(req.params.table || "");
  const orders = loadOrders().filter(
    (o) => String(o.tableNumber) === table && o.status !== "done"
  );
  res.json({
    count: orders.length,
    orders: orders.map((o) => ({
      id: o.id,
      tableNumber: o.tableNumber,
      itemCount: o.items.length,
      total: o.total,
      status: o.status,
      paymentStatus: o.paymentStatus || "unpaid",
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
// NZ Fair Trading guidance (avoids "drip pricing"). Base prices in menu.json,
// the admin (/menu?raw=1) and the in-store/Lightspeed flow are untouched.
// Tune per category here; set a value to 0 to exempt a category.
const ONLINE_SURCHARGE = {
  // drinks
  coffee: 0.20, tea: 0.20, signature: 0.20,
  // food
  "all-day": 0.60, sets: 0.60, mains: 0.60, burgers: 0.60, crepes: 0.60, kids: 0.60, desserts: 0.60,
  // cheap add-on sides — keep light
  sides: 0.20,
};
const ONLINE_SURCHARGE_DEFAULT = 0.60; // any future/unknown category
function categorySurcharge(slug) {
  const v = ONLINE_SURCHARGE[slug];
  return typeof v === "number" ? v : ONLINE_SURCHARGE_DEFAULT;
}
function bumpPrice(n, add) {
  return typeof n === "number" ? Math.round((n + add) * 100) / 100 : n;
}
// Return a COPY of the menu with the per-category surcharge added to every
// price/size. Never mutates the cached base menu.
function withOnlineSurcharge(menu) {
  const out = JSON.parse(JSON.stringify(menu || {}));
  for (const slug of (out.categoryOrder || [])) {
    const cat = out.categories && out.categories[slug];
    if (!cat || !Array.isArray(cat.items)) continue;
    const add = categorySurcharge(slug);
    if (!add) continue;
    for (const it of cat.items) {
      if (typeof it.price === "number") it.price = bumpPrice(it.price, add);
      if (it.sizes && typeof it.sizes === "object") {
        for (const k of Object.keys(it.sizes)) it.sizes[k] = bumpPrice(it.sizes[k], add);
      }
    }
  }
  out.onlineSurcharge = { drink: ONLINE_SURCHARGE.coffee, food: ONLINE_SURCHARGE.mains, sides: ONLINE_SURCHARGE.sides };
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
function orderSurcharge(items, menu) {
  let s = 0;
  for (const it of (items || [])) {
    const slug = findItemCategory(menu, it);
    if (slug == null) continue;
    s += categorySurcharge(slug) * (Number(it.qty) || 1);
  }
  return Math.round(s * 100) / 100;
}

// GET /menu — public, returns the current menu.  The customer SPA fetches
// this on boot and falls back to the bundled menu if we're unreachable.
// ?raw=1 returns BASE prices (used by the staff menu admin); the default
// response has the online surcharge baked into each price.
app.get("/menu", (req, res) => {
  const menu = loadMenu();
  res.set("Cache-Control", "no-cache");
  const raw = req.query && (req.query.raw === "1" || req.query.raw === "true");
  res.json(raw ? menu : withOnlineSurcharge(menu));
});

// PATCH /menu/items/:id — staff, update any subset of an item's fields.
// Allowed fields: name, desc, price, sizes, tags, outOfStock, imgRight, img.
app.patch("/menu/items/:id", requireStaff, (req, res) => {
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

app.post("/menu/items/:id/image", requireStaff, imageUpload.single("image"), async (req, res) => {
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

    const fileName = `${req.params.id}-${Date.now()}.jpg`;
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

// DELETE /menu/items/:id — staff, remove an item from the menu.
app.delete("/menu/items/:id", requireStaff, (req, res) => {
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

// ── GET /orders/:id — public (for bill page lookup) ───────
// Requires ?t=<billToken> for orders created with a token. Returns redacted
// data (no phone, no cooked/picked state, no internal fields).
app.get("/orders/:id", (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!checkBillToken(order, req)) {
    // Don't distinguish "wrong token" from "no token" — both look like 404.
    // Prevents enumeration of valid order IDs.
    return res.status(404).json({ error: "Order not found" });
  }
  res.json({
    id: order.id,
    tableNumber: order.tableNumber,
    // Strip lineId from bill response — it's an internal kitchen-state key
    // and isn't needed for rendering the bill.
    items: order.items.map((i) => ({
      name: i.name,
      size: i.size,
      qty: i.qty,
      price: i.price,
      notes: i.notes,
    })),
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
app.post("/orders/:id/add-items", (req, res) => {
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
      if (orders[idx].paymentStatus === "pending" || orders[idx].paymentStatus === "paid") {
        res.status(409).json({ error: "Order is being paid or already paid — cannot add items" });
        return;
      }

      const newItems = normalizeItems(req.body && req.body.items);
      if (newItems.length === 0) {
        res.status(400).json({ error: "No items to add" });
        return;
      }

      // Reject forged/underpriced additions against the menu (best-effort:
      // /add-items lines carry no id, so this matches by name).
      const pv = priceViolation(newItems, loadMenu());
      if (pv) {
        res.status(400).json({ error: pv });
        return;
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

      orders[idx].items = [...orders[idx].items, ...newItems];
      orders[idx].total = clampMoney(
        orders[idx].items.reduce((sum, i) => sum + (i.price || 0) * (i.qty || 1), 0)
      );
      orders[idx].onlineSurcharge = clampMoney((orders[idx].onlineSurcharge || 0) + orderSurcharge(newItems, loadMenu()));
      orders[idx].status = "received";
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
  withWriteLock(() => {
    try {
      const orders = loadOrders();
      const idx = orders.findIndex((o) => o.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: "Order not found" });
        return;
      }

      const { status, cookedItems, pickedItems } = req.body || {};
      if (!status && cookedItems === undefined && pickedItems === undefined) {
        res.status(400).json({ error: "Status or item state required" });
        return;
      }
      if (status && !VALID_STATUSES.has(status)) {
        res.status(400).json({ error: "Invalid status" });
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
      orders[idx].updatedAt = new Date().toISOString();
      persistOrders(orders);

      console.log(`[orders] ${orders[idx].id} → ${status || "(state update)"}`);
      res.json({ success: true, order: orders[idx] });
    } catch (err) {
      console.error("[patch] Error:", err.message);
      res.status(500).json({ error: "Failed to update order" });
    }
  });
});

// ── POST /orders/:id/email-bill — public ──────────────────
app.post("/orders/:id/email-bill", async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || "";
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Check order existence + token BEFORE checking Resend availability,
    // otherwise a probe (no token) would leak "email service not configured"
    // for an order ID the caller can't see. Keep 404 to avoid enumeration.
    const orders = loadOrders();
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!checkBillToken(order, req)) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!resend) {
      return res.status(503).json({ error: "Email service not configured" });
    }

    const itemLines = order.items
      .map(
        (i) =>
          `  ${i.qty}x ${i.name}${i.size ? ` (${i.size})` : ""}  —  $${(i.price * i.qty).toFixed(2)}${i.notes ? `  [${i.notes}]` : ""}`
      )
      .join("\n");

    const orderTime = new Date(order.createdAt).toLocaleString("en-NZ", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const textBody = [
      `Crispy Eatery — Your Bill`,
      `═══════════════════════════════`,
      ``,
      `Order: ${order.id}`,
      `Table: ${order.tableNumber}`,
      `Date:  ${orderTime}`,
      ``,
      `Items:`,
      itemLines,
      ``,
      `───────────────────────────────`,
      `TOTAL:  $${order.total.toFixed(2)}`,
      `───────────────────────────────`,
      ``,
      `Thank you for dining with us!`,
    ].join("\n");

    const { data, error } = await resend.emails.send({
      from: "Crispy Eatery <bills@eatery.crispycatering.com>",
      to: [email],
      subject: `Your Bill — Crispy Eatery ${order.id}`,
      text: textBody,
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return res.status(502).json({ error: "Failed to send email" });
    }

    // Persist customer record under the write lock so concurrent emails don't race.
    withWriteLock(() => {
      try {
        saveCustomerEmail(email, order.id, order.tableNumber, order.total);
      } catch (e) {
        console.error("[customers] Persist error:", e.message);
      }
    });

    console.log(`[email] Bill sent for ${order.id} → ${email} (${data && data.id})`);
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
app.post("/orders/:id/charge", async (req, res) => {
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

      const amount = Number(order.total || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "Order total must be > 0" });

      const idempotencyKey = "ord_" + order.id.replace(/[^A-Za-z0-9]/g, "") + "_" +
        (order.paymentRetryCount || 0);

      const created = await provider.createIntent({
        orderId: order.id,
        amount,
        currency: "NZD",
        idempotencyKey,
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
app.post("/webhooks/:provider", (req, res) => {
  const providerName = req.params.provider;
  let event;
  try {
    const provider = getPaymentProvider(providerName);
    // Security: a provider that skips signature verification (mock) must never
    // be reachable in production — otherwise anyone can mark any order paid.
    if (provider.skipSignature && IS_PROD) {
      console.warn(`[pay] refused unsigned webhook for '${providerName}' in production`);
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

function aggregateReport(orders) {
  const items = new Map();         // name → { qty, revenue }
  const hourly = new Array(24).fill(0).map((_, h) => ({ hour: h, orders: 0, revenue: 0 }));
  const tableSet = new Set();
  let totalRevenue = 0;
  let onlineIncome = 0;
  for (const o of orders) {
    const h = new Date(o.createdAt).getHours();
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

// GET /reports/today — sales for "today" in the server's timezone.
app.get("/reports/today", requireStaff, (_req, res) => {
  const all = loadOrders();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const orders = ordersBetween(all, dayStart.toISOString(), dayEnd.toISOString());
  const agg = aggregateReport(orders);
  // Per-bill list (newest first) for the "Today's bills" view + day report.
  const bills = orders.slice().reverse().map((o) => ({
    id: o.id,
    billToken: o.billToken,
    createdAt: o.createdAt,
    tableNumber: o.tableNumber,
    total: Number(o.total) || 0,
    onlineSurcharge: Number(o.onlineSurcharge) || 0,
    paymentStatus: o.paymentStatus || "unpaid",
    items: (o.items || []).map((i) => ({ qty: Number(i.qty) || 1, name: i.name, size: i.size || "" })),
  }));
  res.json({
    date: dayStart.toISOString().slice(0, 10),
    serverTime: now.toISOString(),
    ...agg,
    bills,
  });
});

// GET /reports/week — last 7 days incl. today; daily totals + aggregated top items.
app.get("/reports/week", requireStaff, (_req, res) => {
  const all = loadOrders();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric" }),
      orders: dayOrders.length,
      revenue: Math.round(revenue * 100) / 100,
    });
  }
  const agg = aggregateReport(orders);
  res.json({
    from: weekStart.toISOString().slice(0, 10),
    to: dayStart.toISOString().slice(0, 10),
    serverTime: now.toISOString(),
    days,
    ...agg,
  });
});

// ── GET /customers — staff ────────────────────────────────
app.get("/customers", requireStaff, (_req, res) => {
  const customers = loadCustomers();
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
  withWriteLock(async () => {
    await persistOrders([]); // await the Supabase mirror so the wipe is durable before we ack
    console.log("[orders] All orders cleared");
    res.json({ success: true, message: "All orders cleared" });
  });
});

// ── Terminal error handler ─────────────────────────────────
// Maps middleware-layer errors (multer uploads, body-parser size/parse) to
// clean JSON instead of Express's default HTML 500. Must be registered after
// all routes.
// ── Corporate / group pre-orders ───────────────────────────
// Create a group. Public (self-serve via the corporate QR); staff may also create.
app.post("/groups", (req, res) => {
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
      res.json({ success: true, code: group.code, id: group.id, joinPath: "/?group=" + group.code, group: publicGroupView(group) });
    } catch (e) {
      console.error("[groups] create error:", e.message);
      res.status(500).json({ error: "Failed to create group" });
    }
  });
});

// Look up a group by code. Public → redacted view; staff token → full (with items).
app.get("/groups/:code", (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const g = loadGroups().find((x) => x.code === code);
  if (!g) { res.status(404).json({ error: "Group not found" }); return; }
  res.json(isStaffReq(req) ? fullGroupView(g) : publicGroupView(g));
});

// A person joins a group with their NAME + order. Public.
app.post("/groups/:code/join", (req, res) => {
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
        onlineSurcharge: orderSurcharge(items, menu),
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
app.get("/groups", requireStaff, (_req, res) => {
  const groups = loadGroups().map(fullGroupView);
  groups.sort((a, b) => String((a.date || "") + (a.arrivalTime || "")).localeCompare(String((b.date || "") + (b.arrivalTime || ""))));
  res.json(groups);
});

// Edit a group (staff): company/date/time/table/guestCount/status.
app.patch("/groups/:id", requireStaff, (req, res) => {
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
// If Supabase is configured, pull each blob and seed the corresponding local
// file when the local file is missing or empty (the post-Render-wipe scenario,
// since menu.json/orders.json/customers.json are gitignored and never ship).
// A populated local file is trusted as-is. The local file remains the runtime
// source of truth — this just gives us survival across deploys.
async function restoreFromSupabase() {
  if (!supabase) return;
  const targets = [
    { key: "menu",      file: MENU_FILE,      valid: (v) => v && typeof v === "object" && !Array.isArray(v) && v.categories } ,
    { key: "orders",    file: ORDERS_FILE,    valid: Array.isArray },
    { key: "customers", file: CUSTOMERS_FILE, valid: Array.isArray },
    { key: "groups",    file: GROUPS_FILE,    valid: Array.isArray },
  ];
  for (const t of targets) {
    try {
      const exists = fs.existsSync(t.file);
      const empty  = exists && !fs.readFileSync(t.file, "utf8").trim();
      if (exists && !empty) continue; // local already has data — trust it
      const remote = await pullFromSupabase(t.key);
      if (remote == null) continue; // remote also empty — nothing to restore
      if (!t.valid(remote)) {        // guard against a malformed/corrupt blob
        console.warn(`[storage] restore ${t.key} skipped — remote blob has unexpected shape`);
        continue;
      }
      atomicWriteSync(t.file, JSON.stringify(remote, null, 2));
      console.log(`[storage] restored ${t.key} from Supabase`);
    } catch (e) {
      console.warn(`[storage] restore ${t.key} failed:`, e.message);
    }
  }
}

let server;
async function boot() {
  await restoreFromSupabase();
  server = app.listen(PORT, () => {
  const orders = loadOrders();
  const menu = loadMenu();
  const itemCount = (menu.categoryOrder || []).reduce(
    (n, slug) => n + ((menu.categories[slug] && menu.categories[slug].items) || []).length, 0);
  console.log(`\n🍳 Crispy Eatery backend running on http://localhost:${PORT}`);
  console.log(`   Mode    : Local storage (orders + menu)`);
  console.log(`   Orders  : ${orders.length} saved`);
  console.log(`   Menu    : v${menu.version || "?"} · ${(menu.categoryOrder || []).length} categories · ${itemCount} items`);
  console.log(`   Auth    : ${STAFF_TOKEN ? "STAFF_TOKEN set" : "STAFF_TOKEN NOT SET (staff routes 503)"}`);
  console.log(`   CORS    : ${allowedOrigins.length ? allowedOrigins.join(", ") : "same-origin only (set FRONTEND_ORIGIN to allow browsers)"}`);
  console.log(`\n   Endpoints:`);
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
