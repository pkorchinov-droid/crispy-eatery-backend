// Order archival — bound the live orders.json working set.
//
// The live file keeps the CURRENT and PREVIOUS calendar month (so the console's
// 7-day analytics, today/yesterday reports and recent billing always come from
// the live set), plus every order that is still open regardless of age (an
// unsettled tab must stay visible to Billing until it is bumped/paid).
// Everything older and finished moves into per-month blobs
// (orders-archive-YYYY-MM), each with a tiny forever-summary the console uses
// for the monthly fee/revenue chart without downloading the blob.
//
// Month boundaries use process-local time: server.js pins process.env.TZ to
// the café's zone, so these match the console's client-side (café-device)
// date bucketing.

// Only finished orders may leave the live set.
const ARCHIVABLE_STATUSES = new Set(["done", "picked_up"]);

function pad2(n) { return String(n).padStart(2, "0"); }

// 'YYYY-MM' in process-local time; null for invalid dates.
function monthKey(dateLike) {
  const d = new Date(dateLike);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
}

// The oldest month that stays live (the previous calendar month).
function liveCutoffKey(now) {
  const d = now ? new Date(now) : new Date();
  return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}

// Split orders into { keep, archiveByMonth }. An order is archived only when
// it is finished AND created before the previous calendar month. Orders with
// unparseable createdAt are kept — never silently discard data we can't date.
function partitionOrders(orders, now) {
  const cutoff = liveCutoffKey(now);
  const keep = [];
  const archiveByMonth = {};
  for (const o of Array.isArray(orders) ? orders : []) {
    const mk = o && monthKey(o.createdAt);
    if (mk && mk < cutoff && ARCHIVABLE_STATUSES.has(o && o.status)) {
      (archiveByMonth[mk] = archiveByMonth[mk] || []).push(o);
    } else {
      keep.push(o);
    }
  }
  return { keep, archiveByMonth };
}

// Merge new orders into an existing archive blob. Archived orders are
// immutable, so on an id collision the existing copy wins (a crash between
// "archive written" and "live file shrunk" makes the next run resend the same
// orders — this is what makes that harmless). Sorted by createdAt ascending.
function mergeArchive(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const list of [existing, incoming]) {
    for (const o of Array.isArray(list) ? list : []) {
      const id = o && o.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push(o);
    }
  }
  out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Tiny forever-summary of one archived month, for the console's monthly chart.
function summarizeMonth(month, orders) {
  let revenue = 0, fee = 0;
  for (const o of Array.isArray(orders) ? orders : []) {
    revenue += Number(o && o.total) || 0;
    fee += Number(o && o.developerFee) || 0;
  }
  return { month, count: Array.isArray(orders) ? orders.length : 0, revenue: round2(revenue), fee: round2(fee) };
}

// 'YYYY-MM' route-param guard for the archive fetch endpoint.
function isMonthKey(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || "")); }

module.exports = { ARCHIVABLE_STATUSES, monthKey, liveCutoffKey, partitionOrders, mergeArchive, summarizeMonth, isMonthKey };
