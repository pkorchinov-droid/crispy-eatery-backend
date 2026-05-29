require("dotenv").config();
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
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

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
  return items.slice(0, 100).map((item) => ({
    name: sanitizeString(item && item.name, 120),
    size: sanitizeString(item && item.size, 80),
    qty: clampQty(toFiniteNumber(item && (item.qty != null ? item.qty : item.quantity), 1)),
    price: clampMoney(toFiniteNumber(item && item.price, 0)),
    notes: sanitizeString(item && item.notes, 300),
    // lineId is always server-generated — never trust client input. If a
    // customer harvested a lineId from their own bill (which exposes them)
    // and reused it via /add-items, two rows could collide on dashboard state.
    lineId: crypto.randomBytes(8).toString("hex"),
  }));
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

      const orders = loadOrders();
      const order = {
        id: nextOrderId(orders),
        billToken: crypto.randomBytes(24).toString("hex"),
        tableNumber: sanitizeString(String(tableNumber || "?"), 8) || "?",
        guestCount: clampQty(toFiniteNumber(guestCount, 1)),
        items: normalizedItems,
        phoneNumber: sanitizeString(phoneNumber, 30),
        notes: sanitizeString(notes, 500),
        total: normalizedItems.reduce(
          (sum, i) => sum + i.price * i.qty,
          0
        ),
        status: "received",
        createdAt: new Date().toISOString(),
      };
      order.total = clampMoney(order.total);

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
      createdAt: o.createdAt,
    })),
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

      const newItems = normalizeItems(req.body && req.body.items);
      if (newItems.length === 0) {
        res.status(400).json({ error: "No items to add" });
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
  withWriteLock(() => {
    persistOrders([]);
    console.log("[orders] All orders cleared");
    res.json({ success: true, message: "All orders cleared" });
  });
});

// ── Start ──────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const orders = loadOrders();
  console.log(`\n🍳 Crispy Eatery backend running on http://localhost:${PORT}`);
  console.log(`   Mode    : Local order storage`);
  console.log(`   Orders  : ${orders.length} saved`);
  console.log(`   Auth    : ${STAFF_TOKEN ? "STAFF_TOKEN set" : "STAFF_TOKEN NOT SET (staff routes 503)"}`);
  console.log(`   CORS    : ${allowedOrigins.length ? allowedOrigins.join(", ") : "same-origin only (set FRONTEND_ORIGIN to allow browsers)"}`);
  console.log(`\n   Endpoints:`);
  console.log(`     POST  /order                         (public)  receive order from QR menu`);
  console.log(`     POST  /orders/:id/add-items          (public)  add items to open tab`);
  console.log(`     GET   /orders/:id                    (public)  bill lookup`);
  console.log(`     GET   /orders/by-table/:table        (public)  open-tab detection (no PII)`);
  console.log(`     POST  /orders/:id/email-bill         (public)  email bill`);
  console.log(`     GET   /orders                        (staff)`);
  console.log(`     PATCH /orders/:id                    (staff)`);
  console.log(`     GET   /customers                     (staff)`);
  console.log(`     DELETE /orders                       (staff + ALLOW_DESTRUCTIVE + X-Confirm-Wipe header)`);
  console.log(`     GET   /dashboard                     (staff, token via ?token= or Bearer)`);
  console.log(`     GET   /health                        (public)\n`);
});

// Graceful shutdown so an in-flight write completes before exit.
function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, draining writes…`);
  const t = setTimeout(() => process.exit(0), 5000);
  writeChain.finally(() => {
    clearTimeout(t);
    server.close(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
