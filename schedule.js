export function resolveServeDate(hhmm, now) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export function computeSchedule(items, serveAt, now, acked = new Set()) {
  const valid = items.filter(
    (it) => it.name.trim() !== "" && Number.isFinite(it.minutes) && it.minutes > 0,
  );
  const entries = valid.map((it) => {
    const start = new Date(serveAt.getTime() - it.minutes * 60_000);
    let status;
    if (now >= serveAt) status = "served";
    else if (now < start) status = "waiting";
    else if (!acked.has(it.id)) status = "due";
    else status = "cooking";
    return { id: it.id, name: it.name, minutes: it.minutes, start, status };
  });
  entries.sort((a, b) => a.start - b.start);
  return { serveAt, entries };
}
