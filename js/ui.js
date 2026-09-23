/* ---------- navigation, workbox, filters & import preview ---------- */

let activeView = "home";
function renderDashboard() {
  const root = document.getElementById("dashboard");
  if (!root) return;
  const now = new Date();
  const month = creditCardPlanMonthKey(now);
  const previous = creditCardPlanMonthKey(
    new Date(now.getFullYear(), now.getMonth() - 1, 1),
  );
  const counted = entries.filter(isCounted);
  const total = (key) =>
    counted.filter((e) => monthKeyOf(e.date) === key).reduce(
      (sum, e) => sum + e.amount,
      0,
    );
  const currentTotal = total(month), previousTotal = total(previous);
  const states = creditCardImportPlan.months[month] || {};
  const done =
    creditCardImportPlan.cards.filter((card) => states[card.id]).length;
  const recent = counted.slice().sort((a, b) =>
    b.date.localeCompare(a.date) || b.ts - a.ts
  ).slice(0, 6);
  root.innerHTML = `
    <div class="dashboard-metrics">
      <article class="dashboard-balance"><span>${
    escapeHtml(month)
  } · 本月支出</span><strong>${fmt(currentTotal)}</strong><p>上月全月 ${
    fmt(previousTotal)
  } · 差額 ${currentTotal - previousTotal >= 0 ? "+" : ""}${
    fmt(currentTotal - previousTotal)
  }</p></article>
      <button class="dashboard-stat" data-go="inbox"><span>待處理</span><strong>${workboxCount()}<small> 筆</small></strong></button>
      <button class="dashboard-stat" data-go="imports"><span>本月帳單進度</span><strong>${done}<small> / ${creditCardImportPlan.cards.length}</small></strong><span>每月 ${creditCardImportPlan.reminderDay} 日提醒 →</span></button>
    </div>
    <div class="dashboard-columns">
      <section class="dashboard-panel"><div class="dashboard-panel-head"><h2>最近支出</h2><button data-go="home">全部交易 ↗</button></div>
      ${
    recent.length
      ? recent.map((e) =>
        `<div class="dashboard-transaction"><div><strong>${
          escapeHtml(e.vendor || e.note || e.category)
        }</strong><span>${escapeHtml(e.date)} · ${
          escapeHtml(e.category)
        }</span></div><b>${fmt(e.amount)}</b></div>`
      ).join("")
      : '<p class="workspace-description">尚無紀錄</p>'
  }</section>
      <section class="dashboard-panel"><div class="dashboard-panel-head"><h2>本月帳單</h2><button data-go="imports">管理 ↗</button></div>${
    creditCardImportPlan.cards.map((card) =>
      `<div class="dashboard-bank"><span>${
        escapeHtml(card.name)
      }</span><span class="dashboard-bank-status">${
        states[card.id]?.status === "imported"
          ? "已匯入"
          : states[card.id]?.status === "skipped"
          ? "本月略過"
          : "待匯入"
      }</span></div>`
    ).join("")
  }</section>
    </div>`;
  root.querySelectorAll("[data-go]").forEach((button) => {
    button.onclick = () => setActiveView(button.dataset.go);
  });
}
let importPreviewState = null;
let invoiceImportResult = null;

function showInvoiceImportResult(result) {
  clearLedgerFilter("all");
  invoiceImportResult = {
    ...result,
    unclassifiedCount: result.unclassifiedCount ??
      unclassifiedNamesForIds(result.addedIds || []).length,
  };
  selectedTransactionId = null;
  setActiveView("home");
  render();
}

function openImportedUnclassified() {
  qualityFilter = "unclassified";
  setActiveView("inbox");
  render();
  setRulesExpanded(true);
  setTimeout(() =>
    document.getElementById("aiWorkflow").scrollIntoView({
      behavior: "smooth",
      block: "start",
    }), 0);
}
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
  const allowed = new Set(["home", "imports", "inbox", "stats"]);
  activeView = allowed.has(view) ? view : "home";
  document.getElementById("appTitle").textContent = activeView === "home"
    ? "交易"
    : "記帳本";
  document.getElementById("filterToolsSummary").hidden = activeView !== "home";
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

function openCashEntry() {
  document.getElementById("cashDrawer").hidden = false;
  document.body.classList.add("cash-drawer-open");
  const panel = document.getElementById("cashEntryPanel");
  panel.hidden = false;
  setTimeout(() => amountInput.focus(), 0);
}

function closeCashEntry() {
  document.getElementById("cashEntryPanel").hidden = true;
  document.getElementById("cashDrawer").hidden = true;
  document.body.classList.remove("cash-drawer-open");
  document.getElementById("addActionBtn").focus();
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
  const resultIds = invoiceImportResult
    ? new Set(
      invoiceImportResult.batch?.undone ? [] : invoiceImportResult.addedIds,
    )
    : null;
  // Matched credit-card rows stay represented by their invoice group, exactly
  // as before, so filtering never creates a second copy of the same purchase.
  return entries.filter((entry) =>
    !(entry.source === "creditcard" && entry.matchedId)
  ).filter((entry) => {
    if (resultIds && !resultIds.has(entry.id)) return false;
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
  return !!invoiceImportResult || !!searchQuery ||
    ledgerFilters.source !== "all" ||
    ledgerFilters.category !== "all" || !!ledgerFilters.month ||
    ledgerFilters.review !== "all";
}

function renderFilterSummary() {
  const wrap = document.getElementById("filterSummary");
  const toolSummary = document.getElementById("filterToolsSummary");
  const labels = [];
  if (invoiceImportResult) labels.push(["importResult", "本次新增發票"]);
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
    toolSummary.setAttribute("aria-label", "搜尋與篩選");
    toolSummary.title = "搜尋與篩選";
    toolSummary.classList.remove("has-filters");
    wrap.innerHTML = "";
    wrap.hidden = true;
    return;
  }
  toolSummary.setAttribute("aria-label", `搜尋與篩選・${labels.length} 個條件`);
  toolSummary.title = `搜尋與篩選・${labels.length} 個條件`;
  toolSummary.classList.add("has-filters");
  wrap.hidden = false;
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
  if (key === "all" || key === "importResult") invoiceImportResult = null;
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

function renderWorkbox() {
  const pendingCount = workboxCount();
  document.getElementById("workboxTotal").textContent = pendingCount
    ? `${pendingCount} 項`
    : "已完成";
  const badge = document.getElementById("navPendingBadge");
  badge.hidden = pendingCount === 0;
  badge.textContent = pendingCount > 99 ? "99+" : String(pendingCount);
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
  const statementMonth = summary.type === "creditcard"
    ? (summary.statementMonth || creditCardPlanMonthKey())
    : "";
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
  }${
    summary.type === "creditcard"
      ? `<div><dt>帳單月份</dt><dd><input type="month" id="statementMonthInput" value="${
        escapeHtml(statementMonth)
      }" aria-label="帳單月份"></dd></div>`
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
  const monthInput = document.getElementById("statementMonthInput");
  if (monthInput) {
    monthInput.addEventListener("change", () => {
      if (importPreviewState) {
        importPreviewState.statementMonth = monthInput.value;
      }
    });
  }
}

function inferStatementMonth(files, fallback = creditCardPlanMonthKey()) {
  const months = new Set();
  files.forEach((file) => {
    const match = String(file.name || "").match(
      /(?:^|\D)(20\d{2})[-_]?((?:0[1-9])|(?:1[0-2]))(?:\D|$)/,
    );
    if (match) months.add(`${match[1]}-${match[2]}`);
  });
  return months.size === 1 ? [...months][0] : fallback;
}

async function openImportPreview(type, files) {
  const selected = Array.from(files || []);
  if (!selected.length) return;
  if (!dataLoaded) {
    showToast("資料載入中，請稍等一下再試");
    return;
  }
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
    const statementMonth = type === "creditcard"
      ? inferStatementMonth(
        selected,
        document.getElementById("cardImportMonth").value ||
          creditCardPlanMonthKey(),
      )
      : "";
    summary.statementMonth = statementMonth;
    importPreviewState = {
      type,
      files: selected,
      bankLabel,
      statementMonth,
      summary,
    };
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
    let invoiceResult = null;
    if (state.type === "invoice") {
      invoiceResult = await importInvoiceCSV(state.files);
    } else {
      await importCreditCardCSV(
        state.files,
        state.bankLabel,
        state.statementMonth,
      );
    }
    document.getElementById("importPreviewBackdrop").hidden = true;
    importPreviewState = null;
    if (invoiceResult) {
      showInvoiceImportResult(invoiceResult);
      return;
    }
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
  document.getElementById("view-overview").hidden = true;
  document.getElementById("view-stats").appendChild(
    document.getElementById("dashboard"),
  );
  document.querySelector('[data-nav-view="overview"]').remove();
  const filters = document.getElementById("filterTools");
  filters.hidden = true;
  const searchToggle = document.getElementById("filterToolsSummary");
  searchToggle.addEventListener("click", () => {
    filters.hidden = !filters.hidden;
    searchToggle.setAttribute("aria-expanded", String(!filters.hidden));
    if (!filters.hidden) searchInput.focus({ preventScroll: true });
  });
  filters.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    filters.hidden = true;
    searchToggle.setAttribute("aria-expanded", "false");
    searchToggle.focus({ preventScroll: true });
  });
  const tools = document.getElementById("dataTools");
  document.getElementById("importWorkspace").appendChild(tools);
  tools.open = true;
  const drawer = document.getElementById("cashDrawer");
  const cashPanel = document.getElementById("cashEntryPanel");
  drawer.appendChild(cashPanel);
  cashPanel.setAttribute("role", "dialog");
  cashPanel.setAttribute("aria-modal", "true");
  cashPanel.setAttribute("aria-label", "新增現金支出");
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer) closeCashEntry();
  });
  document.addEventListener("keydown", (event) => {
    if (drawer.hidden) return;
    if (event.key === "Escape") closeCashEntry();
    if (event.key === "Tab") {
      const controls = [...cashPanel.querySelectorAll("button, input")].filter((
        el,
      ) => !el.disabled);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
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
  document.getElementById("cardImportMonth").addEventListener(
    "change",
    renderCreditCardImportChecklist,
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
