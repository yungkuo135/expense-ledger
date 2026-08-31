let selectedCategory = CATEGORIES[0];
let entries = [];
// guards every entry point that mutates `entries` against a real race: the
// buttons that call addEntry/importInvoiceCSV/importCreditCardCSV/
// importBackup/clearAll are all clickable immediately on page load, but
// loadEntries() reads from the storage adapter asynchronously and, once it
// resolves, does `entries = res ? JSON.parse(res.value) : []` — if the
// person managed to add/import something in that window before it
// resolved, that assignment silently wipes it out from under them. The
// ledger's own dynamic buttons (delete, confirm, merge...) are naturally
// safe since they don't exist until the first render() at the end of
// init(), which only happens after loading completes.
let dataLoaded = false;
// vendor pairs the user has manually confirmed as "same real-world store"
// via the merge button — e.g. cc shows "億客來生鮮超市" but the invoice is
// issued under "育旌股份有限公司". Learned once, remembered for every
// future reconcile() pass so the same store doesn't keep asking.
let vendorAliases = [];
let vendorAliasGraphCache = null;
let importBatches = [];
let qualityFilter = null;
const chipRow = document.getElementById("chipRow");
const amountInput = document.getElementById("amountInput");
const noteInput = document.getElementById("noteInput");
const dateInput = document.getElementById("dateInput");
const saveBtn = document.getElementById("saveBtn");
dateInput.value = toKey(new Date());
const ledgerEl = document.getElementById("ledger");
const toast = document.getElementById("toast");
const searchInput = document.getElementById("searchInput");
const statsMonthLabelEl = document.getElementById("statsMonthLabel");
const statsTotalAmtEl = document.getElementById("statsTotalAmt");
const statsDeltaEl = document.getElementById("statsDelta");
const statsCategoryBarsEl = document.getElementById("statsCategoryBars");
const statsVendorsEl = document.getElementById("statsVendors");
const statsPrevBtn = document.getElementById("statsPrevBtn");
const statsNextBtn = document.getElementById("statsNextBtn");

function renderChips() {
  chipRow.innerHTML = "";
  CATEGORIES.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "chip" + (cat === selectedCategory ? " active" : "");
    btn.textContent = cat;
    btn.onclick = () => {
      selectedCategory = cat;
      renderChips();
    };
    chipRow.appendChild(btn);
  });
}

const rulesToggleEl = document.getElementById("rulesToggle");
const rulesCardEl = document.getElementById("rulesCard");
let rulesExpanded = false;
function setRulesExpanded(expanded) {
  rulesExpanded = !!expanded;
  rulesCardEl.style.display = rulesExpanded ? "block" : "none";
  rulesToggleEl.textContent = rulesExpanded ? "收合分類工具 ▾" : "開始分類 ▸";
  rulesToggleEl.setAttribute("aria-expanded", String(rulesExpanded));
}
rulesToggleEl.addEventListener("click", () => setRulesExpanded(!rulesExpanded));

document.getElementById("getUnclassifiedBtn").addEventListener("click", () => {
  const names = getUnclassifiedNames();
  const outputEl = document.getElementById("unclassifiedOutput");
  if (names.length === 0) {
    outputEl.value = "";
    showToast("目前沒有還沒分類的品項(都分類過,或都手動確認過了)");
    return;
  }
  outputEl.value = buildAiClassifyPrompt(names);
  showToast(`已產生 ${names.length} 個待分類品項,複製貼給AI吧`);
});

document.getElementById("copyUnclassifiedBtn").addEventListener(
  "click",
  async () => {
    const outputEl = document.getElementById("unclassifiedOutput");
    if (!outputEl.value) {
      showToast("請先按「取得待分類清單」");
      return;
    }
    // clipboard API needs a secure context + permission that isn't always
    // granted inside the artifact sandbox — if it's blocked, fall back to
    // selecting the text so the person can still copy it manually (Ctrl/Cmd+C)
    // instead of the button silently doing nothing.
    try {
      await navigator.clipboard.writeText(outputEl.value);
      showToast("已複製到剪貼簿");
    } catch (err) {
      outputEl.focus();
      outputEl.select();
      showToast("自動複製被瀏覽器擋下了,已幫你選取文字,手動按 Ctrl/Cmd+C 複製");
    }
  },
);

document.getElementById("applyAiResultBtn").addEventListener("click", () => {
  const text = document.getElementById("aiResultInput").value;
  applyAiClassifyResult(text);
});

let toastTimeout = null;

function showToast(msg) {
  toast.classList.remove("toast-interactive");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  // Import summaries can be several lines long, while a short "已確認"
  // should disappear quickly. Give longer messages enough reading time
  // without making every small confirmation linger.
  const duration = Math.min(
    6000,
    Math.max(2400, 1600 + String(msg).length * 35),
  );
  toastTimeout = setTimeout(() => toast.classList.remove("show"), duration);
}

// same pill, but carries a real "復原" button — used right after a
// destructive action (currently: single-entry delete) instead of a heavier
// confirm-before-acting flow. The action already happened (so re-rendering
// feels instant), and the button reverses it within the window.
function showUndoToast(msg, undoFn) {
  toast.innerHTML = `<span>${
    escapeHtml(msg)
  }</span> <button class="toast-undo-btn" type="button">復原</button>`;
  toast.classList.add("show", "toast-interactive");
  clearTimeout(toastTimeout);
  let used = false;
  const btn = toast.querySelector(".toast-undo-btn");
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (used) return;
    used = true;
    clearTimeout(toastTimeout);
    toast.classList.remove("show", "toast-interactive");
    undoFn();
  };
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show", "toast-interactive");
  }, 5000);
}

function fmt(n) {
  const neg = n < 0;
  return (neg ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US");
}

function toKey(d) {
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateLabel(key) {
  const d = new Date(key + "T00:00:00");
  const today = new Date();
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (key === toKey(today)) {
    return "今天 · " + (d.getMonth() + 1) + "/" + d.getDate();
  }
  if (key === toKey(y)) {
    return "昨天 · " + (d.getMonth() + 1) + "/" + d.getDate();
  }
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 週" + weekday;
}

// Some vendors' invoices only capture a sub-portion of a larger credit-card
// charge — e.g. 富胖達(foodpanda)'s invoice is just the platform fee, while
// the full order total (food + platform fee) is charged to the card under
// the restaurant's own name. If that fee invoice hasn't been reconciled to
// a specific card charge (the exact-discount-match case), counting it
// separately would double-count the portion already inside the card charge.
// Confirmed with the user: all 富胖達 invoices were paid by credit card.
const PLATFORM_FEE_ONLY_VENDORS = ["富胖達股份有限公司"];

function isPlatformFeeOnlyInvoice(e) {
  return e.source === "invoice" && !e.matchedId &&
    PLATFORM_FEE_ONLY_VENDORS.some((v) => (e.vendor || "").includes(v));
}

// counted = spending that should be included in totals (avoid double-counting merged cc+invoice pairs)
function isCounted(e) {
  if (e.source === "creditcard" && e.matchedId) return false;
  if (isPlatformFeeOnlyInvoice(e)) return false;
  return true;
}

// Imported source totals remain authoritative for reconciliation even when
// `amount` is later reduced to the user's personal share. Older records that
// predate originalAmount retain their existing behavior.
function reconciliationAmount(e) {
  return Number.isFinite(e.originalAmount) ? e.originalAmount : e.amount;
}

// every month key currently believed to exist in storage — populated from
// storageAdapter.list() on load, kept in sync by saveEntries() as it writes
// or deletes month keys. A full save (clearAll, bulk import, etc.) needs
// this alongside whatever's in `entries`, because a month that emptied out
// (e.g. its last entry got deleted) won't show up by scanning `entries`
// alone, but its now-stale key still needs to be deleted from storage.
let knownMonthKeys = new Set();

async function loadEntries() {
  const loaded = await ledgerRepository.loadEntries();
  entries = loaded.entries;
  knownMonthKeys = loaded.knownMonthKeys;
  if (loaded.migrationCleanupFailed) {
    showToast("舊版資料已安全遷移，但舊儲存項目暫時無法清除");
  }
}

// writes only the months in `affectedMonths` (an array/Set of 'YYYY-MM'
// strings) when given — the normal case for a single interactive edit,
// which only ever touches entries within one or two months. Falls back to
// a full save (every month currently present in `entries`, plus any
// previously-known month that's now empty and needs its stale key removed)
// when called with no argument — used by bulk operations (import, backup
// restore, clear, AI-classify apply) where working out the precise
// affected set isn't worth the bookkeeping.
async function saveEntries(affectedMonths) {
  try {
    const saved = await ledgerRepository.saveEntries(
      entries,
      knownMonthKeys,
      affectedMonths,
    );
    knownMonthKeys = saved.knownMonthKeys;
  } catch (error) {
    console.error("記帳資料儲存失敗", error);
    showToast("儲存失敗，這次變更尚未安全保存，請勿重新整理並再試一次");
    throw error;
  }
}

async function loadVendorAliases() {
  vendorAliases = await ledgerRepository.loadVendorAliases();
  vendorAliasGraphCache = null;
}

async function saveVendorAliases() {
  try {
    await ledgerRepository.saveVendorAliases(vendorAliases);
  } catch (error) {
    console.error("店家對應儲存失敗", error);
    showToast("店家對應儲存失敗，之後可能會再次詢問這組配對");
    throw error;
  }
}

function aliasKey(ccVendor, invVendor) {
  return normalizeVendorName(ccVendor) + "␟" + normalizeVendorName(invVendor);
}

function hasVendorAlias(ccVendor, invVendor) {
  return vendorAliases.includes(aliasKey(ccVendor, invVendor));
}

// learned from a manual "合併" confirmation — remembers that a specific
// credit-card store name and a specific invoice company name are the same
// real-world purchase, so future exact amount+date matches between this
// pair can auto-merge without asking again.
function learnVendorAlias(ccVendor, invVendor) {
  const key = aliasKey(ccVendor, invVendor);
  if (!vendorAliases.includes(key)) {
    vendorAliases.push(key);
    vendorAliasGraphCache = null;
  }
}

function forgetVendorAlias(ccVendor, invVendor) {
  const key = aliasKey(ccVendor, invVendor);
  const before = vendorAliases.length;
  vendorAliases = vendorAliases.filter((pair) => pair !== key);
  if (vendorAliases.length !== before) vendorAliasGraphCache = null;
  return vendorAliases.length !== before;
}

function unmatchReconciliation(ccId, invoiceNo) {
  const cc = entries.find((e) =>
    e.source === "creditcard" && e.id === ccId && e.matchedId === invoiceNo
  );
  if (!cc) return null;
  const items = entries.filter((e) =>
    e.source === "invoice" && e.invoiceNo === invoiceNo && e.matchedId === cc.id
  );
  if (items.length === 0) return null;
  items.forEach((item) => {
    item.matchedId = null;
  });
  cc.matchedId = null;
  cc.suggestedInvoiceNo = null;
  cc.reviewed = true;
  if (!Array.isArray(cc.rejectedInvoiceNos)) cc.rejectedInvoiceNos = [];
  if (!cc.rejectedInvoiceNos.includes(invoiceNo)) {
    cc.rejectedInvoiceNos.push(invoiceNo);
  }
  const aliasRemoved = forgetVendorAlias(cc.vendor || cc.note, items[0].vendor);
  return {
    cc,
    items,
    aliasRemoved,
    affectedMonths: new Set([
      monthKeyOf(cc.date),
      ...items.map((item) => monthKeyOf(item.date)),
    ]),
  };
}

// combined vendor-match check used by reconcile(): either the names
// textually overlap, or the user has previously confirmed this exact pair
// is the same store under a different registered company name.
function namesMatch(ccVendor, invVendor) {
  return hasNameOverlap(ccVendor, invVendor) ||
    hasVendorAlias(ccVendor, invVendor);
}
