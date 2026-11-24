// Pure roster planning. No I/O here so it can be unit-tested.
//
// input:
//   hours:      [8, 9, ..., 20]                         local hours to cover
//   people:     [{ id, name, free: Set<hour>, load }]   load = calls already booked that day
//   headcount:  (hour) => number of people wanted that hour
//   maxConsecutive: cap on back-to-back hours for one person
//   locked:     Map<hour, id[]> already-assigned people (kept as-is, e.g. existing blocks)
// output: { assignments: Map<hour, id[]>, gaps: [{ hour, missing }] }
export function planRoster({ hours, people, headcount, maxConsecutive = 3, locked = new Map() }) {
  const assignments = new Map();
  const count = new Map(people.map((p) => [p.id, 0]));
  const gaps = [];

  for (const hour of hours) {
    const want = headcount(hour);
    const chosen = [...(locked.get(hour) || [])];
    chosen.forEach((id) => count.set(id, (count.get(id) || 0) + 1));

    const prev = assignments.get(hour - 1) || [];
    const streak = (id) => {
      let n = 0;
      for (let h = hour - 1; (assignments.get(h) || []).includes(id); h--) n++;
      return n;
    };

    const candidates = people
      .filter((p) => p.free.has(hour) && !chosen.includes(p.id) && streak(p.id) < maxConsecutive)
      .sort((a, b) =>
        // 1. keep someone who is already on (fewer context switches)
        (prev.includes(b.id) - prev.includes(a.id)) ||
        // 2. spread hours evenly
        (count.get(a.id) - count.get(b.id)) ||
        // 3. lighter call load that day
        (a.load - b.load) ||
        a.name.localeCompare(b.name));

    while (chosen.length < want && candidates.length) {
      const p = candidates.shift();
      chosen.push(p.id);
      count.set(p.id, count.get(p.id) + 1);
    }
    assignments.set(hour, chosen);
    if (chosen.length < want) gaps.push({ hour, missing: want - chosen.length });
  }
  return { assignments, gaps };
}

// Best replacement for one hour after someone drops out.
export function pickReplacement({ hour, people, exclude = [] }) {
  return people
    .filter((p) => p.free.has(hour) && !exclude.includes(p.id))
    .sort((a, b) => (a.load - b.load) || a.name.localeCompare(b.name))[0] || null;
}
