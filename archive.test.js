// Offline tests for archive.js — run: node archive.test.js
// NOTE: monthKey uses process-local time; pin TZ like server.js does so
// assertions are stable regardless of the host machine's zone.
process.env.TZ = "Pacific/Auckland";
const assert = require("assert");
const { monthKey, liveCutoffKey, partitionOrders, mergeArchive, summarizeMonth, isMonthKey } = require("./archive");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.error("  ✗ " + name + " — " + e.message); }
}

// Fixed "now": 15 July 2026 local. Live window = 2026-07 + 2026-06.
const NOW = new Date(2026, 6, 15, 12, 0, 0);
const o = (id, iso, status, total, fee) => ({ id, createdAt: iso, status, total, developerFee: fee, items: [] });

t("monthKey buckets in local time", () => {
  assert.strictEqual(monthKey("2026-06-27T11:18:22.397Z"), "2026-06");
  // 2026-05-31T23:30Z is already 1 June in Auckland (UTC+12) — local bucketing.
  assert.strictEqual(monthKey("2026-05-31T23:30:00.000Z"), "2026-06");
  assert.strictEqual(monthKey("garbage"), null);
});

t("liveCutoffKey is the previous month", () => {
  assert.strictEqual(liveCutoffKey(NOW), "2026-06");
  assert.strictEqual(liveCutoffKey(new Date(2026, 0, 3)), "2025-12"); // year rollover
});

t("partition keeps current + previous month", () => {
  const { keep, archiveByMonth } = partitionOrders([
    o("#1", "2026-07-10T01:00:00Z", "done"),
    o("#2", "2026-06-10T01:00:00Z", "done"),
    o("#3", "2026-05-10T01:00:00Z", "done"),
    o("#4", "2026-04-10T01:00:00Z", "picked_up"),
  ], NOW);
  assert.deepStrictEqual(keep.map(x => x.id), ["#1", "#2"]);
  assert.deepStrictEqual(Object.keys(archiveByMonth).sort(), ["2026-04", "2026-05"]);
  assert.strictEqual(archiveByMonth["2026-05"][0].id, "#3");
});

t("open orders never archive, any age", () => {
  const { keep, archiveByMonth } = partitionOrders([
    o("#old-tab", "2026-03-01T01:00:00Z", "received"),
    o("#old-prep", "2026-03-01T01:00:00Z", "preparing"),
    o("#old-ready", "2026-03-01T01:00:00Z", "ready"),
    o("#old-done", "2026-03-01T01:00:00Z", "done"),
  ], NOW);
  assert.deepStrictEqual(keep.map(x => x.id), ["#old-tab", "#old-prep", "#old-ready"]);
  assert.strictEqual(archiveByMonth["2026-03"].length, 1);
});

t("invalid createdAt is kept, never archived", () => {
  const { keep, archiveByMonth } = partitionOrders([o("#bad", "not-a-date", "done")], NOW);
  assert.strictEqual(keep.length, 1);
  assert.deepStrictEqual(archiveByMonth, {});
});

t("empty / non-array input is safe", () => {
  assert.deepStrictEqual(partitionOrders(null, NOW), { keep: [], archiveByMonth: {} });
  assert.deepStrictEqual(partitionOrders([], NOW).keep, []);
});

t("mergeArchive dedups by id, existing wins, sorted ascending", () => {
  const merged = mergeArchive(
    [o("#a", "2026-05-02T01:00:00Z", "done", 10), o("#b", "2026-05-05T01:00:00Z", "done", 20)],
    [o("#b", "2026-05-05T01:00:00Z", "done", 999), o("#c", "2026-05-01T01:00:00Z", "done", 30)]
  );
  assert.deepStrictEqual(merged.map(x => x.id), ["#c", "#a", "#b"]);
  assert.strictEqual(merged.find(x => x.id === "#b").total, 20); // existing copy kept
});

t("mergeArchive re-run with same incoming is a no-op (crash-replay safety)", () => {
  const once = mergeArchive([], [o("#a", "2026-05-02T01:00:00Z", "done")]);
  const twice = mergeArchive(once, [o("#a", "2026-05-02T01:00:00Z", "done")]);
  assert.deepStrictEqual(twice, once);
});

t("summarizeMonth totals count/revenue/fee, rounds to cents", () => {
  const s = summarizeMonth("2026-05", [
    o("#a", "2026-05-02T01:00:00Z", "done", 10.005, 2),
    o("#b", "2026-05-03T01:00:00Z", "done", 5.10, 2),
    { id: "#junk", createdAt: "2026-05-04T01:00:00Z", status: "done", total: "x", developerFee: null, items: [] },
  ]);
  assert.deepStrictEqual(s, { month: "2026-05", count: 3, revenue: 15.11, fee: 4 });
});

t("isMonthKey validates YYYY-MM", () => {
  assert.ok(isMonthKey("2026-05") && isMonthKey("1999-12"));
  ["2026-13", "2026-0", "2026-005", "26-05", "2026-05-01", "", null, "../../etc"].forEach(x =>
    assert.ok(!isMonthKey(x), "should reject " + x));
});

console.log(`\narchive.test: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
