/* ---------- export / clear ---------- */

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 100000;

function isValidDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(value + "T00:00:00");
  return !Number.isNaN(date.getTime()) && toKey(date) === value;
}

function validateBackupData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("備份內容不是有效物件");
  }
  if (data.format !== undefined && data.format !== "expense-ledger-backup") {
    throw new Error("不是 Expense Ledger 備份檔");
  }
  if (
    data.version !== undefined &&
    (!Number.isInteger(data.version) || data.version < 1 || data.version > 2)
  ) {
    throw new Error("備份版本不受支援");
  }
  if (!Array.isArray(data.entries)) throw new Error("找不到記帳資料");
  if (data.entries.length > MAX_BACKUP_ENTRIES) {
    throw new Error(`記帳資料超過 ${MAX_BACKUP_ENTRIES} 筆上限`);
  }

  const ids = new Set();
  const optionalStrings = [
    "note",
    "originalNote",
    "vendor",
    "originalVendor",
    "bank",
    "originalBank",
    "invoiceNo",
    "matchedId",
    "suggestedInvoiceNo",
    "importBatchId",
  ];
  const optionalBooleans = [
    "reviewed",
    "categoryManual",
    "categoryReviewed",
    "categoryLearned",
    "edited",
  ];
  data.entries.forEach((entry, index) => {
    const label = `第 ${index + 1} 筆記錄`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}不是有效物件`);
    }
    if (
      typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 200
    ) throw new Error(`${label}的 ID 無效`);
    if (ids.has(entry.id)) throw new Error(`${label}使用了重複 ID`);
    ids.add(entry.id);
    if (!["cash", "invoice", "creditcard"].includes(entry.source)) {
      throw new Error(`${label}的資料來源無效`);
    }
    if (!Number.isFinite(entry.amount)) throw new Error(`${label}的金額無效`);
    if (!isValidDateKey(entry.date)) throw new Error(`${label}的日期無效`);
    if (!Number.isFinite(entry.ts)) throw new Error(`${label}的時間戳記無效`);
    if (
      typeof entry.category !== "string" || !entry.category.trim() ||
      entry.category.length > 50
    ) {
      throw new Error(`${label}的分類無效`);
    }
    optionalStrings.forEach((field) => {
      if (
        entry[field] !== undefined && entry[field] !== null &&
        (typeof entry[field] !== "string" || entry[field].length > 2000)
      ) {
        throw new Error(`${label}的 ${field} 欄位無效`);
      }
    });
    optionalBooleans.forEach((field) => {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") {
        throw new Error(`${label}的 ${field} 欄位無效`);
      }
    });
    if (
      entry.originalAmount !== undefined &&
      !Number.isFinite(entry.originalAmount)
    ) {
      throw new Error(`${label}的原始金額無效`);
    }
    if (
      entry.rejectedInvoiceNos !== undefined &&
      (!Array.isArray(entry.rejectedInvoiceNos) ||
        entry.rejectedInvoiceNos.some((value) => typeof value !== "string"))
    ) {
      throw new Error(`${label}的排除配對資料無效`);
    }
  });

  if (data.vendorAliases !== undefined) {
    if (
      !Array.isArray(data.vendorAliases) || data.vendorAliases.length > 10000 ||
      data.vendorAliases.some((value) =>
        typeof value !== "string" || value.length > 1000
      )
    ) {
      throw new Error("店家對應資料無效");
    }
  }
  if (data.importBatches !== undefined) {
    if (
      !Array.isArray(data.importBatches) || data.importBatches.length > 1000
    ) throw new Error("匯入批次資料無效");
    data.importBatches.forEach((batch, index) => {
      const invalid = !batch || typeof batch !== "object" ||
        Array.isArray(batch) ||
        typeof batch.id !== "string" || !batch.id || batch.id.length > 200 ||
        !["invoice", "creditcard"].includes(batch.type) ||
        typeof batch.createdAt !== "string" ||
        Number.isNaN(Date.parse(batch.createdAt)) ||
        !Array.isArray(batch.files) || batch.files.some((value) =>
          typeof value !== "string" || value.length > 1000
        ) ||
        !Array.isArray(batch.addedIds) || batch.addedIds.some((value) =>
          typeof value !== "string" || value.length > 200
        ) ||
        (batch.summary !== undefined &&
          (typeof batch.summary !== "string" ||
            batch.summary.length > 10000)) ||
        (batch.undone !== undefined && typeof batch.undone !== "boolean") ||
        (batch.linkSnapshot !== undefined &&
          (!batch.linkSnapshot || typeof batch.linkSnapshot !== "object" ||
            Array.isArray(batch.linkSnapshot)));
      if (invalid) {
        throw new Error(`第 ${index + 1} 筆匯入批次資料無效`);
      }
    });
  }
  return data;
}

function exportCSV() {
  if (entries.length === 0) {
    showToast("沒有資料可匯出");
    return;
  }
  const rows = [[
    "日期",
    "來源",
    "銀行/卡片",
    "分類",
    "金額",
    "店家/備註",
    "發票號碼",
    "狀態",
  ]];
  entries.slice().sort((a, b) => a.ts - b.ts).forEach((e) => {
    const srcLabel =
      { cash: "現金", invoice: "發票", creditcard: "信用卡" }[e.source];
    const status = (e.source === "creditcard" && e.matchedId)
      ? "已與發票合併(不重複計入)"
      : (e.source === "invoice" && e.matchedId)
      ? "已與信用卡合併"
      : isPlatformFeeOnlyInvoice(e)
      ? "已含於信用卡消費(不重複計入)"
      : "計入總額";
    rows.push([
      e.date,
      srcLabel,
      e.bank || "",
      e.category,
      e.amount,
      (e.note || e.vendor || "").replace(/,/g, "、"),
      e.invoiceNo || "",
      status,
    ]);
  });
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "記帳紀錄_" + toKey(new Date()) + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportVendorAliases() {
  if (vendorAliases.length === 0) {
    showToast("目前還沒有學到任何店家對應");
    return;
  }
  const rows = [["信用卡店名(標準化後)", "發票公司名稱(標準化後)"]];
  vendorAliases.forEach((key) => {
    const [ccPart, invPart] = key.split("␟");
    rows.push([ccPart, invPart]);
  });
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "已學習店家對應_" + toKey(new Date()) + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`已匯出 ${vendorAliases.length} 組店家對應`);
}

// full backup: every raw entry + the learned vendor-alias list, as JSON —
// this is the actual data model (window.storage's 'expense-entries' /
// 'vendor-aliases' keys), not a display-formatted export like exportCSV.
// Meant as a downloadable file the user can hold onto themselves, and as
// the source for importBackup() below to restore from.
function exportBackup() {
  if (entries.length === 0 && vendorAliases.length === 0) {
    showToast("沒有資料可備份");
    return;
  }
  const backup = {
    format: "expense-ledger-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    entries,
    vendorAliases,
    importBatches,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "記帳本備份_" + toKey(new Date()) + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(
    `已匯出備份:${entries.length} 筆紀錄、${vendorAliases.length} 組店家對應`,
  );
}

// restore merges rather than replaces: any entry whose id already exists in
// the current ledger is skipped (already have it), anything new gets added.
// This is deliberately non-destructive — restoring an older backup on top
// of a ledger that already has newer data won't wipe the newer data, so it
// doesn't need a "are you sure" gate the way 清空全部 does.
async function importBackup(file) {
  if (!file) return;
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }
  if (Number.isFinite(file.size) && file.size > MAX_BACKUP_BYTES) {
    showToast("備份檔案過大，為避免瀏覽器無法回應已停止匯入");
    return;
  }
  let data;
  try {
    data = validateBackupData(JSON.parse(await file.text()));
  } catch (error) {
    showToast(`備份檔案格式錯誤：${error.message}`);
    return;
  }

  const existingIds = new Set(entries.map((e) => e.id));
  let added = 0;
  data.entries.forEach((e) => {
    if (e && e.id && !existingIds.has(e.id)) {
      ensureOriginalFields(e);
      entries.push(e);
      existingIds.add(e.id);
      added++;
    }
  });

  let aliasAdded = 0;
  if (Array.isArray(data.vendorAliases)) {
    data.vendorAliases.forEach((key) => {
      if (typeof key === "string" && !vendorAliases.includes(key)) {
        vendorAliases.push(key);
        vendorAliasGraphCache = null;
        aliasAdded++;
      }
    });
  }

  if (Array.isArray(data.importBatches)) {
    const known = new Set(importBatches.map((b) => b.id));
    data.importBatches.forEach((b) => {
      if (b && b.id && !known.has(b.id)) {
        importBatches.push(b);
        known.add(b.id);
      }
    });
    importBatches.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
    importBatches = importBatches.slice(0, 20);
    await saveImportBatches();
  }

  await saveEntries();
  await saveVendorAliases();
  reconcile();
  await saveEntries();
  render();

  if (added === 0 && aliasAdded === 0) {
    showToast("備份裡的資料都已經在目前的帳本裡了,沒有新增");
  } else {
    showToast(
      `已還原備份:新增 ${added} 筆紀錄` +
        (aliasAdded ? `、${aliasAdded} 組店家對應` : ""),
    );
  }
}

let clearArmed = false;
let clearArmTimeout = null;
const clearBtnEl = document.getElementById("clearBtn");

async function clearAll() {
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }
  if (!clearArmed) {
    clearArmed = true;
    clearBtnEl.textContent = "再按一次清空全部";
    showToast("確定要清空嗎?再按一次「清空全部」執行,3秒內有效");
    clearTimeout(clearArmTimeout);
    clearArmTimeout = setTimeout(() => {
      clearArmed = false;
      clearBtnEl.textContent = "清空全部";
    }, 3000);
    return;
  }
  clearTimeout(clearArmTimeout);
  clearArmed = false;
  clearBtnEl.textContent = "清空全部";
  entries = [];
  importBatches = [];
  await saveEntries();
  await saveImportBatches();
  render();
  showToast("已清空");
}

saveBtn.addEventListener("click", addEntry);
amountInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addEntry();
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.trim().toLowerCase();
  render();
});
document.getElementById("exportBtn").addEventListener("click", exportCSV);
document.getElementById("exportAliasBtn").addEventListener(
  "click",
  exportVendorAliases,
);
document.getElementById("exportBackupBtn").addEventListener(
  "click",
  exportBackup,
);
document.getElementById("backupFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  importBackup(f);
  e.target.value = "";
});
document.getElementById("clearBtn").addEventListener("click", clearAll);

(async function init() {
  renderChips();
  initializeUI();
  const modeBanner = document.getElementById("storageModeBanner");
  if (storageMode === "file") modeBanner.style.display = "block";
  try {
    await loadEntries();
    const needsOriginalMigration = entries.some((e) =>
      !Object.prototype.hasOwnProperty.call(e, "originalAmount") ||
      !Object.prototype.hasOwnProperty.call(e, "originalVendor") ||
      !Object.prototype.hasOwnProperty.call(e, "originalNote") ||
      !Object.prototype.hasOwnProperty.call(e, "originalBank")
    );
    entries.forEach(ensureOriginalFields);
    if (needsOriginalMigration) await saveEntries();
    await loadVendorAliases();
    await loadImportBatches();
    await loadLedgerMeta();
  } catch (error) {
    modeBanner.style.display = "block";
    modeBanner.textContent = storageMode === "file"
      ? "本機測試資料載入失敗，已停止所有資料操作。請確認 deno task dev 仍在執行後重新整理。"
      : "瀏覽器儲存空間無法使用或資料損壞，已停止所有資料操作。請先保留現有備份並檢查瀏覽器設定。";
    showToast("資料載入失敗，未進行任何修改");
    console.error(error);
    return;
  }
  dataLoaded = true;
  render();
  renderLedgerMetaFooter();
})();
