// Isolated browser smoke test: synthetic data, in-memory storage, no cloud access.
import { chromium } from "npm:playwright-core@1.62.1";
import { Buffer } from "node:buffer";
import { createRequestHandler } from "./dev-server.js";

const values = {};
const entries = ["cash", "creditcard", "invoice"].map((source, i) => ({
  id: `demo-${i}`,
  source,
  date: `2026-09-${23 - i}`,
  ts: 100 + i,
  amount: 100 + i,
  originalAmount: 100 + i,
  category: "餐飲",
  vendor: ["早餐店", "測試商店", "咖啡店"][i],
  note: "",
  originalVendor: "",
  originalNote: "",
  bank: source === "creditcard" ? "富邦" : "",
  originalBank: "",
  ...(source === "invoice" ? { invoiceNo: "AB12345678" } : {}),
}));
values["expense-entries-2026-09"] = JSON.stringify(entries);
const handler = createRequestHandler({
  get: (key) => key in values ? { value: values[key] } : null,
  set: (key, value) => {
    values[key] = value;
  },
  delete: (key) => {
    delete values[key];
  },
  list: (prefix) => ({
    keys: Object.keys(values).filter((k) => k.startsWith(prefix)),
  }),
});
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 18765 },
  async (request) => {
    const headers = new Headers(request.headers);
    headers.delete("origin");
    return handler(new Request(request, { headers }));
  },
);
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.url().startsWith("http://127.0.0.1:18765/")) {
      return route.continue();
    }
    if (!request.url().startsWith("http://127.0.0.1:8000/")) {
      return route.abort();
    }
    const response = await handler(
      new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() ? { body: request.postData() } : {}),
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    });
  });
  for (
    const [name, width, height] of [["desktop", 1440, 1000], [
      "mobile",
      390,
      844,
    ]]
  ) {
    for (const key of Object.keys(values)) delete values[key];
    values["expense-entries-2026-09"] = JSON.stringify(entries);
    await page.setViewportSize({ width, height });
    await page.goto("http://127.0.0.1:18765/?storage=file", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("body:not(.data-loading) .transaction-row");
    const check = (ok, message) => {
      if (!ok) throw new Error(`${name}: ${message}`);
    };
    check(
      await page.evaluate(() => {
        const items = ["牛奶", "雞蛋", "吐司", "蘋果"].map((note) => ({
          vendor: "超市",
          note,
          source: "invoice",
        }));
        return transactionSummary({ items }) ===
            "牛奶、雞蛋、吐司… · 共 4 項" &&
          transactionSummary({
              entry: { source: "cash", note: "早餐", category: "餐飲" },
            }) === "" &&
          transactionSummary({
              entry: {
                source: "creditcard",
                vendor: "餐廳",
                note: "聚餐",
                bank: "富邦",
              },
            }) === "聚餐 · 富邦";
      }),
      "transaction summaries",
    );
    check(
      await page.locator("#view-home").isVisible(),
      "home is not transactions",
    );
    check(
      !await page.locator("#searchInput").isVisible(),
      "search should be collapsed",
    );
    check(
      await page.locator(".transaction-date-heading").count() === 3,
      "date groups",
    );
    check(
      (await page.locator(".transaction-source").allTextContents()).join("")
        .includes("💳"),
      "source icon",
    );
    await page.locator("#filterToolsSummary").click();
    await page.locator("#searchInput").fill("早餐");
    await page.screenshot({
      path: `/tmp/ledger-${name}-filters.png`,
      fullPage: true,
      animations: "disabled",
    });
    check(
      await page.locator(".transaction-row").count() === 1,
      "search results",
    );
    await page.locator("#filterToolsSummary").click();
    check(
      await page.locator("#filterSummary").isVisible(),
      "collapsed filter state",
    );
    await page.locator('[data-clear-filter="all"]').click();
    await page.locator("#monthFilter").fill("2026-08");
    check(
      await page.locator(".transaction-row").count() === 0,
      "month filtering",
    );
    await page.locator('[data-clear-filter="all"]').click();
    await page.locator(".transaction-row").first().click();
    check(
      await page.locator("#closeTransactionDetail").isVisible(),
      "detail opening",
    );
    await page.screenshot({
      path: `/tmp/ledger-${name}-detail.png`,
      fullPage: true,
    });
    await page.locator("#closeTransactionDetail").click();
    await page.locator("#addActionBtn").click();
    check(await page.locator("#cashEntryPanel").isVisible(), "cash drawer");
    await page.keyboard.press("Escape");
    check(!await page.locator("#cashDrawer").isVisible(), "cash drawer close");
    for (const view of ["imports", "inbox", "stats", "home"]) {
      await page.locator(`[data-nav-view="${view}"]`).click();
      check(
        await page.locator(`#view-${view}`).isVisible(),
        `navigation ${view}`,
      );
    }
    check(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
      "horizontal overflow",
    );
    await page.screenshot({
      path: `/tmp/ledger-${name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    console.log(`${name}: interaction checks passed`);
    check(
      await page.locator(".day-total").allTextContents().then((values) =>
        values.join(",") === "$100,$101,$102"
      ),
      "daily totals",
    );
    check(
      await page.locator(".transaction-month .month-total").textContent() ===
        "$303",
      "monthly total",
    );
    await page.locator(".transaction-month > summary").click();
    check(
      !await page.locator(".transaction-row").first().isVisible(),
      "month collapse",
    );
    await page.locator(".transaction-month > summary").click();
    check(
      await page.locator(".transaction-row").first().isVisible(),
      "month expand",
    );
    check(
      (await page.locator('[data-transaction-id="demo-1"]').textContent())
        .includes("待確認"),
      "pending card indicator",
    );
    await page.evaluate(() => {
      const invoice = entries.find((e) => e.source === "invoice");
      invoice.amount = 0;
      invoice.edited = true;
      render();
    });
    check(
      await page.locator(".transaction-row .original-amount").textContent() ===
        "原 $102",
      "original amount retained in list",
    );
    check(
      await page.locator(".transaction-month .month-total").textContent() ===
        "$201",
      "zero personal share total",
    );
    await page.locator('[data-transaction-id="invoice:AB12345678"]').click();
    for (
      const selector of [".amt", ".cat-tag", ".note", ".del", ".edited-badge"]
    ) {
      check(
        await page.locator(`#transactionAside ${selector}`).count() === 1,
        `detail control ${selector}`,
      );
    }
    await page.locator("#transactionAside .amt").click();
    await page.locator(".amt-edit-input").fill("102");
    await page.locator(".amt-edit-input").press("Enter");
    await page.waitForFunction(() =>
      document.querySelector(".transaction-month .month-total")?.textContent ===
        "$303"
    );
    await page.locator("#closeTransactionDetail").click();
    await page.evaluate(() => {
      const invoice = entries.find((e) => e.source === "invoice");
      invoice.vendor = "富胖達股份有限公司";
      invoice.note = "平台服務費平台費";
      render();
    });
    const platformRow = page.locator(".transaction-row").filter({
      hasText: "富胖達股份有限公司",
    });
    check(
      await platformRow.locator(".transaction-excluded").isVisible(),
      "platform fee badge",
    );
    check(
      await page.locator(".transaction-excluded").count() === 1,
      "ordinary rows must not be marked excluded",
    );
    check(
      await page.evaluate(() =>
        entries.filter(isCounted).reduce((sum, e) => sum + e.amount, 0) === 201
      ),
      "platform fee excluded from total",
    );
    await platformRow.click();
    check(
      await page.locator(".transaction-exclusion-note").isVisible(),
      "platform fee explanation",
    );
    await page.screenshot({
      path: `/tmp/ledger-${name}-platform-fee.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.locator("#closeTransactionDetail").click();
    await page.evaluate(() => {
      const invoice = entries.find((e) => e.source === "invoice");
      invoice.matchedId = "demo-1";
      render();
    });
    check(
      await page.locator(".transaction-excluded").count() === 0,
      "matched invoice must not carry platform fee exclusion",
    );
    await platformRow.click();
    check(
      await page.locator(".transaction-exclusion-note").count() === 0,
      "matched invoice must not show platform fee explanation",
    );
    await page.locator("#closeTransactionDetail").click();
    await page.evaluate(() => {
      const invoice = entries.find((e) => e.source === "invoice");
      invoice.vendor = "咖啡店";
      invoice.note = "";
      delete invoice.matchedId;
      render();
    });
    console.log(`${name}: platform fee exclusion display checks passed`);
    await page.evaluate(() => {
      entries.find((e) => e.id === "demo-1").suggestedInvoiceNo = "AB12345678";
      render();
    });
    await page.locator('[data-transaction-id="demo-1"]').click();
    check(
      await page.locator("#transactionAside .merge-btn").isVisible(),
      "suggested merge action",
    );
    check(
      await page.locator("#transactionAside .reject-btn").isVisible(),
      "reject suggestion action",
    );
    await page.locator("#transactionAside .merge-btn").click();
    await page.waitForFunction(() =>
      entries.find((e) => e.id === "demo-1").matchedId === "AB12345678" &&
      !document.querySelector('[data-transaction-id="demo-1"]')
    );
    check(
      await page.locator(".transaction-month .month-total").textContent() ===
        "$202",
      "matched card counted only once",
    );
    await page.locator('[data-transaction-id="invoice:AB12345678"]').click();
    check(
      await page.locator("#transactionAside .bank-tag").isVisible(),
      "linked bank editing",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#transactionAside .unmatch-btn").click();
    await page.waitForSelector('[data-transaction-id="demo-1"]');
    check(
      await page.locator(".transaction-month .month-total").textContent() ===
        "$303",
      "unmatched totals restored",
    );
    await page.locator("#closeTransactionDetail").click();
    await page.evaluate(() => {
      entries.find((e) => e.id === "demo-1").reviewed = false;
      render();
    });
    await page.locator('[data-transaction-id="demo-1"]').click();
    await page.locator("#transactionAside .confirm-btn").click();
    await page.waitForFunction(() =>
      !document.querySelector("#transactionAside .confirm-btn")
    );
    await page.locator("#transactionAside .bank-tag").click();
    await page.locator(".bank-edit-input").fill("台新");
    await page.locator(".bank-edit-input").press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("#transactionAside .bank-tag")?.textContent ===
        "台新"
    );
    await page.locator("#transactionAside .note").click();
    await page.locator(".note-edit-input").fill("測試備註");
    await page.locator(".note-edit-input").press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("#transactionAside .note")?.textContent ===
        "測試備註"
    );
    await page.locator("#transactionAside .cat-tag").click();
    await page.locator(".cat-select").selectOption("其他");
    await page.waitForFunction(() =>
      document.querySelector("#transactionAside .cat-tag")?.textContent ===
        "其他"
    );
    await page.locator("#closeTransactionDetail").click();
    console.log(
      `${name}: merge, unmatch, confirm and detail editing checks passed`,
    );
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) {
        entries.push({
          ...entries[0],
          id: `scroll-${i}`,
          ts: i,
          vendor: `測試 ${i}`,
        });
      }
      render();
    });
    const target = page.locator(".transaction-row").nth(35);
    await target.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.testRows = document.getElementById("transactionRows");
      window.testScrollY = scrollY;
      window.testTarget = document.querySelectorAll(".transaction-row")[35];
    });
    for (const closeMethod of ["button", "escape"]) {
      await target.click();
      check(
        await page.evaluate(() =>
          testRows === document.getElementById("transactionRows")
        ),
        "opening rebuilt list",
      );
      if (closeMethod === "button") {
        await page.locator("#closeTransactionDetail").click();
      } else await page.keyboard.press("Escape");
      check(
        await page.evaluate(() =>
          testRows === document.getElementById("transactionRows")
        ),
        "closing rebuilt list",
      );
      check(
        await page.evaluate(() => Math.abs(scrollY - testScrollY) < 2),
        `scroll changed (${closeMethod})`,
      );
      check(
        await page.evaluate(() => document.activeElement === testTarget),
        "focus not restored to selected row",
      );
    }
    console.log(
      `${name}: scrolled detail close preserves DOM, position and focus`,
    );
    const upload = ["2026/08/31", "2026/09/01"].map((date, i) => ({
      name: `synthetic-${i}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(
        `發票日期,發票號碼,賣方名稱,消費明細_金額,消費明細_品名\n${date},ZZ0000000${i},測試新增店家,35,測試品項`,
      ),
    }));
    await page.locator("#invoiceFile").setInputFiles(upload);
    await page.locator("#confirmImportBtn").click();
    await page.waitForSelector("#importPreviewBackdrop", { state: "hidden" });
    check(
      await page.locator(".transaction-row").count() === 2,
      "import result excludes existing entries",
    );
    check(
      await page.locator(".transaction-month[open]").count() === 2,
      "cross-month import visible",
    );
    check(
      (await page.locator(".transaction-list > .transaction-exclusion-note")
        .textContent()).includes("2 張發票 · 2 個品項 · 計入支出 $70"),
      "import result summary",
    );
    check(
      await page.locator(".import-result-review").textContent() ===
        "處理 1 個待分類品項 →",
      "import result unclassified action",
    );
    await page.locator(".import-result-review").click();
    check(
      await page.locator("#view-inbox").isVisible(),
      "open imported unclassified",
    );
    check(await page.locator("#aiWorkflow").isVisible(), "AI workflow visible");
    check(
      (await page.locator("#unclassifiedOutput").inputValue()).includes(
        "測試品項",
      ),
      "imported unclassified prompt prepared",
    );
    await page.locator('[data-nav-view="home"]').click();
    check(
      await page.locator(".transaction-row").count() === 2,
      "import result retained after classification navigation",
    );
    await page.locator(".transaction-row").first().click();
    check(
      await page.locator("#transactionAside .amt").isVisible(),
      "import result detail editable",
    );
    await page.locator("#closeTransactionDetail").click();
    await page.screenshot({
      path: `/tmp/ledger-${name}-import-result.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.locator("#invoiceFile").setInputFiles(upload);
    await page.locator("#confirmImportBtn").click();
    await page.waitForSelector("#importPreviewBackdrop", { state: "hidden" });
    check(
      await page.locator(".transaction-row").count() === 0,
      "duplicate-only import must not show previous batch",
    );
    await page.locator('[data-clear-filter="all"]').click();
    await page.locator('[data-nav-view="imports"]').click();
    await page.getByRole("button", { name: "查看新增消費" }).first().click();
    check(
      await page.locator(".transaction-row").count() === 2,
      "reopen saved batch",
    );
    await page.evaluate(() => {
      invoiceImportResult.batch.undone = true;
      render();
    });
    check(
      await page.locator(".transaction-row").count() === 0,
      "rolled-back batch hidden",
    );
    console.log(
      `${name}: cross-month import, duplicates, history and rollback result checks passed`,
    );
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
  await server.shutdown();
}
