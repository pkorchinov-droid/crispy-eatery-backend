#!/usr/bin/env node
// ── One-time migration: single-tenant → multi-tenant ───────
// Carries the existing café over to the new per-tenant layout as the default
// tenant (slug "crispy"), WITHOUT data loss:
//   • copies root orders/menu/groups/customers.json → data/crispy/
//   • namespaces the Supabase mirror keys   orders → tenant:crispy:orders, …
//   • writes the tenant registry row (config from the old hardcoded constants,
//     staff token hash from the current STAFF_TOKEN) to data/tenants.json
//     and mirrors it to Supabase under the key "tenants".
//
// Safe to re-run (idempotent): it never overwrites a data/<slug> file that
// already has content, and upserts Supabase rows.
//
//   node migrate-to-tenants.js
//
// The backend ALSO auto-creates the default tenant on boot if none exists, so
// running this is only required to (a) keep existing orders/menu, and (b) move
// the Supabase blobs into the tenant namespace before the first multi-tenant
// deploy.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SLUG = (process.env.DEFAULT_TENANT || "crispy").toLowerCase().replace(/[^a-z0-9-]/g, "");
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const TENANT_DIR = path.join(DATA_DIR, SLUG);

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readJson(file) {
  try { if (fs.existsSync(file)) { const raw = fs.readFileSync(file, "utf8"); if (raw.trim()) return JSON.parse(raw); } } catch (e) { console.warn("  ! read", path.basename(file), e.message); }
  return null;
}
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function hashToken(t) { return crypto.createHash("sha256").update(String(t)).digest("hex"); }
function hasContent(file) { try { return fs.existsSync(file) && !!fs.readFileSync(file, "utf8").trim(); } catch { return false; } }

// The config that reproduces the original Crispy behaviour exactly.
const CRISPY_CONFIG = {
  name: "Crispy Eatery",
  established: "Est. 2014",
  themeColor: "#c25a3a",
  logoUrl: null,
  currency: "$",
  currencyCode: "NZD",
  gstRate: 0.15,
  locale: "en-NZ",
  timezone: "Pacific/Auckland",
  emailFrom: "Crispy Eatery <bills@eatery.crispycatering.com>",
  surcharge: { coffee: 0.20, tea: 0.20, signature: 0.20, "all-day": 0.60, sets: 0.60, mains: 0.60, burgers: 0.60, crepes: 0.60, kids: 0.60, desserts: 0.60, sides: 0.20 },
  surchargeDefault: 0.60,
  features: { groups: true, preorder: true, printing: true },
};

const FILES = [
  { name: "orders.json",    key: "orders" },
  { name: "menu.json",      key: "menu", seed: "menu-seed.json" },
  { name: "groups.json",    key: "groups" },
  { name: "customers.json", key: "customers" },
];

async function main() {
  console.log(`\n── Migrating to multi-tenant (default slug: "${SLUG}") ──\n`);
  ensureDir(TENANT_DIR);

  // 1) Copy local root files into data/<slug>/ (don't clobber existing).
  for (const f of FILES) {
    const dest = path.join(TENANT_DIR, f.name);
    if (hasContent(dest)) { console.log(`  = data/${SLUG}/${f.name} already present — kept`); continue; }
    let src = path.join(ROOT, f.name);
    if (!hasContent(src) && f.seed && hasContent(path.join(ROOT, f.seed))) src = path.join(ROOT, f.seed);
    if (hasContent(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  → copied ${path.basename(src)} → data/${SLUG}/${f.name}`);
    } else {
      console.log(`  · no local ${f.name} to copy`);
    }
  }

  // 2) Tenant registry row.
  const tenantsFile = path.join(DATA_DIR, "tenants.json");
  const registry = readJson(tenantsFile) || {};
  if (!registry[SLUG]) {
    registry[SLUG] = {
      name: CRISPY_CONFIG.name,
      config: CRISPY_CONFIG,
      staffTokenHash: process.env.STAFF_TOKEN ? hashToken(process.env.STAFF_TOKEN) : "",
      createdAt: new Date().toISOString(),
    };
    writeJson(tenantsFile, registry);
    console.log(`  → wrote tenant registry row for "${SLUG}"${process.env.STAFF_TOKEN ? "" : " (no STAFF_TOKEN set → dashboard locked)"}`);
  } else {
    console.log(`  = tenant "${SLUG}" already in registry — kept`);
  }

  // 3) Supabase: namespace existing keys + push the registry.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = require("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    console.log("\n  Supabase configured — namespacing mirror keys:");
    async function pull(key) { const { data, error } = await supabase.from("state").select("value").eq("key", key).maybeSingle(); if (error) { console.warn("    ! pull", key, error.message); return null; } return data ? data.value : null; }
    async function upsert(key, value) { const { error } = await supabase.from("state").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" }); if (error) console.warn("    ! upsert", key, error.message); else console.log(`    → ${key}`); }
    for (const f of FILES) {
      const newKey = `tenant:${SLUG}:${f.key}`;
      if (await pull(newKey) != null) { console.log(`    = ${newKey} already present — kept`); continue; }
      const old = await pull(f.key);
      if (old != null) await upsert(newKey, old);
      else {
        // fall back to whatever we just wrote locally (e.g. seeded menu)
        const local = readJson(path.join(TENANT_DIR, f.name));
        if (local != null) await upsert(newKey, local);
      }
    }
    await upsert("tenants", registry);
  } else {
    console.log("\n  (Supabase not configured — skipped mirror namespacing; file mode only.)");
  }

  console.log(`\n✓ Migration complete. Existing data now lives under tenant "${SLUG}".`);
  console.log(`  Set PLATFORM_ADMIN_TOKEN to provision more restaurants at /admin.\n`);
}

main().catch((e) => { console.error("\n✗ Migration failed:", e); process.exit(1); });
