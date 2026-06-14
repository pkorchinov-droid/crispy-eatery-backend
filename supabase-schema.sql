-- Crispy Eatery backend — Supabase schema
-- Run this once in the Supabase SQL editor after creating your project.
--
-- The backend uses a single key-value table with JSONB columns. This keeps the
-- existing in-memory data shape and atomic-write semantics from the file-based
-- mode unchanged; Supabase is just a write-through backup that survives
-- Render's ephemeral disk wipes.
--
-- MULTI-TENANT: no schema change needed. The same `state` table now holds one
-- registry row under the key "tenants" plus per-restaurant blobs under keys
-- "tenant:<slug>:orders", "tenant:<slug>:menu", "tenant:<slug>:groups",
-- "tenant:<slug>:customers". Run migrate-to-tenants.js once to namespace any
-- pre-existing "orders"/"menu"/… rows into the default tenant.

create table if not exists state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Optional storage bucket for menu item images (used by the admin upload feature).
-- Create via the Supabase Storage UI, OR uncomment and run the line below.
-- Note: bucket creation via SQL requires the storage extension and matching
-- policies. Easier path is the Storage tab → New bucket → "menu-images" → Public.
--
-- insert into storage.buckets (id, name, public) values ('menu-images', 'menu-images', true)
-- on conflict (id) do nothing;

-- ── Notes ────────────────────────────────────────────────────────────────
-- The backend uses the SERVICE ROLE key, which bypasses RLS. No policies
-- needed for the `state` table.
--
-- After running this, set these two env vars on Render:
--   SUPABASE_URL          (Project settings → API → Project URL)
--   SUPABASE_SERVICE_KEY  (Project settings → API → service_role secret)
--
-- Then redeploy the backend. On boot you should see:
--   [storage] Supabase mirroring active
--   [storage] restored menu from Supabase    (if it had prior data)
