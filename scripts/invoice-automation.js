import { chromium } from "npm:playwright-core@1.62.1";
import {
  catchUpInvoiceRanges,
  dateKey,
  rollingInvoiceRanges,
} from "./invoice-automation-dates.js";

const PROJECT_ROOT = new URL("../", import.meta.url);
const PRIVATE_ROOT = new URL("test-fixtures/private/automation/", PROJECT_ROOT);
const PROFILE_PATH = new URL("chrome-profile/", PRIVATE_ROOT).pathname;
const DOWNLOADS_PATH = new URL("downloads/", PRIVATE_ROOT).pathname;
const SCHEDULE_STATE_PATH = new URL("schedule-state.json", PRIVATE_ROOT);
const INSTALL_SKIP_PATH = new URL("skip-install-run", PRIVATE_ROOT);
const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EINVOICE_SEARCH_URL =
  "https://www.einvoice.nat.gov.tw/portal/btc/mobile/btc502w/search";
const LEDGER_URL = "https://yungkuo135.github.io/expense-ledger/";
const DEBUGGING_PORT = 9322;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 3;
const IS_SCHEDULED_RUN = Deno.args.includes("--scheduled");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function loadScheduleState() {
  try {
    const state = JSON.parse(await Deno.readTextFile(SCHEDULE_STATE_PATH));
    return state && typeof state === "object" ? state : {};
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(`無法讀取排程狀態：${error.message}`);
  }
}

async function markRunSuccessful(now = new Date()) {
  await Deno.writeTextFile(
    SCHEDULE_STATE_PATH,
    JSON.stringify(
      {
        lastSuccessDate: dateKey(now),
        lastSuccessAt: now.toISOString(),
      },
      null,
      2,
    ),
  );
}

async function shouldSkipScheduledRun(now = new Date()) {
  if (!IS_SCHEDULED_RUN) return false;
  try {
    await Deno.remove(INSTALL_SKIP_PATH);
    log("略過安裝 LaunchAgent 時產生的 RunAtLoad 觸發");
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const state = await loadScheduleState();
  return state.lastSuccessDate === dateKey(now);
}

async function invoiceRangesForRun(now = new Date()) {
  if (!IS_SCHEDULED_RUN) return rollingInvoiceRanges(now, LOOKBACK_DAYS);
  const state = await loadScheduleState();
  return catchUpInvoiceRanges(state.lastSuccessDate, now, LOOKBACK_DAYS);
}

async function notify(title, message) {
  try {
    await new Deno.Command("/usr/bin/osascript", {
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        message,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (_) { /* 通知失敗不應中斷帳務流程 */ }
}

async function connectToChrome(targetUrl) {
  const endpoint = `http://127.0.0.1:${DEBUGGING_PORT}`;
  // 排程完成後保留的 Chrome 可直接重用，避免同一個 profile 再開新視窗。
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 2_000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    return { browser, chrome: null, page };
  } catch (_) { /* 沒有可重用的自動化 Chrome */ }

  const chromeArgs = [
    `--remote-debugging-port=${DEBUGGING_PORT}`,
    `--user-data-dir=${PROFILE_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    targetUrl,
  ];
  // LaunchAgent 結束時會清理其子程序；透過 Launch Services 啟動，Chrome
  // 才能在排程程序結束後繼續保留。
  let chrome = null;
  if (IS_SCHEDULED_RUN) {
    const result = await new Deno.Command("/usr/bin/open", {
      args: ["-na", "Google Chrome", "--args", ...chromeArgs],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `無法啟動自動化 Chrome：${new TextDecoder().decode(result.stderr)}`,
      );
    }
  } else {
    chrome = new Deno.Command(CHROME_PATH, {
      args: chromeArgs,
      stdout: "null",
      stderr: "null",
    }).spawn();
    chrome.unref();
  }
  let browser = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      browser = await chromium.connectOverCDP(
        endpoint,
      );
      break;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    if (chrome) {
      try {
        chrome.kill("SIGTERM");
      } catch (_) { /* Chrome 已結束 */ }
    }
    throw new Error("無法連線到自動化 Chrome；請關閉先前中斷留下的自動化視窗");
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  return { browser, chrome, page };
}

async function navigate(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    if (page.url() === "about:blank") throw error;
  }
}

async function openEinvoiceSearch(page) {
  await navigate(page, EINVOICE_SEARCH_URL);
  try {
    await page.locator("#dp-input-searchInvoiceDate").waitFor({
      timeout: 10_000,
    });
    return;
  } catch (_) { /* 平台登入後有時忽略原始 redirect */ }
  const link = page.getByRole("link", {
    name: "發票查詢及捐贈",
    exact: true,
  }).first();
  if (await link.count()) {
    await link.click();
    await page.locator("#dp-input-searchInvoiceDate").waitFor({
      timeout: 30_000,
    });
    return;
  }
  throw new Error("登入後無法開啟發票查詢頁，官方網站流程可能已變更");
}

async function waitForEinvoiceLogin(page) {
  await navigate(page, EINVOICE_SEARCH_URL);
  try {
    await page.locator("#dp-input-searchInvoiceDate").waitFor({
      timeout: 5_000,
    });
    return;
  } catch (_) { /* 受保護網址尚在轉址或 session 已失效 */ }
  log("等待手動登入財政部電子發票平台…");
  await notify("Expense Ledger 發票同步", "請在 Chrome 完成財政部手機條碼登入");
  await page.waitForURL(
    (url) => url.pathname.startsWith("/portal/btc/mobile/"),
    { timeout: LOGIN_TIMEOUT_MS },
  );
  await page.waitForTimeout(2_000);
  await openEinvoiceSearch(page);
}

function parseDisplayedMonth(text) {
  const match = String(text).match(/(\d{1,2})月/);
  if (!match) throw new Error(`無法辨識日期選擇器月份：${text}`);
  return Number(match[1]);
}

function parseDisplayedYear(text) {
  const match = String(text).match(/(\d{4})年/);
  if (!match) throw new Error(`無法辨識日期選擇器年份：${text}`);
  return Number(match[1]);
}

async function selectDateRange(page, range) {
  await page.locator("#dp-input-searchInvoiceDate").click();
  const picker = page.locator(".dp__menu");
  await picker.waitFor({ timeout: 10_000 });
  for (let attempt = 0; attempt < 24; attempt++) {
    const monthText = await picker.getByRole("button", {
      name: "月份設定",
    }).textContent();
    const yearText = await picker.getByRole("button", {
      name: "年份設定",
    }).textContent();
    const delta = (range.year - parseDisplayedYear(yearText)) * 12 +
      range.month - parseDisplayedMonth(monthText);
    if (delta === 0) break;
    await picker.getByRole("button", {
      name: delta < 0 ? "上個月" : "下個月",
    }).click();
    if (attempt === 23) throw new Error("日期選擇器無法移到目標月份");
  }
  const currentMonthDay = (day) =>
    picker.locator(
      ".dp__calendar_item .dp__cell_inner:not(.dp__cell_offset)",
    ).filter({ hasText: new RegExp(`^${day}$`) });
  await currentMonthDay(Number(range.start.slice(-2))).click();
  await currentMonthDay(Number(range.end.slice(-2))).click();
}

async function downloadRange(page, range) {
  await openEinvoiceSearch(page);
  await selectDateRange(page, range);
  log(`查詢 ${range.start} 至 ${range.end}`);
  await page.getByRole("button", { name: "查詢", exact: true }).click();
  try {
    await page.waitForURL("**/btc502w/detail", { timeout: 30_000 });
  } catch (_) {
    log(`${range.start} 至 ${range.end} 沒有可下載資料`);
    return null;
  }
  const downloadButton = page.getByRole("button", {
    name: "下載CSV檔",
    exact: true,
  });
  try {
    await downloadButton.waitFor({ state: "visible", timeout: 30_000 });
  } catch (_) {
    log(`${range.start} 至 ${range.end} 查無發票`);
    return null;
  }

  const pageSize = page.locator("#SelectSizes:visible").first();
  if (await pageSize.count()) {
    await pageSize.selectOption({ label: "100" });
    await pageSize.locator(
      "xpath=following::button[normalize-space()='執行'][1]",
    ).click();
    await page.waitForTimeout(2_000);
  }

  const pageSelector = page.locator("#SelectPages:visible").first();
  const pageValues = await pageSelector.count()
    ? await pageSelector.locator("option").evaluateAll((options) =>
      options.map((option) => option.value)
    )
    : [];
  const pages = pageValues.length ? pageValues : [null];
  for (const pageValue of pages) {
    if (pageValue !== null && await pageSelector.inputValue() !== pageValue) {
      await pageSelector.selectOption(pageValue);
      await pageSelector.locator(
        "xpath=following::button[normalize-space()='執行'][1]",
      ).click();
      await page.waitForTimeout(1_500);
    }
    await page.locator("#invoiceDetailAll").check({ force: true });
  }
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const path = `${DOWNLOADS_PATH}/載具消費明細_${range.start}_${range.end}.csv`;
  await download.saveAs(path);
  log(`已下載 ${range.start} 至 ${range.end}`);
  return path;
}

async function waitForLedgerLogin(page) {
  await navigate(page, LEDGER_URL);
  await page.locator("#cloudPanel").waitFor({ timeout: 30_000 });
  await page.locator("body.auth-checking").waitFor({
    state: "detached",
    timeout: 30_000,
  });
  if (await page.locator("body.auth-locked").count()) {
    log("等待手動登入 Expense Ledger…");
    await notify("Expense Ledger 發票同步", "請在 Chrome 登入 Expense Ledger");
    await page.waitForFunction(
      () => !document.body.classList.contains("auth-locked"),
      null,
      { timeout: LOGIN_TIMEOUT_MS },
    );
  }
  await page.locator("body.data-loading").waitFor({
    state: "detached",
    timeout: 60_000,
  });
}

async function importIntoLedger(page, paths) {
  if (!paths.length) return false;
  await waitForLedgerLogin(page);
  await page.locator("#invoiceFile").setInputFiles(paths);
  const preview = page.locator("#importPreviewBackdrop");
  await preview.waitFor({ state: "visible", timeout: 30_000 });
  const content = page.locator("#importPreviewContent");
  await content.waitFor({ state: "visible", timeout: 30_000 });
  if ((await content.innerText()).includes("無法辨識")) {
    throw new Error("Expense Ledger 無法辨識下載的 CSV，已停止自動匯入");
  }
  await page.locator("#confirmImportBtn").click();
  await preview.waitFor({ state: "hidden", timeout: 60_000 });
  log(`已將 ${paths.length} 個 CSV 送入 Expense Ledger`);
  return true;
}

async function main() {
  await Deno.mkdir(DOWNLOADS_PATH, { recursive: true });
  if (await shouldSkipScheduledRun()) {
    log("今天已成功同步，略過重複的排程觸發");
    return;
  }
  const ranges = await invoiceRangesForRun();
  const session = await connectToChrome(EINVOICE_SEARCH_URL);
  let failed = false;
  try {
    await waitForEinvoiceLogin(session.page);
    const downloaded = [];
    for (const range of ranges) {
      const path = await downloadRange(session.page, range);
      if (path) downloaded.push(path);
    }
    const imported = await importIntoLedger(session.page, downloaded);
    const message = imported
      ? `完成：下載並匯入 ${downloaded.length} 個月份區段`
      : "完成：查詢區間沒有可匯入的發票";
    await markRunSuccessful();
    log(message);
    await notify("Expense Ledger 發票同步", message);
  } catch (error) {
    failed = true;
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    await notify("Expense Ledger 發票同步失敗", message);
    throw error;
  } finally {
    if (IS_SCHEDULED_RUN) {
      // browser.close() 會連同 CDP 連線的 Chrome 一起關閉。排程模式直接結束
      // Deno 以釋放連線，讓由 Launch Services 啟動的 Chrome 保持開啟。
      Deno.exit(failed ? 1 : 0);
    } else {
      await session.browser.close();
    }
    if (session.chrome) {
      try {
        session.chrome.kill("SIGTERM");
      } catch (_) { /* Chrome 已由使用者關閉 */ }
    }
  }
}

if (import.meta.main) await main();
