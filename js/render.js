function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function renderItemRow(e, opts) {
  opts = opts || {};
  const pending = e.source === "creditcard" && !e.matchedId && !e.reviewed;
  const srcIcon = opts.hideSrc
    ? ""
    : `<span class="src">${
      e.source === "cash" ? "💵" : (e.source === "invoice" ? "🧾" : "💳")
    }</span>`;
  const bankTag = e.source === "creditcard"
    ? `<span class="bank-tag${e.bank ? "" : " bank-tag-empty"}" data-id="${
      escapeAttribute(e.id)
    }">${e.bank ? escapeHtml(e.bank) : "+銀行"}</span>`
    : "";
  const noteText = e.note || e.vendor || "未備註";
  // "empty" (muted placeholder) styling should only apply when there's truly
  // nothing meaningful to show — not just when e.note itself is blank.
  // Credit card entries always have note:'' (the CSV has no note column,
  // only a store name in `vendor`), so checking e.note alone wrongly greyed
  // out real, meaningful store names as if they were unfilled placeholders.
  const isPlaceholder = !e.note && !e.vendor;
  const row = document.createElement("div");
  row.className = "line-item" + (pending ? " pending" : "");
  row.innerHTML = `
    ${srcIcon}
    ${bankTag}
    <span class="cat-tag" data-id="${escapeAttribute(e.id)}">${
    escapeHtml(e.category)
  }</span>
    <span class="note ${isPlaceholder ? "empty" : ""}" data-id="${
    escapeAttribute(e.id)
  }" title="${escapeAttribute(noteText)}">${escapeHtml(noteText)}</span>
    <span class="amount-stack">
      <span class="amt" data-id="${escapeAttribute(e.id)}">${
    fmt(e.amount)
  }</span>
      ${
    Number.isFinite(e.originalAmount) &&
      Math.abs(e.originalAmount - e.amount) >= 0.01
      ? `<span class="original-amount">原 ${fmt(e.originalAmount)}</span>`
      : ""
  }
    </span>
    ${
    e.edited
      ? `<span class="edited-badge" title="原始金額 ${
        fmt(e.originalAmount ?? e.amount)
      }；原始備註 ${
        escapeHtml(e.originalNote || e.originalVendor || "—")
      }；原始銀行 ${escapeHtml(e.originalBank || "—")}">✎</span>`
      : ""
  }
    ${
    pending
      ? `<button class="confirm-btn" data-id="${
        escapeAttribute(e.id)
      }">確認</button>`
      : ""
  }
    <button class="del" data-id="${escapeAttribute(e.id)}">✕</button>
  `;

  if (e.source === "creditcard" && !e.matchedId && e.suggestedInvoiceNo) {
    const g = invoiceGroupsForSuggestion(e.suggestedInvoiceNo);
    if (g) {
      const gap = g.reconciliationSum - e.amount;
      const wrap = document.createElement("div");
      wrap.appendChild(row);
      const strip = document.createElement("div");
      strip.className = "suggest-strip";
      // gap>0: card was charged less than the invoice total (e.g. wallet
      // points/coupon covered the difference). gap≈0: amount matches exactly
      // but the vendor name didn't overlap enough to auto-merge — could be a
      // legitimate case (invoice uses the store's registered company name,
      // not its storefront brand) or a pure coincidence, so it needs a look.
      const txt = gap > 0.5
        ? `💡 疑似是「${escapeHtml(g.vendor)}」那張發票(少 ${
          fmt(gap)
        },可能是點數折抵)`
        : `🤔 金額跟「${
          escapeHtml(g.vendor)
        }」那張發票剛好一樣,但店名對不太上,請確認是否為同一筆`;
      strip.innerHTML = `
        <span class="txt">${txt}</span>
        <button class="merge-btn" data-id="${escapeAttribute(e.id)}" data-no="${
        escapeAttribute(e.suggestedInvoiceNo)
      }">合併</button>
        <button class="reject-btn" data-id="${
        escapeAttribute(e.id)
      }">非此筆</button>
      `;
      wrap.appendChild(strip);
      return wrap;
    }
  }
  return row;
}

function invoiceGroupsForSuggestion(invoiceNo) {
  const items = entries.filter((e) =>
    e.source === "invoice" && e.invoiceNo === invoiceNo && !e.matchedId
  );
  if (items.length === 0) return null;
  return {
    reconciliationSum: items.reduce(
      (sum, item) => sum + reconciliationAmount(item),
      0,
    ),
    vendor: items[0].vendor || "",
    items,
  };
}

function buildDayBlocks(dayEntries) {
  const invoiceBuckets = {};
  const blocks = [];
  dayEntries.forEach((e) => {
    if (e.source === "invoice" && e.invoiceNo) {
      (invoiceBuckets[e.invoiceNo] = invoiceBuckets[e.invoiceNo] || []).push(e);
    } else {
      blocks.push({ type: "single", entry: e, ts: e.ts });
    }
  });
  Object.keys(invoiceBuckets).forEach((no) => {
    const items = invoiceBuckets[no];
    blocks.push({
      type: "invoice",
      invoiceNo: no,
      items,
      ts: Math.max(...items.map((i) => i.ts)),
    });
  });
  blocks.sort((a, b) => b.ts - a.ts);
  return blocks;
}

// which months are expanded in the ledger — lazily initialized on first
// render to {latest month only}, so a data set spanning several months
// doesn't dump a huge scrolling list; user can tap a month header to
// expand/collapse, and the choice persists across re-renders (edits, etc.)
let expandedMonths = null;
// Invoice details are collapsed by default to keep month views scannable.
// The choice survives edits and other re-renders for the current page session.
const expandedInvoices = new Set();
let openingInvoiceNo = null;
function monthKeyOf(dateKey) {
  return dateKey.slice(0, 7);
} // 'YYYY-MM'

function monthLabel(mKey) {
  const [y, m] = mKey.split("-");
  const curYear = String(new Date().getFullYear());
  return (y === curYear ? "" : y + "年") + parseInt(m, 10) + "月";
}

function shiftMonthKey(mk, delta) {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// which month the stats card is currently showing — lazily defaults to the
// most recent month with data (same instinct as the ledger's own default
// expanded month), and persists across re-renders so navigating to a
// different month doesn't get reset by every edit elsewhere on the page.
let statsMonthKey = null;

function ensureOriginalFields(e) {
  if (!Object.prototype.hasOwnProperty.call(e, "originalAmount")) {
    e.originalAmount = e.amount;
  }
  if (!Object.prototype.hasOwnProperty.call(e, "originalVendor")) {
    e.originalVendor = e.vendor || "";
  }
  if (!Object.prototype.hasOwnProperty.call(e, "originalNote")) {
    e.originalNote = e.note || "";
  }
  if (!Object.prototype.hasOwnProperty.call(e, "originalBank")) {
    e.originalBank = e.bank || "";
  }
  return e;
}

function getVendorAliasGraph() {
  if (vendorAliasGraphCache) return vendorAliasGraphCache;
  const graph = {};
  vendorAliases.forEach((pair) => {
    const parts = String(pair).split("␟");
    if (parts.length !== 2) return;
    const [a, b] = parts;
    (graph[a] = graph[a] || new Set()).add(b);
    (graph[b] = graph[b] || new Set()).add(a);
  });
  vendorAliasGraphCache = graph;
  return graph;
}
function canonicalVendorKey(name) {
  const start = normalizeVendorName(name);
  if (!start) return "";
  const graph = getVendorAliasGraph();
  const seen = new Set([start]), stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    (graph[cur] || []).forEach((n) => {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    });
  }
  return [...seen].sort((a, b) =>
    a.length - b.length || a.localeCompare(b, "zh-Hant")
  )[0] || start;
}

function canonicalVendorDisplay(name) {
  const key = canonicalVendorKey(name);
  if (!key) return "";
  const candidates = [];
  entries.forEach((e) => {
    const raw = (e.vendor || "").trim();
    if (raw && canonicalVendorKey(raw) === key) candidates.push(raw);
  });
  if (!candidates.length) return name || key;
  const counts = {};
  candidates.forEach((v) => counts[v] = (counts[v] || 0) + 1);
  return Object.entries(counts).sort((a, b) =>
    b[1] - a[1] || a[0].length - b[0].length
  )[0][0];
}

function classificationHistoryKey(e) {
  const raw = classifyLookupText(e).trim();
  if (!raw) return "";
  return e.source === "invoice"
    ? "item:" + normalizeVendorName(raw)
    : "vendor:" + canonicalVendorKey(raw);
}

function historicalCategorySuggestion(e, excludeId) {
  const key = classificationHistoryKey(e);
  if (!key) return null;
  const counts = {};
  let total = 0;
  entries.forEach((x) => {
    if (x.id === excludeId) return;
    if (classificationHistoryKey(x) !== key) return;
    if (!x.category || x.category === "其他") return;
    counts[x.category] = (counts[x.category] || 0) + 1;
    total++;
  });
  if (total < 2) return null;
  const [category, count] =
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const confidence = count / total;
  return confidence >= 0.8 ? { category, count, total, confidence } : null;
}

// `categoryManual` remains the stronger signal used by older backups and
// direct edits. `categoryReviewed` also records an explicit AI decision,
// including the otherwise ambiguous decision that an item truly belongs in
// the catch-all "其他" category. Missing fields in old backups remain safely
// equivalent to false.
function isCategoryReviewed(e) {
  return !!(e.categoryManual || e.categoryReviewed);
}

function applyHistoryClassificationToIds(ids) {
  let changed = 0;
  ids.forEach((id) => {
    const e = entries.find((x) => x.id === id);
    if (!e || isCategoryReviewed(e) || e.category !== "其他") return;
    const sug = historicalCategorySuggestion(e, e.id);
    if (!sug) return;
    e.category = sug.category;
    e.categoryLearned = true;
    e.categoryLearnedFrom = sug.total;
    changed++;
  });
  return changed;
}

async function loadImportBatches() {
  importBatches = await ledgerRepository.loadImportBatches();
}
async function saveImportBatches() {
  try {
    await ledgerRepository.saveImportBatches(importBatches);
  } catch (error) {
    console.error("匯入批次紀錄儲存失敗", error);
    showToast("匯入批次紀錄儲存失敗，這次操作尚未完整保存");
    throw error;
  }
}
function snapshotLinkState() {
  const out = {};
  entries.forEach((e) => {
    out[e.id] = {
      matchedId: e.matchedId ?? null,
      reviewed: !!e.reviewed,
      suggestedInvoiceNo: e.suggestedInvoiceNo ?? null,
    };
  });
  return out;
}
function createImportBatch(type, files, addedIds, linkSnapshot, summary) {
  const changedLinks = {};
  Object.entries(linkSnapshot || {}).forEach(([id, before]) => {
    const now = entries.find((e) => e.id === id);
    if (!now) return;
    const after = {
      matchedId: now.matchedId ?? null,
      reviewed: !!now.reviewed,
      suggestedInvoiceNo: now.suggestedInvoiceNo ?? null,
    };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changedLinks[id] = before;
    }
  });
  const batch = {
    id: "b" + Date.now() + Math.random().toString(36).slice(2, 7),
    type,
    createdAt: new Date().toISOString(),
    files: files.map((f) => f.name),
    addedIds: [...addedIds],
    linkSnapshot: changedLinks,
    summary,
    undone: false,
  };
  entries.forEach((e) => {
    if (batch.addedIds.includes(e.id)) e.importBatchId = batch.id;
  });
  importBatches.unshift(batch);
  importBatches = importBatches.slice(0, 20);
  return batch;
}
async function undoImportBatch(batchId) {
  const batch = importBatches.find((b) => b.id === batchId);
  if (!batch || batch.undone) return;
  const removeIds = new Set(batch.addedIds || []);
  const removed = entries.filter((e) => removeIds.has(e.id));
  if (!removed.length) {
    batch.undone = true;
    await saveImportBatches();
    renderImportHistory();
    return;
  }
  entries = entries.filter((e) => !removeIds.has(e.id));
  Object.entries(batch.linkSnapshot || {}).forEach(([id, state]) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    e.matchedId = state.matchedId;
    e.reviewed = state.reviewed;
    e.suggestedInvoiceNo = state.suggestedInvoiceNo;
  });
  // Defensive cleanup for any relation created after the snapshot that points to removed rows.
  entries.forEach((e) => {
    if (removeIds.has(e.matchedId)) e.matchedId = null;
    if (
      e.source === "creditcard" && e.matchedId &&
      !entries.some((x) =>
        x.source === "invoice" && x.invoiceNo === e.matchedId
      )
    ) e.matchedId = null;
  });
  batch.undone = true;
  await saveEntries();
  await saveImportBatches();
  render();
  renderImportHistory();
  showToast(`已復原這次匯入，移除 ${removed.length} 筆`);
}

function relationIntegrityIssues() {
  return entries.filter((e) => {
    if (!e.matchedId) return false;
    if (e.source === "creditcard") {
      return !entries.some((x) =>
        x.source === "invoice" && x.invoiceNo === e.matchedId
      );
    }
    if (e.source === "invoice") {
      return !entries.some((x) =>
        x.source === "creditcard" && x.id === e.matchedId
      );
    }
    return false;
  });
}
function qualityBuckets() {
  return {
    pending: entries.filter((e) =>
      e.source === "creditcard" && !e.matchedId && !e.reviewed
    ),
    unclassified: entries.filter((e) =>
      !isCategoryReviewed(e) && e.category === "其他" &&
      classifyLookupText(e).trim()
    ),
    missingBank: entries.filter((e) =>
      e.source === "creditcard" && !(e.bank || "").trim()
    ),
    editedNoNote: entries.filter((e) => e.edited && !(e.note || "").trim()),
    dangling: relationIntegrityIssues(),
    unmatchedInvoices: entries.filter((e) =>
      e.source === "invoice" && !e.matchedId && !isPlatformFeeOnlyInvoice(e)
    ),
  };
}
function renderQualityCard() {
  const buckets = qualityBuckets();
  const defs = WORKBOX_DEFS;
  const total = workboxCount();
  document.getElementById("qualityScore").textContent = total === 0
    ? "✓"
    : total;
  document.getElementById("qualitySummary").textContent = total === 0
    ? "目前沒有需要處理的項目"
    : `共有 ${total} 筆交易需要處理；同一筆的多個問題會合併顯示`;
  const wrap = document.getElementById("qualityRows");
  wrap.innerHTML = "";
  defs.forEach(([key, label, hint]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "quality-row" + (buckets[key].length ? "" : " zero") +
      (qualityFilter === key ? " active" : "");
    b.innerHTML =
      `<span><strong>${label}</strong><small>${hint}</small></span><span class="quality-count">${
        buckets[key].length
      }</span>`;
    if (buckets[key].length) {
      b.onclick = () => {
        qualityFilter = key;
        setActiveView("inbox");
        render();
        if (key === "unclassified") {
          setRulesExpanded(true);
          document.getElementById("aiWorkflow").scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        } else {
          document.getElementById("workboxLedger").scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      };
    }
    wrap.appendChild(b);
  });
}
function renderImportHistory() {
  const card = document.getElementById("importHistoryCard");
  const list = document.getElementById("importHistoryList");
  const recent = importBatches.slice(0, 5);
  card.style.display = recent.length ? "block" : "none";
  document.getElementById("importHistoryCount").textContent = recent.length
    ? `${recent.length} 批`
    : "";
  list.innerHTML = "";
  recent.forEach((batch) => {
    const row = document.createElement("div");
    row.className = "import-history-row";
    const when = new Date(batch.createdAt);
    const label = `${when.getMonth() + 1}/${when.getDate()} ${
      batch.type === "invoice" ? "發票" : "信用卡"
    }`;
    const remaining = (batch.addedIds || []).filter((id) =>
      entries.some((e) => e.id === id)
    ).length;
    row.innerHTML =
      `<div class="import-history-meta"><div class="import-history-title">${
        escapeHtml(label)
      } · ${
        escapeHtml((batch.files || []).join("、"))
      }</div><div class="import-history-sub">${
        escapeHtml(batch.summary || "")
      } ${
        batch.undone ? "· 已復原" : ""
      }</div></div><button class="undo-batch-btn" type="button" ${
        batch.undone || remaining === 0 ? "disabled" : ""
      }>復原</button>`;
    const btn = row.querySelector(".undo-batch-btn");
    if (!btn.disabled) btn.onclick = () => undoImportBatch(batch.id);
    list.appendChild(row);
  });
}

function computeMonthStats(mk) {
  const monthEntries = entries.filter((e) =>
    monthKeyOf(e.date) === mk && isCounted(e)
  );
  const total = monthEntries.reduce((s, e) => s + e.amount, 0);
  const byCategory = {};
  monthEntries.forEach((e) => {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });
  const byVendor = {};
  monthEntries.forEach((e) => {
    const raw = (e.vendor || e.note || "").trim();
    if (!raw) return;
    const v = e.vendor ? canonicalVendorDisplay(raw) : raw;
    byVendor[v] = (byVendor[v] || 0) + e.amount;
  });
  return { total, byCategory, byVendor, count: monthEntries.length };
}

function renderStats() {
  // navigable range: earliest month with any data, through whichever is
  // later of (latest month with data) or (the actual current month) — so
  // you can always page forward to "now" even before this month has any
  // entries yet, but can't wander into empty years beyond that.
  const monthsWithData = [...new Set(entries.map((e) => monthKeyOf(e.date)))]
    .sort();
  const todayMonth = monthKeyOf(toKey(new Date()));
  const earliestMonth = monthsWithData[0] || todayMonth;
  const latestMonth = monthsWithData.length &&
      monthsWithData[monthsWithData.length - 1] > todayMonth
    ? monthsWithData[monthsWithData.length - 1]
    : todayMonth;

  if (statsMonthKey === null) {
    statsMonthKey = monthsWithData.length
      ? monthsWithData[monthsWithData.length - 1]
      : todayMonth;
  }
  if (statsMonthKey < earliestMonth) statsMonthKey = earliestMonth;
  if (statsMonthKey > latestMonth) statsMonthKey = latestMonth;

  const stats = computeMonthStats(statsMonthKey);
  const prevStats = computeMonthStats(shiftMonthKey(statsMonthKey, -1));

  statsMonthLabelEl.textContent = monthLabel(statsMonthKey) + " 統計";
  statsTotalAmtEl.textContent = fmt(stats.total);

  if (prevStats.total === 0 && stats.total === 0) {
    statsDeltaEl.textContent = "";
    statsDeltaEl.className = "stats-delta";
  } else if (prevStats.total === 0) {
    statsDeltaEl.textContent = "上月無資料";
    statsDeltaEl.className = "stats-delta flat";
  } else {
    const diffPct = Math.round(
      (stats.total - prevStats.total) / prevStats.total * 100,
    );
    if (diffPct === 0) {
      statsDeltaEl.textContent = "與上月持平";
      statsDeltaEl.className = "stats-delta flat";
    } else {
      statsDeltaEl.textContent = (diffPct > 0 ? "▲ 比上月多 " : "▼ 比上月少 ") +
        Math.abs(diffPct) + "%";
      statsDeltaEl.className = "stats-delta " + (diffPct > 0 ? "up" : "down");
    }
  }

  const catEntries = Object.entries(stats.byCategory).sort((a, b) =>
    b[1] - a[1]
  );
  if (catEntries.length === 0) {
    statsCategoryBarsEl.innerHTML =
      '<div class="stats-empty">這個月還沒有紀錄</div>';
  } else {
    const maxAmt = catEntries[0][1];
    statsCategoryBarsEl.innerHTML = catEntries.map(([cat, amt]) => {
      const pct = stats.total ? Math.round(amt / stats.total * 100) : 0;
      const widthPct = maxAmt ? Math.round(amt / maxAmt * 100) : 0;
      return `
        <div class="cat-bar-row">
          <div class="cat-bar-label"><span>${escapeHtml(cat)}</span><span>${
        fmt(amt)
      } <span class="cat-bar-pct">${pct}%</span></span></div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${widthPct}%"></div></div>
        </div>`;
    }).join("");
  }

  const vendorEntries = Object.entries(stats.byVendor).sort((a, b) =>
    b[1] - a[1]
  ).slice(0, 5);
  statsVendorsEl.innerHTML = vendorEntries.length === 0
    ? ""
    : '<div class="stats-vendors-title">TOP 店家</div>' +
      vendorEntries.map(([v, amt]) => `
      <div class="stats-vendor-row"><span class="v-name" title="${
        escapeHtml(v)
      }">${escapeHtml(v)}</span><span class="v-amt">${fmt(amt)}</span></div>`)
        .join("");

  statsPrevBtn.disabled = statsMonthKey <= earliestMonth;
  statsNextBtn.disabled = statsMonthKey >= latestMonth;
}

statsPrevBtn.addEventListener("click", () => {
  statsMonthKey = shiftMonthKey(statsMonthKey, -1);
  renderStats();
});
statsNextBtn.addEventListener("click", () => {
  statsMonthKey = shiftMonthKey(statsMonthKey, 1);
  renderStats();
});

let searchQuery = "";

function renderSearchResults(visible) {
  const matches = visible.slice().sort((a, b) => b.ts - a.ts);

  ledgerEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "search-result-head";
  const total = matches.filter(isCounted).reduce((sum, e) => sum + e.amount, 0);
  head.textContent = matches.length
    ? `找到 ${matches.length} 筆 · 合計 ${fmt(total)}`
    : "沒有符合的紀錄";
  ledgerEl.appendChild(head);

  matches.forEach((e) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    const dateLbl = document.createElement("div");
    dateLbl.className = "search-result-date";
    dateLbl.textContent = dateLabel(e.date);
    card.appendChild(dateLbl);
    card.appendChild(renderItemRow(e));
    ledgerEl.appendChild(card);
  });

  attachLedgerHandlers();
}

function render() {
  renderStats();
  renderQualityCard();
  renderImportHistory();
  renderAppChrome();

  const visible = getFilteredLedgerEntries();

  if (hasActiveLedgerFilters()) {
    renderSearchResults(visible);
    return;
  }

  if (visible.length === 0) {
    ledgerEl.innerHTML =
      '<div class="empty-state">還沒有紀錄<br>記下第一筆消費,或匯入發票/帳單吧</div>';
    return;
  }

  const dateGrouped = visible;
  ledgerEl.innerHTML = "";

  if (dateGrouped.length === 0) {
    attachLedgerHandlers();
    return;
  }

  const groups = {};
  dateGrouped.forEach((e) => {
    (groups[e.date] = groups[e.date] || []).push(e);
  });
  const dateKeys = Object.keys(groups).sort().reverse();

  // group day-keys into months, preserving descending order
  const monthOrder = [];
  const monthMap = {};
  dateKeys.forEach((key) => {
    const mk = monthKeyOf(key);
    if (!monthMap[mk]) {
      monthMap[mk] = [];
      monthOrder.push(mk);
    }
    monthMap[mk].push(key);
  });

  if (expandedMonths === null) {
    expandedMonths = new Set(monthOrder.slice(0, 1));
  }

  monthOrder.forEach((mk) => {
    const daysInMonth = monthMap[mk];
    const monthEntries = daysInMonth.flatMap((k) => groups[k]);
    const monthTotal = monthEntries.filter(isCounted).reduce(
      (s, e) => s + e.amount,
      0,
    );
    const isExpanded = expandedMonths.has(mk);

    const monthSection = document.createElement("div");
    monthSection.className = "month-section";
    const monthHead = document.createElement("div");
    monthHead.className = "month-head";
    monthHead.setAttribute("data-month", mk);
    monthHead.innerHTML = `
      <span class="month-toggle">${isExpanded ? "▾" : "▸"}</span>
      <span class="month-label">${monthLabel(mk)}</span>
      <span class="month-total">${fmt(monthTotal)}</span>
    `;
    monthSection.appendChild(monthHead);

    if (isExpanded) {
      daysInMonth.forEach((key) => {
        const dayEntries = groups[key];
        const dayTotal = dayEntries.filter(isCounted).reduce(
          (s, e) => s + e.amount,
          0,
        );

        const group = document.createElement("div");
        group.className = "day-group";
        const head = document.createElement("div");
        head.className = "day-head";
        head.innerHTML = `<span>${
          dateLabel(key)
        }</span><span class="day-total">${fmt(dayTotal)}</span>`;
        group.appendChild(head);

        const blocks = buildDayBlocks(dayEntries);
        blocks.forEach((block) => {
          if (block.type === "single") {
            const card = document.createElement("div");
            card.className = "entry-card";
            card.appendChild(renderItemRow(block.entry));
            group.appendChild(card);
            return;
          }
          // invoice group: several items belonging to the same 發票號碼
          const items = block.items;
          const vendor = items[0].vendor || "";
          const subtotal = items.reduce((s, i) => s + i.amount, 0);
          const originalSubtotal = items.reduce(
            (sum, item) => sum + reconciliationAmount(item),
            0,
          );
          const ccMatch = items[0].matchedId
            ? entries.find((e) => e.id === items[0].matchedId)
            : null;
          const excludedAsPlatformFee = !ccMatch &&
            isPlatformFeeOnlyInvoice(items[0]);
          const wrap = document.createElement("div");
          wrap.className = "invoice-group";
          const invoiceExpanded = expandedInvoices.has(block.invoiceNo);
          const headRow = document.createElement("div");
          headRow.className = "invoice-head";
          headRow.setAttribute("role", "button");
          headRow.setAttribute("tabindex", "0");
          headRow.setAttribute("aria-expanded", String(invoiceExpanded));
          headRow.setAttribute(
            "aria-label",
            `${vendor || "發票"}，${items.length} 個品項，${
              invoiceExpanded ? "收合明細" : "展開明細"
            }`,
          );
          headRow.innerHTML = `
            <div class="invoice-head-top">
              <span class="src">🧾</span>
              <span class="vendor-name" title="${escapeHtml(vendor)}">${
            escapeHtml(vendor)
          }</span>
            </div>
            <div class="invoice-head-bottom">
              <span class="invoice-meta">
                <span class="invoice-no-chip">${
            escapeHtml(block.invoiceNo)
          }</span>
                <span class="invoice-item-count">${items.length} 個品項</span>
              </span>
              <span class="amount-stack">
                <span class="invoice-sub">${fmt(subtotal)}</span>
                ${
            Math.abs(originalSubtotal - subtotal) >= 0.01
              ? `<span class="original-amount">原 ${
                fmt(originalSubtotal)
              }</span>`
              : ""
          }
              </span>
              <span class="invoice-toggle" aria-hidden="true">${
            invoiceExpanded ? "▴" : "▾"
          }</span>
            </div>
          `;
          const toggleInvoice = () => {
            if (expandedInvoices.has(block.invoiceNo)) {
              expandedInvoices.delete(block.invoiceNo);
              openingInvoiceNo = null;
            } else {
              expandedInvoices.add(block.invoiceNo);
              openingInvoiceNo = block.invoiceNo;
            }
            render();
          };
          headRow.addEventListener("click", toggleInvoice);
          headRow.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleInvoice();
          });
          wrap.appendChild(headRow);

          // credit-card reconciliation info renders as its own visible,
          // clearly-bounded block (icon → bank-tag → note → amount, plus a
          // caption) instead of being hidden behind a badge's hover tooltip
          // or floating loose above the item list. Bank is always shown —
          // falls back to a generic "信用卡" tag on the rare entry that has
          // no bank label recorded, so this line never looks like it's
          // missing information.
          if (ccMatch) {
            const ccNote = ccMatch.vendor || ccMatch.note || "";
            const ccBlock = document.createElement("div");
            ccBlock.className = "cc-match-block";
            ccBlock.innerHTML = `
              <div class="cc-match-row">
                <span class="cc-match-icon">💳</span>
                <span class="bank-tag${
              ccMatch.bank ? "" : " bank-tag-empty"
            }" data-id="${escapeAttribute(ccMatch.id)}">${
              ccMatch.bank ? escapeHtml(ccMatch.bank) : "+銀行"
            }</span>
                <span class="cc-match-note" title="${escapeHtml(ccNote)}">${
              escapeHtml(ccNote)
            }</span>
                <span class="cc-match-amt">${fmt(ccMatch.amount)}</span>
                <button class="unmatch-btn" type="button" data-id="${
              escapeAttribute(ccMatch.id)
            }" data-no="${escapeAttribute(block.invoiceNo)}">解除配對</button>
              </div>
              <div class="cc-match-hint">已比對信用卡消費,不重複計入總額</div>
            `;
            wrap.appendChild(ccBlock);
          }
          if (excludedAsPlatformFee) {
            const feeBlock = document.createElement("div");
            feeBlock.className = "cc-match-block fee-block";
            feeBlock.innerHTML = `
              <div class="cc-match-row">
                <span class="cc-match-icon">🛵</span>
                <span class="cc-match-note">已含於信用卡消費</span>
              </div>
              <div class="cc-match-hint">不計入總額,避免與信用卡重複計算</div>
            `;
            wrap.appendChild(feeBlock);
          }

          const itemsWrap = document.createElement("div");
          itemsWrap.className = "invoice-items";
          if (invoiceExpanded && openingInvoiceNo === block.invoiceNo) {
            itemsWrap.classList.add("is-opening");
          }
          itemsWrap.hidden = !invoiceExpanded;
          items.sort((a, b) => b.ts - a.ts).forEach((item) => {
            itemsWrap.appendChild(renderItemRow(item, { hideSrc: true }));
          });
          wrap.appendChild(itemsWrap);
          group.appendChild(wrap);
        });

        monthSection.appendChild(group);
      });
    }

    ledgerEl.appendChild(monthSection);
  });

  attachLedgerHandlers();
  openingInvoiceNo = null;
}
