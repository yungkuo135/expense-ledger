/* ---------- navigation, workbox, filters & import preview ---------- */

let activeView = "home";
let importPreviewState = null;
const ledgerFilters = {
  source: "all",
  category: "all",
  month: "",
  review: "all",
};

const WORKBOX_DEFS = [
  ["pending", "信用卡待確認", "需要確認是否為本人消費或處理建議配對"],
  ["unclassified", "尚未分類", "尚未經過人工或 AI 分類確認"],
  ["missingBank", "銀行名稱缺失", "信用卡資料缺少銀行或卡片名稱"],
  ["editedNoNote", "修改後無備註", "金額或內容已修改，但沒有留下原因"],
  ["dangling", "配對關聯異常", "配對的另一端已不存在，請重新檢查"],
];

function actionableWorkboxEntries() {
  const buckets = qualityBuckets();
  const byId = new Map();
  WORKBOX_DEFS.forEach(([key]) => {
    (buckets[key] || []).forEach((entry) => {
      if (!byId.has(entry.id)) byId.set(entry.id, { entry, reasons: [] });
      byId.get(entry.id).reasons.push(key);
    });
  });
  return [...byId.values()].sort((a, b) => b.entry.ts - a.entry.ts);
}

function workboxCount() {
  return actionableWorkboxEntries().length;
}

function setActiveView(view) {
  const allowed = new Set(["home", "inbox", "ledger", "stats"]);
  activeView = allowed.has(view) ? view : "home";
  document.querySelectorAll(".app-view").forEach((section) => {
    const active = section.getAttribute("data-view") === activeView;
    section.hidden = !active;
    section.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-nav-view]").forEach((button) => {
    const active = button.getAttribute("data-nav-view") === activeView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openAddSheet() {
  const backdrop = document.getElementById("addSheetBackdrop");
  backdrop.hidden = false;
  document.getElementById("addActionBtn").setAttribute("aria-expanded", "true");
}

function closeAddSheet() {
  document.getElementById("addSheetBackdrop").hidden = true;
  document.getElementById("addActionBtn").setAttribute(
    "aria-expanded",
    "false",
  );
}

function openCashEntry() {
  closeAddSheet();
  setActiveView("home");
  const panel = document.getElementById("cashEntryPanel");
  panel.hidden = false;
  setTimeout(() => amountInput.focus(), 0);
}

function closeCashEntry() {
  document.getElementById("cashEntryPanel").hidden = true;
}

function reviewFilterMatches(entry, filter) {
  if (filter === "pending") {
    return entry.source === "creditcard" && !entry.matchedId && !entry.reviewed;
  }
  if (filter === "unclassified") {
    return !isCategoryReviewed(entry) && entry.category === "其他" &&
      classifyLookupText(entry).trim();
  }
  if (filter === "reviewedOther") {
    return entry.category === "其他" && isCategoryReviewed(entry);
  }
  if (filter === "matched") return !!entry.matchedId;
  return true;
}

function getFilteredLedgerEntries() {
  // Matched credit-card rows stay represented by their invoice group, exactly
  // as before, so filtering never creates a second copy of the same purchase.
  return entries.filter((entry) =>
    !(entry.source === "creditcard" && entry.matchedId)
  ).filter((entry) => {
    if (searchQuery) {
      const hay = [
        entry.note,
        entry.vendor,
        entry.category,
        entry.bank,
        entry.invoiceNo,
        entry.vendor ? canonicalVendorDisplay(entry.vendor) : "",
      ]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    if (
      ledgerFilters.source !== "all" && entry.source !== ledgerFilters.source
    ) return false;
    if (
      ledgerFilters.category !== "all" &&
      entry.category !== ledgerFilters.category
    ) return false;
    if (ledgerFilters.month && monthKeyOf(entry.date) !== ledgerFilters.month) {
      return false;
    }
    return reviewFilterMatches(entry, ledgerFilters.review);
  });
}

function hasActiveLedgerFilters() {
  return !!searchQuery || ledgerFilters.source !== "all" ||
    ledgerFilters.category !== "all" || !!ledgerFilters.month ||
    ledgerFilters.review !== "all";
}

function renderFilterSummary() {
  const wrap = document.getElementById("filterSummary");
  const labels = [];
  if (searchQuery) labels.push(["search", `搜尋：${searchInput.value.trim()}`]);
  if (ledgerFilters.source !== "all") {
    labels.push([
      "source",
      document.getElementById("sourceFilter").selectedOptions[0].textContent,
    ]);
  }
  if (ledgerFilters.category !== "all") {
    labels.push(["category", ledgerFilters.category]);
  }
  if (ledgerFilters.month) {
    labels.push(["month", ledgerFilters.month.replace("-", " / ")]);
  }
  if (ledgerFilters.review !== "all") {
    labels.push([
      "review",
      document.getElementById("reviewFilter").selectedOptions[0].textContent,
    ]);
  }
  if (!labels.length) {
    wrap.innerHTML = '<span class="filter-empty">目前顯示全部明細</span>';
    return;
  }
  wrap.innerHTML =
    labels.map(([key, label]) =>
      `<button type="button" data-clear-filter="${key}">${
        escapeHtml(label)
      } <span>✕</span></button>`
    ).join("") +
    '<button type="button" class="clear-all-filters" data-clear-filter="all">清除全部</button>';
  wrap.querySelectorAll("[data-clear-filter]").forEach((button) => {
    button.onclick = () =>
      clearLedgerFilter(button.getAttribute("data-clear-filter"));
  });
}

function clearLedgerFilter(key) {
  if (key === "all" || key === "search") {
    searchQuery = "";
    searchInput.value = "";
  }
  if (key === "all" || key === "source") {
    ledgerFilters.source = "all";
    document.getElementById("sourceFilter").value = "all";
  }
  if (key === "all" || key === "category") {
    ledgerFilters.category = "all";
    document.getElementById("categoryFilter").value = "all";
  }
  if (key === "all" || key === "month") {
    ledgerFilters.month = "";
    document.getElementById("monthFilter").value = "";
  }
  if (key === "all" || key === "review") {
    ledgerFilters.review = "all";
    document.getElementById("reviewFilter").value = "all";
  }
  render();
}

function renderHomeSummary() {
  const currentMonth = monthKeyOf(toKey(new Date()));
  const monthEntries = entries.filter((e) =>
    monthKeyOf(e.date) === currentMonth && isCounted(e)
  );
  document.getElementById("homeMonthTotal").textContent = fmt(
    monthEntries.reduce((sum, e) => sum + e.amount, 0),
  );
  document.getElementById("homeMonthCount").textContent =
    `${monthEntries.length} 筆`;
  const pending = workboxCount();
  document.getElementById("homePendingCount").textContent = `${pending} 項`;
  document.getElementById("homePendingBtn").classList.toggle(
    "has-items",
    pending > 0,
  );
  document.getElementById("workboxTotal").textContent = pending
    ? `${pending} 項`
    : "已完成";
  const badge = document.getElementById("navPendingBadge");
  badge.hidden = pending === 0;
  badge.textContent = pending > 99 ? "99+" : String(pending);
}

function renderWorkbox() {
  const root = document.getElementById("workboxLedger");
  const unclassifiedCount = qualityBuckets().unclassified.length;
  const aiWorkflow = document.getElementById("aiWorkflow");
  aiWorkflow.hidden = unclassifiedCount === 0;
  document.getElementById("aiUnclassifiedCount").textContent =
    `${unclassifiedCount} 筆`;
  if (unclassifiedCount === 0 && rulesExpanded) setRulesExpanded(false);
  const all = actionableWorkboxEntries();
  const selected = qualityFilter
    ? all.filter((item) => item.reasons.includes(qualityFilter))
    : all;
  const defMap = Object.fromEntries(
    WORKBOX_DEFS.map(([key, label]) => [key, label]),
  );
  const active = document.getElementById("workboxActiveFilter");
  active.innerHTML = qualityFilter
    ? `<span>目前：${
      escapeHtml(defMap[qualityFilter] || "待處理")
    }</span><button type="button">顯示全部</button>`
    : `<span>全部待處理 · ${selected.length} 筆</span>`;
  const clearButton = active.querySelector("button");
  if (clearButton) {
    clearButton.onclick = () => {
      qualityFilter = null;
      render();
    };
  }

  root.innerHTML = "";
  if (selected.length === 0) {
    root.innerHTML =
      '<div class="workbox-empty"><span>✓</span><strong>目前沒有待處理項目</strong><small>新的匯入疑問或資料品質問題會集中顯示在這裡。</small></div>';
    return;
  }
  const batchable = selected.filter(({ entry }) =>
    entry.source === "creditcard" && !entry.matchedId && !entry.reviewed &&
    !entry.suggestedInvoiceNo
  );
  if ((!qualityFilter || qualityFilter === "pending") && batchable.length > 1) {
    const batch = document.createElement("div");
    batch.className = "workbox-batch-row";
    batch.innerHTML =
      `<span>${batchable.length} 筆一般信用卡消費可直接確認</span><button type="button" class="batch-confirm-btn">全部確認</button>`;
    root.appendChild(batch);
  }
  selected.forEach(({ entry, reasons }) => {
    const card = document.createElement("div");
    card.className = "workbox-card";
    const reason = document.createElement("div");
    reason.className = "workbox-reasons";
    reason.innerHTML = reasons.map((key) =>
      `<span>${escapeHtml(defMap[key] || key)}</span>`
    ).join("");
    const date = document.createElement("span");
    date.className = "workbox-date";
    date.textContent = dateLabel(entry.date);
    reason.appendChild(date);
    card.appendChild(reason);
    card.appendChild(renderItemRow(entry));
    root.appendChild(card);
  });
  attachLedgerHandlers(root);
}

function renderAppChrome() {
  renderHomeSummary();
  renderFilterSummary();
  renderWorkbox();
}

function closeImportPreview() {
  document.getElementById("importPreviewBackdrop").hidden = true;
  importPreviewState = null;
}

function previewWarningList(summary) {
  const warnings = [];
  if (summary.totals.skipped) {
    warnings.push(`略過重複 ${summary.totals.skipped} 筆`);
  }
  if (summary.totals.voided) {
    warnings.push(`略過作廢 ${summary.totals.voided} 筆`);
  }
  if (summary.totals.unparseable) {
    warnings.push(`${summary.totals.unparseable} 筆日期無法解析`);
  }
  if (summary.unrecognizedFiles.length) {
    warnings.push(`無法辨識：${summary.unrecognizedFiles.join("、")}`);
  }
  if (summary.emptyFiles.length) {
    warnings.push(`空白檔案：${summary.emptyFiles.join("、")}`);
  }
  return warnings;
}

function renderImportPreview(summary) {
  const content = document.getElementById("importPreviewContent");
  const dateRange = summary.dateFrom
    ? (summary.dateFrom === summary.dateTo
      ? summary.dateFrom
      : `${summary.dateFrom} ～ ${summary.dateTo}`)
    : "沒有可匯入日期";
  const warnings = previewWarningList(summary);
  content.innerHTML = `
    <div class="preview-file-list"><strong>${
    summary.type === "invoice" ? "發票明細" : "信用卡帳單"
  } · ${summary.fileCount} 個檔案</strong><span>${
    escapeHtml(summary.files.join("、"))
  }</span></div>
    <div class="preview-metrics">
      <div><span>將新增</span><strong>${summary.totals.added} 筆</strong></div>
      <div><span>檔案金額</span><strong>${
    fmt(summary.amountTotal)
  }</strong></div>
      <div><span>自動配對</span><strong>${summary.matched} 筆</strong></div>
      <div><span>需人工處理</span><strong>${summary.needsReview} 筆</strong></div>
    </div>
    <dl class="preview-details"><div><dt>日期範圍</dt><dd>${
    escapeHtml(dateRange)
  }</dd></div>${
    summary.banks.length
      ? `<div><dt>銀行</dt><dd>${escapeHtml(summary.banks.join("、"))}${
        summary.anyGuessed ? "（由檔名判斷）" : ""
      }</dd></div>`
      : ""
  }<div><dt>自動確認</dt><dd>${summary.autoReviewed} 筆信用卡消費</dd></div><div><dt>歷史分類</dt><dd>${summary.historyClassified} 筆</dd></div></dl>
    ${
    warnings.length
      ? `<div class="preview-warnings"><strong>請注意</strong>${
        warnings.map((w) => `<span>${escapeHtml(w)}</span>`).join("")
      }</div>`
      : '<div class="preview-ok">✓ 檔案格式與日期皆可解析</div>'
  }
    <p class="preview-safety-note">目前只是預覽，按下「確認匯入」前不會寫入帳本。</p>`;
  content.hidden = false;
}

async function openImportPreview(type, files) {
  const selected = Array.from(files || []);
  if (!selected.length) return;
  if (!dataLoaded) {
    showToast("資料載入中，請稍等一下再試");
    return;
  }
  closeAddSheet();
  const backdrop = document.getElementById("importPreviewBackdrop");
  const loading = document.getElementById("importPreviewLoading");
  const content = document.getElementById("importPreviewContent");
  const confirm = document.getElementById("confirmImportBtn");
  loading.textContent = "正在解析檔案，尚未寫入資料…";
  backdrop.hidden = false;
  loading.hidden = false;
  content.hidden = true;
  confirm.disabled = true;
  const bankLabel = type === "creditcard"
    ? document.getElementById("ccBankInput").value.trim()
    : "";
  try {
    const summary = await prepareImportPreview(type, selected, bankLabel);
    importPreviewState = { type, files: selected, bankLabel, summary };
    loading.hidden = true;
    renderImportPreview(summary);
    confirm.disabled = false;
  } catch (error) {
    loading.textContent = "檔案解析失敗，尚未寫入任何資料。";
    console.error(error);
    showToast("無法產生匯入預覽");
  }
}

async function confirmImportPreview() {
  if (!importPreviewState) return;
  const state = importPreviewState;
  const button = document.getElementById("confirmImportBtn");
  button.disabled = true;
  button.textContent = "匯入中…";
  try {
    if (state.type === "invoice") await importInvoiceCSV(state.files);
    else await importCreditCardCSV(state.files, state.bankLabel);
    document.getElementById("importPreviewBackdrop").hidden = true;
    importPreviewState = null;
    const hasUnclassified = qualityBuckets().unclassified.length > 0;
    if (hasUnclassified) {
      qualityFilter = "unclassified";
      setActiveView("inbox");
      render();
      setRulesExpanded(true);
      setTimeout(
        () =>
          document.getElementById("aiWorkflow").scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        0,
      );
    } else {
      setActiveView(workboxCount() ? "inbox" : "home");
    }
  } catch (error) {
    console.error(error);
    showToast("匯入未完整完成，請先檢查帳本內容再決定是否重試");
  } finally {
    button.textContent = "確認匯入";
    button.disabled = false;
  }
}

function initializeUI() {
  const categoryFilter = document.getElementById("categoryFilter");
  CATEGORIES.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categoryFilter.appendChild(option);
  });
  document.querySelectorAll("[data-nav-view]").forEach((button) =>
    button.addEventListener(
      "click",
      () => setActiveView(button.getAttribute("data-nav-view")),
    )
  );
  document.getElementById("addActionBtn").addEventListener(
    "click",
    openAddSheet,
  );
  document.getElementById("closeAddSheetBtn").addEventListener(
    "click",
    closeAddSheet,
  );
  document.getElementById("addSheetBackdrop").addEventListener(
    "click",
    (event) => {
      if (event.target === event.currentTarget) closeAddSheet();
    },
  );
  document.getElementById("addCashChoice").addEventListener(
    "click",
    openCashEntry,
  );
  document.getElementById("closeCashEntryBtn").addEventListener(
    "click",
    closeCashEntry,
  );
  document.getElementById("addInvoiceChoice").addEventListener(
    "click",
    () => document.getElementById("invoiceFile").click(),
  );
  document.getElementById("addCcChoice").addEventListener(
    "click",
    () => document.getElementById("ccFile").click(),
  );
  document.getElementById("homePendingBtn").addEventListener(
    "click",
    () => setActiveView("inbox"),
  );

  document.getElementById("invoiceFile").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    openImportPreview("invoice", files);
  });
  document.getElementById("ccFile").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    openImportPreview("creditcard", files);
  });
  document.getElementById("cancelImportPreviewBtn").addEventListener(
    "click",
    closeImportPreview,
  );
  document.getElementById("cancelImportBtn").addEventListener(
    "click",
    closeImportPreview,
  );
  document.getElementById("confirmImportBtn").addEventListener(
    "click",
    confirmImportPreview,
  );

  const bindFilter = (id, key) =>
    document.getElementById(id).addEventListener("change", (event) => {
      ledgerFilters[key] = event.target.value;
      render();
    });
  bindFilter("sourceFilter", "source");
  bindFilter("categoryFilter", "category");
  bindFilter("monthFilter", "month");
  bindFilter("reviewFilter", "review");
  setActiveView("home");
}
