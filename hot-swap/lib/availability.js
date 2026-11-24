import { HOUR } from './time.js';

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

// Which of the given hour starts is this person free for the full hour?
export function freeHours(intervals, hourStarts) {
  return hourStarts.filter((h) => covers(intervals, h, h + HOUR));
}
