// Time-zone helpers with no dependencies. All instants are epoch milliseconds.

const HOUR = 3_600_000;
export { HOUR };

function parts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
export { parts };

// UTC offset (ms) of `timeZone` at instant `ms`.
function offsetAt(ms, timeZone) {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in `timeZone` -> epoch ms. Handles DST by re-checking the offset.
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(ms, timeZone);
  if (second !== ms) ms = second;
  return ms;
}

// "YYYY-MM-DD" of the given instant in `timeZone`.
export function dateKey(ms, timeZone) {
  const p = parts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

// Calendar day after `key`.
export function nextDateKey(key) {
  const { year, month, day } = parseDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(key) {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Start instant of local hour `hour` on day `key` in `timeZone`.
export function hourStart(key, hour, timeZone) {
  return zonedToUtc({ ...parseDateKey(key), hour }, timeZone);
}

export function hourLabel(hour) {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

export function formatDay(key) {
  const { year, month, day } = parseDateKey(key);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}
