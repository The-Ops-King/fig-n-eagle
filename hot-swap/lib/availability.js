// Turn bookable slot starts into continuous free intervals.
// A slot at s means [s, s + duration) is bookable. Consecutive slots exactly `interval`
// apart mean the time between them is free too (covers calendars where duration < interval).
export function slotsToIntervals(slots, durationMin, intervalMin) {
  const dur = durationMin * 60_000;
  const step = intervalMin * 60_000;
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const raw = sorted.map((s, i) => {
    const next = sorted[i + 1];
    const end = next !== undefined && next - s === step ? Math.max(s + dur, next) : s + dur;
    return [s, end];
  });
  const merged = [];
  for (const [s, e] of raw) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export function covers(intervals, start, end) {
  return intervals.some(([s, e]) => s <= start && e >= end);
}

// Which of the given hour starts can this person cover? They must be free from the top of the
// hour for `minFreeMinutes` (default: one full 45-minute call). Requiring the full 60 minutes
// would rule out everyone's last hour, because the final slot of a day only spans one call.
//
// For an hour already under way, GHL no longer returns its past slots, so check from the next
// slot boundary (now rounded up to `stepMinutes`) to the end of the hour instead.
export function freeHours(intervals, hourStarts, minFreeMinutes = 45, { now = 0, stepMinutes = 30 } = {}) {
  const need = Math.min(minFreeMinutes, 60) * 60_000;
  const step = stepMinutes * 60_000;
  return hourStarts.filter((h) => {
    const end = h + 60 * 60_000;
    if (now <= h) return covers(intervals, h, h + need);
    if (now >= end) return false;
    const from = Math.ceil(now / step) * step;
    if (from >= end) return false;
    return covers(intervals, from, Math.min(from + need, end));
  });
}
