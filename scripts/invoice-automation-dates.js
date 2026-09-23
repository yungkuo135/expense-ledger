const DAY_MS = 24 * 60 * 60 * 1000;

export function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDate(year, month, day) {
  return new Date(year, month, day, 12, 0, 0, 0);
}

export function rollingInvoiceRanges(now = new Date(), lookbackDays = 14) {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new Error("lookbackDays must be a positive integer");
  }
  const end = localDate(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getTime() - (lookbackDays - 1) * DAY_MS);
  const ranges = [];
  let cursor = start;
  while (cursor <= end) {
    const monthEnd = localDate(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const rangeEnd = monthEnd < end ? monthEnd : end;
    ranges.push({
      start: dateKey(cursor),
      end: dateKey(rangeEnd),
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
    });
    cursor = localDate(
      rangeEnd.getFullYear(),
      rangeEnd.getMonth(),
      rangeEnd.getDate() + 1,
    );
  }
  return ranges;
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = localDate(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return dateKey(date) === value ? date : null;
}

export function catchUpInvoiceRanges(
  lastSuccessDate,
  now = new Date(),
  maxDaysPerQuery = 3,
  overlapDays = 1,
) {
  const lastSuccess = parseDateKey(lastSuccessDate);
  if (!lastSuccess) return rollingInvoiceRanges(now, maxDaysPerQuery);
  if (!Number.isInteger(maxDaysPerQuery) || maxDaysPerQuery < 1) {
    throw new Error("maxDaysPerQuery must be a positive integer");
  }
  const end = localDate(now.getFullYear(), now.getMonth(), now.getDate());
  let cursor = new Date(lastSuccess.getTime() - overlapDays * DAY_MS);
  if (cursor > end) cursor = end;
  const ranges = [];
  while (cursor <= end) {
    const maxEnd = new Date(cursor.getTime() + (maxDaysPerQuery - 1) * DAY_MS);
    const monthEnd = localDate(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const rangeEnd = [maxEnd, monthEnd, end].reduce((earliest, value) =>
      value < earliest ? value : earliest
    );
    ranges.push({
      start: dateKey(cursor),
      end: dateKey(rangeEnd),
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
    });
    cursor = localDate(
      rangeEnd.getFullYear(),
      rangeEnd.getMonth(),
      rangeEnd.getDate() + 1,
    );
  }
  return ranges;
}
