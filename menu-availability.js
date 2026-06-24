"use strict";
// Time-of-day menu availability — lets a category be shown only inside a daily
// window (e.g. a lunch menu until 3pm, a dinner menu from 3pm). Categories carry
// an optional `avail: { from?: "HH:MM", to?: "HH:MM" }`; a category with no
// `avail` is always visible, so menus that don't use this feature are unchanged.
//
// Kept as a tiny pure module so the window logic is unit-testable in isolation
// and the server just calls filterMenuByTime() on the public /menu payload.

// "HH:MM" -> minutes since midnight (0..1439), or null if not a valid time.
function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Is a category visible at `nowMin` (minutes since local midnight)?
// Fails OPEN: missing window, or an unparseable bound, keeps the category visible
// — better to show an item too long than to silently hide the whole menu.
function categoryVisibleAt(avail, nowMin) {
  if (!avail || (avail.from == null && avail.to == null)) return true;
  let fromM = avail.from == null ? 0 : parseHHMM(avail.from);
  let toM = avail.to == null ? 1440 : parseHHMM(avail.to);
  if (fromM == null || toM == null) return true; // unparseable -> always show
  if (fromM <= toM) return nowMin >= fromM && nowMin < toM;
  // Overnight window (e.g. 22:00 -> 02:00): visible across the midnight wrap.
  return nowMin >= fromM || nowMin < toM;
}

// Current wall-clock minute-of-day in `timezone`. Falls back to host local time
// if the timezone is unknown/invalid. `date` defaults to now (injectable for tests).
function localMinutesNow(timezone, date) {
  const d = date || new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const hh = Number(parts.find((p) => p.type === "hour").value);
    const mm = Number(parts.find((p) => p.type === "minute").value);
    return hh * 60 + mm;
  } catch {
    return d.getHours() * 60 + d.getMinutes();
  }
}

// Return the menu with only the categories visible at the current time in
// `timezone`. Mutates and returns the passed object (callers pass a fresh clone).
// `nowMinOverride` lets tests pin the time deterministically.
function filterMenuByTime(menu, timezone, nowMinOverride) {
  if (!menu || !Array.isArray(menu.categoryOrder) || !menu.categories) return menu;
  const nowMin = typeof nowMinOverride === "number"
    ? nowMinOverride
    : localMinutesNow(timezone);
  const keep = [];
  for (const slug of menu.categoryOrder) {
    const cat = menu.categories[slug];
    if (cat && !categoryVisibleAt(cat.avail, nowMin)) {
      delete menu.categories[slug];
    } else {
      keep.push(slug);
    }
  }
  menu.categoryOrder = keep;
  return menu;
}

module.exports = { parseHHMM, categoryVisibleAt, localMinutesNow, filterMenuByTime };
