let selectedTransactionId = null;

function transactionSummary(block) {
  const first = block.entry || block.items[0];
  const title = (first.vendor || first.note || first.category || "").trim();
  const invoiceItems = block.items ||
    (first.source === "creditcard" && first.matchedId
      ? entries.filter((e) =>
        e.source === "invoice" && e.invoiceNo === first.matchedId
      )
      : []);
  const names = [
    ...new Set(
      invoiceItems.map((item) => (item.note || "").trim())
        .filter((name) => name && name !== title),
    ),
  ];
  const detail = names.length
    ? names.slice(0, 3).join("、") +
      (names.length > 3 ? `… · 共 ${invoiceItems.length} 項` : "")
    : (first.note || "").trim() !== title
    ? (first.note || "").trim()
    : "";
  return [detail, first.bank, first.matchedId ? "已配對" : ""].filter(Boolean)
    .join(" · ");
}

function render() {
  renderDashboard();
  renderStats();
  renderQualityCard();
  renderImportHistory();
  renderCreditCardImportChecklist();
  renderAppChrome();
  renderTransactionWorkspace();
}

function renderTransactionWorkspace() {
  const visible = getFilteredLedgerEntries();
  const blocks = buildDayBlocks(visible);
  const dayTotals = new Map();
  const monthTotals = new Map();
  visible.forEach((entry) => {
    const amount = isCounted(entry) ? entry.amount : 0;
    dayTotals.set(entry.date, (dayTotals.get(entry.date) || 0) + amount);
    const month = monthKeyOf(entry.date);
    monthTotals.set(month, (monthTotals.get(month) || 0) + amount);
  });
  if (expandedMonths === null) {
    expandedMonths = new Set(
      [...monthTotals.keys()].sort().reverse().slice(0, 1),
    );
  }
  blocks.sort((a, b) => {
    const first = a.entry || a.items[0], second = b.entry || b.items[0];
    return second.date.localeCompare(first.date) || b.ts - a.ts;
  });
  ledgerEl.innerHTML =
    `<div class="transaction-workspace"><section class="transaction-list"><div class="transaction-columns"><span>種類</span><span>店家／備註</span><span>分類</span><span>金額</span></div><div id="transactionRows"></div></section><aside class="transaction-aside" id="transactionAside"></aside></div>`;
  const list = document.getElementById("transactionRows");
  if (invoiceImportResult) {
    const summary = document.createElement("section");
    summary.className = "transaction-exclusion-note";
    const invoiceCount = new Set(visible.map((e) => e.invoiceNo || e.id)).size;
    const total = visible.filter(isCounted).reduce(
      (sum, e) => sum + e.amount,
      0,
    );
    summary.innerHTML =
      `<strong>本次新增發票消費</strong><p>${invoiceCount} 張發票 · ${visible.length} 個品項 · 計入支出 ${
        fmt(total)
      }</p><small>${escapeHtml(invoiceImportResult.summary)}</small>`;
    if (invoiceImportResult.unclassifiedCount) {
      const review = document.createElement("button");
      review.type = "button";
      review.className = "import-result-review";
      review.textContent =
        `處理 ${invoiceImportResult.unclassifiedCount} 個待分類品項 →`;
      review.onclick = openImportedUnclassified;
      summary.appendChild(review);
    }
    list.before(summary);
  }
  let currentDate = null;
  let dateSection = null;
  let selected = null;
  let currentMonth = null;
  let monthSection = null;
  blocks.forEach((block) => {
    const items = block.items || [block.entry];
    const first = items[0];
    const month = monthKeyOf(first.date);
    if (month !== currentMonth) {
      currentMonth = month;
      monthSection = document.createElement("details");
      monthSection.className = "transaction-month";
      monthSection.open = expandedMonths.has(month) || hasActiveLedgerFilters();
      const summary = document.createElement("summary");
      summary.innerHTML = `<span>${
        escapeHtml(monthLabel(month))
      }</span><span class="month-total">${fmt(monthTotals.get(month))}</span>`;
      monthSection.appendChild(summary);
      summary.addEventListener("click", (event) => {
        event.preventDefault();
        const section = event.currentTarget.parentElement;
        section.open = !section.open;
        if (section.open) expandedMonths.add(month);
        else expandedMonths.delete(month);
      });
      list.appendChild(monthSection);
    }
    if (first.date !== currentDate) {
      currentDate = first.date;
      dateSection = document.createElement("section");
      dateSection.className = "transaction-date-section";
      const heading = document.createElement("h2");
      heading.className = "transaction-date-heading";
      heading.innerHTML = `<span>${
        escapeHtml(dateLabel(first.date))
      }</span><span class="day-total">${fmt(dayTotals.get(first.date))}</span>`;
      dateSection.appendChild(heading);
      monthSection.appendChild(dateSection);
    }
    const key = block.type === "invoice"
      ? `invoice:${block.invoiceNo}`
      : first.id;
    if (key === selectedTransactionId) selected = block;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "transaction-row";
    button.dataset.transactionId = key;
    button.setAttribute("aria-pressed", String(key === selectedTransactionId));
    const categories = [...new Set(items.map((e) => e.category))].join("、");
    const source = {
      cash: ["💵", "現金"],
      creditcard: ["💳", "信用卡"],
      invoice: ["🧾", "發票"],
    }[first.source] || ["", "其他"];
    const summary = transactionSummary(block);
    const subtotal = items.reduce((sum, e) => sum + e.amount, 0);
    const originalSubtotal = items.reduce(
      (sum, e) => sum + reconciliationAmount(e),
      0,
    );
    const card = first.matchedId &&
      entries.find((e) => e.id === first.matchedId);
    const metadata = [
      block.invoiceNo ? `${block.invoiceNo} · ${items.length} 個品項` : "",
      card ? `${card.bank || "信用卡"} · 已比對，不重複計入總額` : "",
      first.source === "creditcard" && !first.matchedId && !first.reviewed
        ? "待確認"
        : "",
      first.source === "creditcard" && first.suggestedInvoiceNo &&
        !first.matchedId
        ? "有建議配對"
        : "",
      items.some((e) => e.edited) ? "✎ 已修改" : "",
    ].filter(Boolean).join(" · ");
    button.innerHTML =
      `<span class="transaction-source"><span aria-hidden="true">${
        source[0]
      }</span> ${source[1]}</span><span class="transaction-name"><strong>${
        escapeHtml(first.vendor || first.note || first.category)
      }</strong>${
        summary
          ? `<small class="transaction-summary" title="${
            escapeAttribute(summary)
          }">${escapeHtml(summary)}</small>`
          : ""
      }${
        items.every(isPlatformFeeOnlyInvoice)
          ? '<small class="transaction-excluded">不計入總額</small>'
          : ""
      }${
        metadata
          ? `<small class="transaction-meta">${escapeHtml(metadata)}</small>`
          : ""
      }</span><span class="transaction-category">${
        escapeHtml(categories)
      }</span><span class="amount-stack"><b>${fmt(subtotal)}</b>${
        Math.abs(originalSubtotal - subtotal) >= 0.01
          ? `<small class="original-amount">原 ${fmt(originalSubtotal)}</small>`
          : ""
      }</span>`;
    button.onclick = () => {
      selectedTransactionId = key;
      updateTransactionSelection();
      renderTransactionAside(block);
      document.getElementById("closeTransactionDetail").focus({
        preventScroll: true,
      });
    };
    dateSection.appendChild(button);
  });
  if (!blocks.length) {
    list.innerHTML = invoiceImportResult
      ? '<p class="empty-state">此次沒有新增發票，或項目已刪除／復原／被篩選排除</p>'
      : '<p class="empty-state">沒有符合的紀錄</p>';
  }
  renderTransactionAside(selected);
}

function updateTransactionSelection() {
  ledgerEl.querySelectorAll(".transaction-row").forEach((row) => {
    row.setAttribute(
      "aria-pressed",
      String(row.dataset.transactionId === selectedTransactionId),
    );
  });
}

function renderTransactionAside(selected) {
  const aside = document.getElementById("transactionAside");
  aside.onkeydown = null;
  aside.classList.toggle("detail-open", !!selected);
  if (!selected) {
    selectedTransactionId = null;
    aside.innerHTML =
      `<h2>待辦</h2><button id="workspaceReview">待處理 ${workboxCount()} 筆 →</button><h3>本月帳單</h3>${
        creditCardImportPlan.cards.map((card) =>
          `<div class="dashboard-bank"><span>${
            escapeHtml(card.name)
          }</span><span>${
            creditCardImportPlan.months[creditCardPlanMonthKey()]?.[card.id]
                ?.status === "imported"
              ? "已匯入"
              : creditCardImportPlan.months[creditCardPlanMonthKey()]?.[card.id]
                  ?.status === "skipped"
              ? "已略過"
              : "待匯入"
          }</span></div>`
        ).join("")
      }<button id="workspaceImport">匯入帳單 →</button>`;
    document.getElementById("workspaceReview").onclick = () =>
      setActiveView("inbox");
    document.getElementById("workspaceImport").onclick = () =>
      setActiveView("imports");
    return;
  }
  aside.classList.add("detail-open");
  aside.innerHTML =
    '<div class="detail-heading"><h2>交易詳情</h2><button id="closeTransactionDetail" type="button" aria-label="關閉交易詳情">✕</button></div>';
  const close = () => {
    const trigger = [...ledgerEl.querySelectorAll(".transaction-row")].find((
      row,
    ) => row.dataset.transactionId === selectedTransactionId);
    selectedTransactionId = null;
    updateTransactionSelection();
    renderTransactionAside(null);
    trigger?.focus({ preventScroll: true });
  };
  document.getElementById("closeTransactionDetail").onclick = close;
  aside.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  const items = selected.items || [selected.entry];
  if (items.every(isPlatformFeeOnlyInvoice)) {
    const notice = document.createElement("p");
    notice.className = "transaction-exclusion-note";
    notice.innerHTML =
      "<strong>已含於信用卡消費</strong><br>不計入總額，避免與信用卡重複計算";
    aside.appendChild(notice);
  }
  if (selected.invoiceNo) {
    const label = document.createElement("p");
    label.textContent = `${
      items[0].vendor || "發票"
    } · 發票 ${selected.invoiceNo} · ${items.length} 個品項`;
    aside.appendChild(label);
  }
  items.forEach((entry) => aside.appendChild(renderItemRow(entry)));
  const card = selected.items &&
    entries.find((e) => e.id === items[0].matchedId);
  if (card) {
    const linked = document.createElement("section");
    linked.innerHTML =
      `<h3>配對信用卡</h3><p>已配對，不重複計入支出</p><button class="unmatch-btn" data-id="${
        escapeAttribute(card.id)
      }" data-no="${escapeAttribute(selected.invoiceNo)}">解除配對</button>`;
    linked.appendChild(renderItemRow(card));
    aside.appendChild(linked);
  }
  attachLedgerHandlers(aside);
}
