import {
  catchUpInvoiceRanges,
  rollingInvoiceRanges,
} from "../scripts/invoice-automation-dates.js";

function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `值不相等\nactual: ${JSON.stringify(actual)}\nexpected: ${
        JSON.stringify(expected)
      }`,
    );
  }
}

function assertThrows(callback) {
  let threw = false;
  try {
    callback();
  } catch (_) {
    threw = true;
  }
  if (!threw) throw new Error("預期函式拋出錯誤");
}

Deno.test("發票自動化：同月查詢維持單一區間", () => {
  assertEquals(rollingInvoiceRanges(new Date(2026, 8, 21, 9), 14), [
    { start: "2026-09-08", end: "2026-09-21", year: 2026, month: 9 },
  ]);
});

Deno.test("發票自動化：跨月時拆成個別月份查詢", () => {
  assertEquals(rollingInvoiceRanges(new Date(2026, 8, 7, 9), 14), [
    { start: "2026-08-25", end: "2026-08-31", year: 2026, month: 8 },
    { start: "2026-09-01", end: "2026-09-07", year: 2026, month: 9 },
  ]);
});

Deno.test("發票自動化：跨年時仍按月份拆分", () => {
  assertEquals(rollingInvoiceRanges(new Date(2027, 0, 4, 9), 14), [
    { start: "2026-12-22", end: "2026-12-31", year: 2026, month: 12 },
    { start: "2027-01-01", end: "2027-01-04", year: 2027, month: 1 },
  ]);
});

Deno.test("發票自動化：拒絕無效回查天數", () => {
  assertThrows(() => rollingInvoiceRanges(new Date(), 0));
});

Deno.test("發票自動化：關機多日後以三天區間補齊並保留兩個重疊日期", () => {
  assertEquals(catchUpInvoiceRanges("2026-08-25", new Date(2026, 8, 3, 9)), [
    { start: "2026-08-24", end: "2026-08-26", year: 2026, month: 8 },
    { start: "2026-08-27", end: "2026-08-29", year: 2026, month: 8 },
    { start: "2026-08-30", end: "2026-08-31", year: 2026, month: 8 },
    { start: "2026-09-01", end: "2026-09-03", year: 2026, month: 9 },
  ]);
});

Deno.test("發票自動化：每日正常執行只產生一個三天查詢", () => {
  assertEquals(catchUpInvoiceRanges("2026-09-06", new Date(2026, 8, 7, 9)), [
    { start: "2026-09-05", end: "2026-09-07", year: 2026, month: 9 },
  ]);
});

Deno.test("發票自動化：沒有成功紀錄時只查最近三天", () => {
  assertEquals(catchUpInvoiceRanges(null, new Date(2026, 8, 3, 9)), [
    { start: "2026-09-01", end: "2026-09-03", year: 2026, month: 9 },
  ]);
});
