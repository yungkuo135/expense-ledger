/* ---------- CSV import & matching ---------- */

function parseCSV(text) {
  const rows = [];
  let cur = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += c;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function detectColumns(headers) {
  const h = headers.map((x) => (x || "").trim());
  const findIdx = (keywords) =>
    h.findIndex((col) => keywords.some((k) => col.includes(k)));
  return {
    dateIdx: findIdx(["日期", "交易日", "消費日", "入帳日"]),
    amountIdx: findIdx(["金額", "總金額", "消費金額", "台幣金額"]),
    vendorIdx: findIdx([
      "賣方",
      "店家",
      "商店",
      "消費明細",
      "摘要",
      "說明",
      "特店",
      "名稱",
    ]),
    bankIdx: findIdx(["銀行", "卡別", "發卡", "卡片", "卡名"]),
  };
}

function parseDateFlexible(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  let m = s.match(/^(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    let y = parseInt(m[1], 10);
    if (y < 1000) y += 1911;
    return new Date(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  m = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) {
    return new Date(
      parseInt(m[1], 10) + 1911,
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
    );
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    return new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
    );
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

// classification is entirely AI-assisted now, not keyword-guessed at import
// time — a substring-matching keyword list turned out to produce coincidental
// misfires (e.g. a "米" keyword meant to catch 白米 purchases also matched
// inside "玉米", silently mis-attributing the reasoning even when the
// resulting category happened to look plausible). Every newly imported entry
// starts in "其他" and gets classified through the "🤖 AI 輔助分類" panel
// instead, which is deliberate and reviewable rather than a silent guess.
function guessCategory(vendor) {
  return "其他";
}

function guessCategoryForItem(itemName, vendor) {
  return "其他";
}

// the text used to identify a given entry for AI-assisted classification —
// same field priority as guessCategoryForItem already uses (invoice items
// go by the item name first, cash/credit-card entries by vendor), so the
// name shown to the AI is the same one matched back against on apply.
function classifyLookupText(e) {
  return e.source === "invoice"
    ? (e.note || e.vendor || "")
    : (e.vendor || e.note || "");
}

// Entries still sitting in the catch-all "其他" bucket that have never had an
// explicit category decision are the ones an AI-assisted pass can help with.
// Both direct edits and AI-confirmed "其他" are deliberate choices, not gaps.
function getUnclassifiedNames() {
  const names = new Set();
  entries.forEach((e) => {
    if (isCategoryReviewed(e)) return;
    if (e.category !== "其他") return;
    const name = classifyLookupText(e).trim();
    if (name) names.add(name);
  });
  return [...names].sort();
}

function buildAiClassifyPrompt(names) {
  return `請幫我把以下每個項目歸類到這幾個分類之一：${
    CATEGORIES.join("、")
  }。\n` +
    `只能使用清單裡列出的分類名稱，不要自己發明新的分類。\n` +
    `請用「項目名稱,分類」的格式回覆，每行一組，不要加編號、不要多餘的說明文字。\n\n` +
    names.join("\n");
}

// runs right after an import finishes — pulls out just the item/vendor
// names from THIS batch that are still sitting in "其他" (i.e. genuinely
// need help, same criteria as getUnclassifiedNames), and if there are any,
// auto-expands the AI-assist panel with the list already filled in instead
// of making the person separately click "取得待分類清單" afterward. Returns
// a toast-message fragment to append to the import's own toast; empty
// string when nothing needs classifying (so the import toast stays
// unchanged in the common case).
function offerAiClassifyForNewEntries(newIds) {
  const names = new Set();
  newIds.forEach((id) => {
    const e = entries.find((x) => x.id === id);
    if (!e || isCategoryReviewed(e) || e.category !== "其他") return;
    const name = classifyLookupText(e).trim();
    if (name) names.add(name);
  });
  if (names.size === 0) return "";

  if (!rulesExpanded) setRulesExpanded(true);
  document.getElementById("unclassifiedOutput").value = buildAiClassifyPrompt(
    [...names].sort(),
  );
  document.getElementById("aiResultInput").value = "";
  if (typeof rulesCardEl.scrollIntoView === "function") {
    rulesCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return `,${names.size} 個品項待分類(已列在下方「AI輔助分類」)`;
}

// Parse from the RIGHT-HAND category instead of splitting on the first
// punctuation mark. Real invoice item names frequently contain commas and
// colons (product variants, capacities, meal options...), so the separator
// is only valid when what follows it is one of our exact category names.
// Markdown bullets and a trailing backslash (often emitted as a forced line
// break) are tolerated, but unknown categories are still rejected.
function parseAiClassifyResult(text) {
  const pairs = [];
  const escapedCategories = CATEGORIES
    .map((category) => category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const pairPattern = new RegExp(
    `^(.*)(?:[,，:：→]|->|=>)\\s*(${escapedCategories})\\s*$`,
  );
  text.split("\n").forEach((line) => {
    line = line.trim().replace(/\\+$/, "").trim();
    if (!line || /^`{3}/.test(line) || /^-{3,}$/.test(line)) return;
    line = line.replace(/^(?:[-*•]\s+|\d+[.)、]\s+)/, "");
    const m = line.match(pairPattern);
    if (!m) return;
    const name = m[1].trim();
    const cat = m[2].trim();
    if (name && CATEGORIES.includes(cat)) {
      pairs.push({ keyword: name, category: cat });
    }
  });
  return pairs;
}

async function applyAiClassifyResult(text) {
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }
  const pairs = parseAiClassifyResult(text);
  if (pairs.length === 0) {
    showToast(
      "沒有解析到有效的「品項,分類」配對,請確認格式,以及分類名稱是否是這幾個之一:" +
        CATEGORIES.join("、"),
    );
    return;
  }

  //直接套用到目前符合名稱的紀錄，不寫入任何規則清單——品項名稱重複出
  // 現的機率很低（尤其是發票品項，幾乎每筆都不一樣），存成規則只會讓規
  // 則清單越塞越多、卻很少真的再命中，不如每次都直接問 AI。
  const result = applyAiClassificationPairs(pairs);
  await saveEntries();
  render();

  document.getElementById("aiResultInput").value = "";
  document.getElementById("unclassifiedOutput").value = "";
  if (result.applied === 0) {
    showToast("沒有紀錄被更新(可能品項名稱對不上,或都已手動確認過分類)");
  } else {
    showToast(`已套用到 ${result.applied} 筆紀錄`);
  }
}

function applyAiClassificationPairs(pairs) {
  const nameToCategory = new Map(pairs.map((p) => [p.keyword, p.category]));
  let applied = 0;
  let changed = 0;
  entries.forEach((e) => {
    if (e.categoryManual) return;
    const key = classifyLookupText(e).trim();
    if (!nameToCategory.has(key)) return;
    const newCat = nameToCategory.get(key);
    if (newCat !== e.category) {
      e.category = newCat;
      changed++;
    }
    e.categoryReviewed = true;
    applied++;
  });
  return { applied, changed };
}

// strip common statement-line noise (bank prefixes like "連支*", "A- ", "MA-",
// legal-entity suffixes like "股份有限公司") so we're comparing the actual
// store name, not boilerplate that would never match between two documents
function normalizeVendorName(s) {
  return (s || "")
    .replace(/^(連支\*|連加\*|MA-\s?|MF-\s?|A-\s?|FP-\s?|91APP-)/, "")
    .replace(
      /(股份有限公司|有限公司|企業社|商行|分公司|分店|門市部|門市|自助站|自助加油|站)/g,
      "",
    )
    .replace(/[\s\-－*_（）()０-９0-9]/g, "")
    .trim();
}

// true if the two names share a meaningful chunk of text (2+ characters),
// used as a sanity check before suggesting an amount/date-based match —
// without this, any two transactions with a similar amount on a similar day
// get suggested regardless of whether they're even the same store
// common district/street names that show up inside lots of unrelated branch
// addresses — without excluding these, "50嵐-竹北十興" and "全家-竹北自強"
// would look like a name match just because both mention 竹北
const LOCATION_STOPWORDS = [
  "竹北",
  "新竹",
  "光明",
  "忠孝",
  "嘉興",
  "自強",
  "中正",
  "國民",
  "莊敬",
  "板橋",
  "桃園",
  "東門",
  "西門",
  "南門",
  "北門",
  "十興",
  "光復",
  "中山",
  "民權",
];

function hasNameOverlap(a, b) {
  const na = normalizeVendorName(a), nb = normalizeVendorName(b);
  if (na.length < 2 || nb.length < 2) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    if (LOCATION_STOPWORDS.includes(bg)) continue;
    if (nb.includes(bg)) return true;
  }
  return false;
}

function reconcile() {
  const maxWindow = 6 * 24 * 3600 * 1000;

  function wasSuggestionRejected(cc, invoiceNo) {
    return Array.isArray(cc.rejectedInvoiceNos) &&
      cc.rejectedInvoiceNos.includes(invoiceNo);
  }

  function buildInvoiceGroups() {
    const groups = {};
    entries.filter((e) => e.source === "invoice" && !e.matchedId && e.invoiceNo)
      .forEach((e) => {
        if (!groups[e.invoiceNo]) {
          groups[e.invoiceNo] = {
            reconciliationSum: 0,
            ts: e.ts,
            vendor: e.vendor,
            items: [],
          };
        }
        groups[e.invoiceNo].reconciliationSum += reconciliationAmount(e);
        groups[e.invoiceNo].ts = Math.max(groups[e.invoiceNo].ts, e.ts);
        groups[e.invoiceNo].items.push(e);
      });
    return groups;
  }

  // phase 1: exact amount match, auto-confirmed (invisible to the user —
  // so the bar here has to be high). Requires BOTH an exact amount match
  // AND vendor-name overlap; amount alone is too weak a signal to trust
  // silently. Two real cases that slipped through when this only required
  // amount+date: (a) two unrelated purchases sharing the exact same amount
  // (a $60 drink charge auto-merged into a $60 supermarket receipt from a
  // different store, while the correct same-store $60 charge sat unmatched
  // because its invoice had already been "claimed" by the wrong one), and
  // (b) a pure coincidence with no competing candidate at all (an
  // ANTHROPIC subscription's $48 foreign-transaction fee auto-merged into a
  // $48 McDonald's receipt purely because no other $48 charge existed
  // nearby — nothing about the two had any real connection). Requiring
  // vendor overlap catches both: case (a) resolves correctly because only
  // the genuine match has overlap; case (b) no longer auto-merges at all,
  // and falls through to phase 2 as a suggestion needing a human glance.
  let invoiceGroups = buildInvoiceGroups();
  let ccs = entries.filter((e) => e.source === "creditcard" && !e.matchedId);
  const exactCandidates = [];
  ccs.forEach((cc) => {
    Object.keys(invoiceGroups).forEach((no) => {
      const g = invoiceGroups[no];
      if (Math.abs(g.reconciliationSum - cc.amount) >= 0.01) return;
      const dateDiff = Math.abs(g.ts - cc.ts);
      if (dateDiff > maxWindow) return;
      if (!namesMatch(cc.vendor || cc.note, g.vendor)) return;
      exactCandidates.push({ cc, no, dateDiff });
    });
  });
  exactCandidates.sort((a, b) => a.dateDiff - b.dateDiff);
  let matched = 0;
  const usedCCExact = new Set(), usedInvoiceExact = new Set();
  exactCandidates.forEach((c) => {
    if (usedCCExact.has(c.cc.id) || usedInvoiceExact.has(c.no)) return;
    invoiceGroups[c.no].items.forEach((item) => item.matchedId = c.cc.id);
    c.cc.matchedId = c.no;
    c.cc.reviewed = true;
    c.cc.suggestedInvoiceNo = null;
    usedCCExact.add(c.cc.id);
    usedInvoiceExact.add(c.no);
    matched++;
  });

  // phase 2: suggested matches — shown to the user with a merge/reject
  // choice, never auto-applied. Covers two situations left over from phase 1:
  //  (a) cc charged LESS than the invoice total (e.g. wallet points/coupon
  //      covered the difference) — still requires vendor-name overlap, since
  //      without it this produced nonsense pairings (a supermarket suggested
  //      against a museum ticket, purely because the amount+date lined up).
  //  (b) cc amount matches the invoice EXACTLY but didn't qualify for phase 1
  //      because the vendor names didn't overlap — could be legitimate (the
  //      invoice uses the store's registered company name, not its
  //      storefront brand — e.g. a "coco" drink stand invoiced under a
  //      generic company name) or could be pure coincidence (see the phase 1
  //      comment above), so it's surfaced for a person to judge either way.
  // Each invoice is only suggested to ONE cc entry (the best-fitting one),
  // so it doesn't get dangled in front of several unrelated card lines.
  invoiceGroups = buildInvoiceGroups();
  ccs = entries.filter((e) => e.source === "creditcard" && !e.matchedId);
  const candidates = [];
  ccs.forEach((cc) => {
    Object.keys(invoiceGroups).forEach((no) => {
      const g = invoiceGroups[no];
      if (wasSuggestionRejected(cc, no)) return;
      const dateDiff = Math.abs(g.ts - cc.ts);
      if (dateDiff > maxWindow) return;
      const gap = g.reconciliationSum - cc.amount;
      if (Math.abs(gap) < 0.01) {
        candidates.push({ cc, no, dateDiff, gap: 0 });
        return;
      }
      if (
        gap > 0 && gap <= g.reconciliationSum * 0.5 && gap <= 500 &&
        namesMatch(cc.vendor || cc.note, g.vendor)
      ) {
        candidates.push({ cc, no, dateDiff, gap });
      }
    });
  });
  candidates.sort((a, b) => a.dateDiff - b.dateDiff || a.gap - b.gap);
  const usedCC = new Set(), usedInvoice = new Set();
  candidates.forEach((c) => {
    if (usedCC.has(c.cc.id) || usedInvoice.has(c.no)) return;
    c.cc.suggestedInvoiceNo = c.no;
    // A newly-available suggestion needs a decision even if this card was
    // automatically reviewed earlier, before its invoice had been imported.
    c.cc.reviewed = false;
    usedCC.add(c.cc.id);
    usedInvoice.add(c.no);
  });
  ccs.forEach((cc) => {
    if (!usedCC.has(cc.id)) cc.suggestedInvoiceNo = null;
  });

  return matched;
}

// Imported card rows with complete core fields and no reconciliation question
// are safe to accept without making the person confirm every ordinary charge.
// This does not merge anything: suggested matches, missing vendors, and missing
// bank labels remain pending for a human decision.
function autoReviewHighConfidenceCreditCards(entryIds) {
  const ids = entryIds ? new Set(entryIds) : null;
  let reviewed = 0;
  entries.forEach((e) => {
    if (ids && !ids.has(e.id)) return;
    if (
      e.source !== "creditcard" || e.matchedId || e.suggestedInvoiceNo ||
      e.reviewed
    ) return;
    if (!Number.isFinite(e.amount) || e.amount === 0) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) return;
    if (!(e.vendor || "").trim() || !(e.bank || "").trim()) return;
    e.reviewed = true;
    reviewed++;
  });
  return reviewed;
}

// generic single-row-per-transaction importer (used for credit card statements,
// and as a fallback for invoice CSVs that aren't the official gov item-level format)
// defaultBank is used when the CSV itself has no bank/card column (e.g. the
// person typed a bank name into the input field before importing)
function genericImportRows(rows, source, defaultBank) {
  const { dateIdx, amountIdx, vendorIdx, bankIdx } = detectColumns(rows[0]);
  if (dateIdx === -1 || amountIdx === -1) {
    return {
      added: 0,
      skipped: 0,
      unparseable: 0,
      skippedExamples: [],
      unrecognized: true,
    };
  }
  let added = 0, skipped = 0, unparseable = 0;
  const skippedExamples = [];

  // duplicate detection is multiset-based, not "does any match exist at
  // all": count how many transaction identities already exist in
  // the ledger before this file is processed, then only treat that many
  // *matching* incoming rows as duplicates. Two genuinely separate same-day,
  // same-amount, same-store purchases in one CSV (e.g. two identical coffees
  // bought hours apart) both get added — a plain "does this exact
  // combination exist anywhere already" check would silently collapse the
  // second real purchase into "duplicate" and lose it. This can't be a
  // perfect fix (the source data has no unique transaction id to key off
  // of), but it fixes the specific failure mode of legitimate repeats
  // getting eaten, at the cost of being slightly more permissive about
  // true re-imports beyond what already exists.
  const existingCounts = {};
  entries.forEach((e) => {
    if (e.source !== source) return;
    const key = importDuplicateKey(
      e.source,
      e.date,
      e.amount,
      e.vendor,
      e.bank,
    );
    existingCounts[key] = (existingCounts[key] || 0) + 1;
  });

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[amountIdx]) continue;
    const amount = parseFloat(String(r[amountIdx]).replace(/[^0-9.\-]/g, ""));
    // amount can be negative (a discount/refund line on the statement) — still
    // counted so the total nets out correctly, same policy as invoice imports.
    // Only skip if it's not a real number or exactly zero.
    if (!amount || isNaN(amount)) continue;
    const dateObj = parseDateFlexible(r[dateIdx]);
    if (!dateObj) {
      unparseable++;
      continue;
    }
    const dateKey = toKey(dateObj);
    const vendor = vendorIdx !== -1 ? (r[vendorIdx] || "").trim() : "";
    const bank = bankIdx !== -1
      ? (r[bankIdx] || "").trim()
      : (defaultBank || "");

    const key = importDuplicateKey(source, dateKey, amount, vendor, bank);
    if (existingCounts[key] > 0) {
      existingCounts[key]--;
      skipped++;
      if (skippedExamples.length < 3) {
        skippedExamples.push(
          `${dateKey.slice(5)} ${fmt(amount)}${vendor ? " " + vendor : ""}`,
        );
      }
      continue;
    }

    entries.push({
      id: "e" + Date.now() + Math.random().toString(36).slice(2, 7) + i,
      amount,
      originalAmount: amount,
      category: guessCategory(vendor),
      note: "",
      originalNote: "",
      date: dateKey,
      ts: dateObj.getTime(),
      source,
      vendor,
      originalVendor: vendor,
      bank,
      originalBank: bank,
      matchedId: null,
      reviewed: source === "invoice",
      categoryReviewed: false,
    });
    added++;
  }
  return { added, skipped, unparseable, skippedExamples, unrecognized: false };
}

function importDuplicateKey(source, date, amount, vendor, bank) {
  const parts = [date, Number(amount).toFixed(2), (vendor || "").trim()];
  // The same store/date/amount can legitimately appear on two cards. Keep
  // invoice fallback behavior unchanged, but scope card duplicates to the
  // normalized bank/card label whenever it is available.
  if (source === "creditcard") {
    parts.push((bank || "").trim().toLocaleLowerCase("zh-Hant"));
  }
  return parts.join("␟");
}

// official 財政部「載具消費明細」CSV: one row per line-item, so the same 發票號碼
// repeats across several rows and each row's 消費明細_金額 is only that item's cost.
// We group by 發票號碼 and sum, so one invoice = one ledger entry.
function isGovInvoiceFormat(headers) {
  const need = ["發票日期", "發票號碼", "賣方名稱", "消費明細_金額"];
  return need.every((k) => headers.includes(k));
}

// 財政部電子發票平台匯出的「消費明細_品名」有時本身含有逗號(例如商品規格,
// 「POLYWELL ... + 編織線 PW15-T65-0640, Apple Watch, 白色, 1條」),但欄位沒有
// 用引號包起來,導致這一列被 naive CSV split 成比表頭還多欄。因為品名在這份官方
// 格式裡固定是最後一欄,遇到欄位數超出表頭長度時,把從品名欄位開始到列尾的所有
// 片段重新用逗號接回去,還原完整品名——否則會在第一個逗號處被截斷,雖然金額/
// 發票號碼等在品名之前的欄位不受影響、不會算錯,但畫面上顯示的品名會不完整。
function extractGovItemName(row, itemIdx, headerLen) {
  if (itemIdx === -1) return "";
  if (itemIdx === headerLen - 1 && row.length > headerLen) {
    return row.slice(itemIdx).join(",").trim();
  }
  return (row[itemIdx] || "").trim();
}

function importGovInvoiceRows(rows) {
  const headers = rows[0].map((h) => (h || "").trim());
  const idx = {
    date: headers.indexOf("發票日期"),
    no: headers.indexOf("發票號碼"),
    vendor: headers.indexOf("賣方名稱"),
    amount: headers.indexOf("消費明細_金額"),
    item: headers.indexOf("消費明細_品名"),
    status: headers.indexOf("發票狀態"),
  };
  const invoiceMeta = {}; // invoiceNo -> {date, vendor}
  const itemsByInvoice = {}; // invoiceNo -> [{name, amount}]
  let voided = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (idx.status !== -1 && (r[idx.status] || "").includes("作廢")) {
      voided++;
      continue;
    }
    const no = r[idx.no];
    if (!no) continue;
    if (!invoiceMeta[no]) {
      invoiceMeta[no] = {
        date: r[idx.date],
        vendor: (r[idx.vendor] || "").trim(),
      };
    }
    const amt =
      parseFloat(String(r[idx.amount] || "0").replace(/[^0-9.\-]/g, "")) || 0;
    // negative amount = discount/折讓 line — still counted so the invoice total nets out correctly
    const itemName = idx.item !== -1
      ? extractGovItemName(r, idx.item, headers.length)
      : "";
    (itemsByInvoice[no] = itemsByInvoice[no] || []).push({
      name: itemName || "未命名品項",
      amount: amt,
    });
  }

  let added = 0, skippedInvoices = 0, unparseable = 0;
  for (const no in itemsByInvoice) {
    const meta = invoiceMeta[no];
    const dateObj = parseDateFlexible(meta.date);
    if (!dateObj) {
      unparseable++;
      continue;
    }
    const dateKey = toKey(dateObj);
    // dedupe at invoice level: if this invoice number was already imported before, skip the whole thing
    const alreadyImported = entries.some((e) =>
      e.source === "invoice" && e.invoiceNo === no
    );
    if (alreadyImported) {
      skippedInvoices++;
      continue;
    }
    itemsByInvoice[no].forEach((item, itemIdx) => {
      entries.push({
        id: "e" + Date.now() + Math.random().toString(36).slice(2, 7) + no +
          itemIdx,
        amount: item.amount,
        originalAmount: item.amount,
        category: guessCategoryForItem(item.name, meta.vendor),
        note: item.name,
        originalNote: item.name,
        date: dateKey,
        ts: dateObj.getTime(),
        source: "invoice",
        vendor: meta.vendor,
        originalVendor: meta.vendor,
        bank: "",
        originalBank: "",
        invoiceNo: no,
        matchedId: null,
        reviewed: true,
        categoryReviewed: false,
      });
      added++;
    });
  }
  return { added, skipped: skippedInvoices, voided, unparseable };
}

// parses one invoice CSV file into entries (no save/reconcile/render/toast —
// that happens once per batch, not once per file, see importInvoiceCSV below)
async function importOneInvoiceFile(file) {
  const text = await file.text();
  const rows = parseCSV(text).filter((r) =>
    r.some((c) => (c || "").trim() !== "")
  );
  if (rows.length < 2) {
    return {
      added: 0,
      skipped: 0,
      voided: 0,
      unrecognized: false,
      empty: true,
    };
  }
  const headers = rows[0].map((h) => (h || "").trim());
  if (isGovInvoiceFormat(headers)) {
    return importGovInvoiceRows(rows);
  }
  return genericImportRows(rows, "invoice");
}

// accepts a single File, a FileList, or an array of Files — lets both the
// existing single-file call sites and the new multi-select input share one
// code path. Files/FileLists have a numeric .length; a lone File does not.
async function importInvoiceCSV(fileOrFiles) {
  const files = fileOrFiles
    ? (fileOrFiles.length !== undefined
      ? Array.from(fileOrFiles)
      : [fileOrFiles])
    : [];
  if (files.length === 0) return;
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }

  const idsBefore = new Set(entries.map((e) => e.id));
  const linkSnapshot = snapshotLinkState();
  const totals = { added: 0, skipped: 0, voided: 0, unparseable: 0 };
  const emptyFiles = [];
  const unrecognizedFiles = [];
  const skippedExamples = [];
  for (const file of files) {
    const r = await importOneInvoiceFile(file);
    if (r.unrecognized) {
      unrecognizedFiles.push(file.name);
      continue;
    }
    if (r.empty) {
      emptyFiles.push(file.name);
      continue;
    }
    totals.added += r.added || 0;
    totals.skipped += r.skipped || 0;
    totals.voided += r.voided || 0;
    totals.unparseable += r.unparseable || 0;
    if (r.skippedExamples) skippedExamples.push(...r.skippedExamples);
  }

  const newIds = entries.filter((e) => !idsBefore.has(e.id)).map((e) => e.id);
  await saveEntries();
  const matched = reconcile();
  await saveEntries();
  render();

  const historyClassified = applyHistoryClassificationToIds(newIds);
  if (historyClassified) await saveEntries();

  const parts = [`匯入 ${totals.added} 筆品項`];
  if (files.length > 1) parts.push(`(共 ${files.length} 個檔案)`);
  if (totals.skipped) {
    parts.push(
      `,略過重複發票 ${totals.skipped} 張` +
        (skippedExamples.length
          ? `(例:${skippedExamples.slice(0, 3).join("、")})`
          : ""),
    );
  }
  if (totals.voided) parts.push(`,略過作廢 ${totals.voided} 筆`);
  if (totals.unparseable) {
    parts.push(`,${totals.unparseable} 筆日期格式看不懂被跳過`);
  }
  if (matched) parts.push(`,自動比對信用卡 ${matched} 張`);
  if (unrecognizedFiles.length) {
    parts.push(`;無法辨識欄位:${unrecognizedFiles.join("、")}`);
  }
  if (emptyFiles.length) parts.push(`;內容是空的:${emptyFiles.join("、")}`);
  if (historyClassified) parts.push(`,依歷史自動分類 ${historyClassified} 筆`);
  parts.push(offerAiClassifyForNewEntries(newIds));
  if (newIds.length) {
    createImportBatch("invoice", files, newIds, linkSnapshot, parts.join(""));
    await saveImportBatches();
    await saveEntries();
    render();
  }
  showToast(parts.join(""));
}

// this user's credit-card CSVs are consistently converted from bank
// e-statement PDFs and named "{銀行}信用卡帳單_YYYYMM.csv" (e.g.
// "永豐信用卡帳單_202606.csv") — the bank name the CSV itself lacks a column
// for is sitting right there in the filename. Used only when the person
// left the bank input blank and the CSV has no bank column of its own.
function guessBankFromFilename(filename) {
  if (!filename) return "";
  const m = filename.match(/^([\u4e00-\u9fa5A-Za-z]{2,6}?)(信用卡|卡)/);
  return m ? m[1] : "";
}

// parses one credit-card CSV file (no save/reconcile/render/toast — batched
// once per import call, see importCreditCardCSV below). Bank resolution
// order per file: explicit input box > this file's own filename > blank.
async function importOneCreditCardFile(file, bankLabel) {
  const text = await file.text();
  const rows = parseCSV(text).filter((r) =>
    r.some((c) => (c || "").trim() !== "")
  );
  if (rows.length < 2) {
    return { added: 0, skipped: 0, unrecognized: false, empty: true, bank: "" };
  }
  const guessedBank = bankLabel ? "" : guessBankFromFilename(file.name);
  const effectiveBank = bankLabel || guessedBank;
  const result = genericImportRows(rows, "creditcard", effectiveBank);
  return Object.assign(result, { bank: effectiveBank, guessed: !!guessedBank });
}

// accepts a single File, a FileList, or an array of Files, same as
// importInvoiceCSV — lets one call cover both single- and multi-select.
async function importCreditCardCSV(fileOrFiles, bankLabel) {
  const files = fileOrFiles
    ? (fileOrFiles.length !== undefined
      ? Array.from(fileOrFiles)
      : [fileOrFiles])
    : [];
  if (files.length === 0) return;
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }

  const idsBefore = new Set(entries.map((e) => e.id));
  const linkSnapshot = snapshotLinkState();
  const totals = { added: 0, skipped: 0, unparseable: 0 };
  const emptyFiles = [];
  const unrecognizedFiles = [];
  const skippedExamples = [];
  const banksUsed = new Set();
  let anyGuessed = false;
  for (const file of files) {
    const r = await importOneCreditCardFile(file, bankLabel);
    if (r.unrecognized) {
      unrecognizedFiles.push(file.name);
      continue;
    }
    if (r.empty) {
      emptyFiles.push(file.name);
      continue;
    }
    totals.added += r.added || 0;
    totals.skipped += r.skipped || 0;
    totals.unparseable += r.unparseable || 0;
    if (r.skippedExamples) skippedExamples.push(...r.skippedExamples);
    if (r.bank) banksUsed.add(r.bank);
    if (r.guessed) anyGuessed = true;
  }

  const newIds = entries.filter((e) => !idsBefore.has(e.id)).map((e) => e.id);
  await saveEntries();
  const matched = reconcile();
  const autoReviewed = autoReviewHighConfidenceCreditCards(newIds);
  await saveEntries();
  render();

  const historyClassified = applyHistoryClassificationToIds(newIds);
  if (historyClassified) await saveEntries();

  const bankSummary = banksUsed.size ? [...banksUsed].join("、") : "";
  const parts = [
    `匯入 ${totals.added} 筆${
      bankSummary ? bankSummary + "信用卡" : "信用卡"
    }消費`,
  ];
  if (files.length > 1) parts.push(`(共 ${files.length} 個檔案)`);
  if (anyGuessed) parts.push(`(部分銀行從檔名判斷,如有誤可點標籤修改)`);
  if (totals.skipped) {
    parts.push(
      `,略過重複 ${totals.skipped} 筆` +
        (skippedExamples.length
          ? `(例:${skippedExamples.slice(0, 3).join("、")})`
          : ""),
    );
  }
  if (totals.unparseable) {
    parts.push(`,${totals.unparseable} 筆日期格式看不懂被跳過`);
  }
  if (matched) parts.push(`,自動比對發票 ${matched} 筆`);
  if (autoReviewed) {
    parts.push(`,自動確認 ${autoReviewed} 筆資料完整且無配對疑慮的消費`);
  }
  if (unrecognizedFiles.length) {
    parts.push(`;無法辨識欄位:${unrecognizedFiles.join("、")}`);
  }
  if (emptyFiles.length) parts.push(`;內容是空的:${emptyFiles.join("、")}`);
  if (historyClassified) parts.push(`,依歷史自動分類 ${historyClassified} 筆`);
  parts.push(offerAiClassifyForNewEntries(newIds));
  if (newIds.length) {
    createImportBatch(
      "creditcard",
      files,
      newIds,
      linkSnapshot,
      parts.join(""),
    );
    await saveImportBatches();
    await saveEntries();
    render();
  }
  showToast(parts.join(""));
}

// Runs the exact same parsers and reconciliation rules as a real import, but
// against a disposable in-memory clone. Nothing is saved and the original
// `entries` array (including all object references used by the rendered UI)
// is restored before this promise resolves. The selected File objects are
// retained by the UI and parsed again only after explicit confirmation.
async function prepareImportPreview(type, fileOrFiles, bankLabel) {
  const files = fileOrFiles
    ? (fileOrFiles.length !== undefined
      ? Array.from(fileOrFiles)
      : [fileOrFiles])
    : [];
  if (files.length === 0) return null;
  if (type !== "invoice" && type !== "creditcard") {
    throw new Error("Unsupported import type");
  }

  const originalEntries = entries;
  entries = JSON.parse(JSON.stringify(entries));
  try {
    const idsBefore = new Set(entries.map((e) => e.id));
    const totals = { added: 0, skipped: 0, voided: 0, unparseable: 0 };
    const emptyFiles = [];
    const unrecognizedFiles = [];
    const skippedExamples = [];
    const banksUsed = new Set();
    let anyGuessed = false;

    for (const file of files) {
      const result = type === "invoice"
        ? await importOneInvoiceFile(file)
        : await importOneCreditCardFile(file, bankLabel || "");
      if (result.unrecognized) {
        unrecognizedFiles.push(file.name);
        continue;
      }
      if (result.empty) {
        emptyFiles.push(file.name);
        continue;
      }
      totals.added += result.added || 0;
      totals.skipped += result.skipped || 0;
      totals.voided += result.voided || 0;
      totals.unparseable += result.unparseable || 0;
      if (result.skippedExamples) {
        skippedExamples.push(...result.skippedExamples);
      }
      if (result.bank) banksUsed.add(result.bank);
      if (result.guessed) anyGuessed = true;
    }

    const newEntries = entries.filter((e) => !idsBefore.has(e.id));
    const newIds = newEntries.map((e) => e.id);
    const matched = reconcile();
    const autoReviewed = type === "creditcard"
      ? autoReviewHighConfidenceCreditCards(newIds)
      : 0;
    const historyClassified = applyHistoryClassificationToIds(newIds);
    const pending = newEntries.filter((e) =>
      e.source === "creditcard" && !e.matchedId && !e.reviewed
    ).length;
    const unclassified = newEntries.filter((e) =>
      !isCategoryReviewed(e) && e.category === "其他" &&
      classifyLookupText(e).trim()
    ).length;
    const needsReview = newEntries.filter((e) =>
      (e.source === "creditcard" && !e.matchedId && !e.reviewed) ||
      (!isCategoryReviewed(e) && e.category === "其他" &&
        classifyLookupText(e).trim())
    ).length;
    const dates = newEntries.map((e) =>
      e.date
    ).filter(Boolean).sort();

    return {
      type,
      files: files.map((file) =>
        file.name
      ),
      fileCount: files.length,
      totals,
      matched,
      autoReviewed,
      historyClassified,
      pending,
      unclassified,
      needsReview,
      amountTotal: newEntries.reduce((sum, e) => sum + e.amount, 0),
      dateFrom: dates[0] || "",
      dateTo: dates[dates.length - 1] || "",
      banks: [...banksUsed],
      anyGuessed,
      emptyFiles,
      unrecognizedFiles,
      skippedExamples: skippedExamples.slice(0, 3),
    };
  } finally {
    entries = originalEntries;
  }
}
