const PROJECT_ROOT = new URL("../", import.meta.url);
const INDEX_URL = new URL("index.html", PROJECT_ROOT);
const INVOICE_FIXTURES_URL = new URL(
  "test-fixtures/private/invoices/",
  PROJECT_ROOT,
);
const CREDIT_CARD_FIXTURES_URL = new URL(
  "test-fixtures/private/credit-card/",
  PROJECT_ROOT,
);
const OUTPUT_URL = new URL(
  "test-fixtures/private/reconciliation-review.html",
  PROJECT_ROOT,
);
const REVIEW_DATA_URL = new URL(
  "test-fixtures/private/reconciliation-review-data.json",
  PROJECT_ROOT,
);
const SELECTION_URL = new URL(
  "test-fixtures/private/reconciliation-review-selection.json",
  PROJECT_ROOT,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listCsvFiles(directoryUrl) {
  const files = [];
  for await (const entry of Deno.readDir(directoryUrl)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(".csv")) {
      files.push({ name: entry.name, url: new URL(entry.name, directoryUrl) });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

function makeFakeElement() {
  const attributes = new Map();
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    appendChild() {},
    removeChild() {},
    replaceWith() {},
    focus() {},
    select() {},
    click() {},
    scrollIntoView() {},
    querySelector() {
      return makeFakeElement();
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
  };
}

function makeFakeDocument() {
  const elements = new Map();
  return {
    body: makeFakeElement(),
    createElement() {
      return makeFakeElement();
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeFakeElement());
      return elements.get(id);
    },
  };
}

async function loadLedgerApp() {
  const html = await Deno.readTextFile(INDEX_URL);
  const scriptPaths = [...html.matchAll(/<script src="([^"]+)"\s*><\/script>/g)]
    .map((match) => match[1]);
  assert(scriptPaths.length > 0, "index.html 裡找不到應用程式 JavaScript");
  let source = (
    await Promise.all(
      scriptPaths.map((path) => Deno.readTextFile(new URL(path, INDEX_URL))),
    )
  ).join("\n");
  const initStart = source.indexOf("(async function init(){");
  const initEnd = source.indexOf("})();", initStart);
  assert(initStart !== -1 && initEnd !== -1, "index.html 初始化區塊格式已改變");
  source = source.slice(0, initStart) + source.slice(initEnd + 5);
  source += `
    return {
      reset(){ entries=[]; vendorAliases=[]; importBatches=[]; knownMonthKeys=new Set(); },
      getEntries(){ return entries; },
      importOneInvoiceFile,
      importOneCreditCardFile,
      reconcile
    };
  `;
  const storage = {
    get() {
      return null;
    },
    set() {},
    delete() {},
    list() {
      return { keys: [] };
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const factory = new AsyncFunction("window", "document", "navigator", source);
  return await factory(
    { storage },
    makeFakeDocument(),
    { clipboard: { writeText() {} } },
  );
}

function fixtureFile(fixture) {
  return { name: fixture.name, text: () => Deno.readTextFile(fixture.url) };
}

async function hashText(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function buildReviewData() {
  const invoiceFixtures = await listCsvFiles(INVOICE_FIXTURES_URL);
  const creditCardFixtures = await listCsvFiles(CREDIT_CARD_FIXTURES_URL);
  assert(invoiceFixtures.length > 0, "找不到發票 CSV");
  assert(creditCardFixtures.length > 0, "找不到信用卡 CSV");

  const app = await loadLedgerApp();
  app.reset();
  for (const fixture of invoiceFixtures) {
    await app.importOneInvoiceFile(fixtureFile(fixture));
  }
  for (const fixture of creditCardFixtures) {
    await app.importOneCreditCardFile(fixtureFile(fixture), "");
  }
  app.reconcile();

  const entries = app.getEntries();
  const invoiceGroups = new Map();
  entries.filter((entry) => entry.source === "invoice" && entry.invoiceNo)
    .forEach((entry) => {
      if (!invoiceGroups.has(entry.invoiceNo)) {
        invoiceGroups.set(entry.invoiceNo, []);
      }
      invoiceGroups.get(entry.invoiceNo).push(entry);
    });

  const occurrenceCounts = new Map();
  const pairs = [];
  for (const entry of entries.filter((item) => item.source === "creditcard")) {
    const invoiceNo = entry.matchedId || entry.suggestedInvoiceNo;
    if (!invoiceNo) continue;
    const items = invoiceGroups.get(invoiceNo);
    if (!items || items.length === 0) continue;

    const signature = [
      entry.bank || "",
      entry.date,
      Number(entry.amount).toFixed(2),
      entry.vendor || "",
    ].join("␟");
    const occurrence = (occurrenceCounts.get(signature) || 0) + 1;
    occurrenceCounts.set(signature, occurrence);
    const stableCreditCardKey = signature + "␟" + occurrence;
    const pairId = await hashText(stableCreditCardKey + "␟" + invoiceNo);
    const invoiceTotal = items.reduce((sum, item) => sum + item.amount, 0);
    const invoiceTs = Math.max(...items.map((item) => item.ts));
    pairs.push({
      id: pairId,
      type: entry.matchedId ? "automatic" : "suggested",
      creditCard: {
        date: entry.date,
        amount: entry.amount,
        vendor: entry.vendor || entry.note || "",
        bank: entry.bank || "",
        occurrence,
      },
      invoice: {
        date: items[0].date,
        amount: invoiceTotal,
        vendor: items[0].vendor || "",
        invoiceNo,
        items: items.map((item) => ({
          name: item.note || "未命名品項",
          amount: item.amount,
        })),
      },
      amountDifference: invoiceTotal - entry.amount,
      dateDifferenceDays: Math.round(
        Math.abs(invoiceTs - entry.ts) / (24 * 60 * 60 * 1000),
      ),
    });
  }

  pairs.sort((a, b) => {
    if (a.type !== b.type) return a.type === "automatic" ? -1 : 1;
    return b.creditCard.date.localeCompare(a.creditCard.date) ||
      a.creditCard.vendor.localeCompare(b.creditCard.vendor, "zh-Hant");
  });
  return {
    format: "expense-ledger-reconciliation-review",
    version: 1,
    generatedAt: new Date().toISOString(),
    fixtureCounts: {
      invoices: invoiceFixtures.length,
      creditCards: creditCardFixtures.length,
    },
    pairCounts: {
      automatic: pairs.filter((pair) => pair.type === "automatic").length,
      suggested: pairs.filter((pair) => pair.type === "suggested").length,
    },
    pairs,
  };
}

async function applyPrivateReviewSelection(data) {
  let selection;
  try {
    selection = JSON.parse(await Deno.readTextFile(SELECTION_URL));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return data;
    throw error;
  }
  assert(
    selection?.format === "expense-ledger-reconciliation-review-selection" &&
      selection.version === 1,
    "精簡審核選擇檔格式不符",
  );
  const allPairIds = new Set(data.pairs.map((pair) => pair.id));
  const selectedIds = new Set(selection.needsUserReviewPairIds || []);
  const wrongIds = new Set(selection.wrongPairIds || []);
  const resolvedIds = new Set(selection.resolvedUserReviewPairIds || []);
  for (const id of [...selectedIds, ...resolvedIds]) {
    assert(allPairIds.has(id), `精簡審核選擇檔包含不存在的 pairId: ${id}`);
  }
  const originalPairCounts = data.pairCounts;
  const pairs = data.pairs.filter((pair) => selectedIds.has(pair.id));
  return {
    ...data,
    originalPairCounts,
    pairCounts: {
      automatic: pairs.filter((pair) => pair.type === "automatic").length,
      suggested: pairs.filter((pair) => pair.type === "suggested").length,
    },
    selectionSummary: {
      assistantMarkedWrong: wrongIds.size,
      resolvedByUser: resolvedIds.size,
      needsUserReview: pairs.length,
    },
    pairs,
  };
}

function buildHtml(data) {
  const safeData = JSON.stringify(data).replace(/</g, "\\u003c").replace(
    /\u2028/g,
    "\\u2028",
  ).replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'">
<title>對帳配對審核</title>
<style>
:root{--paper:#f4efe5;--card:#fffaf0;--ink:#2b2924;--muted:#756e60;--line:#d3c9b6;--red:#a9362d;--green:#3f6b4c;--amber:#9b681e;--blue:#315f78}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}.app{max-width:860px;margin:auto;padding:24px 16px 80px}h1{font-size:24px;margin:0 0 6px}.privacy{font-size:12px;color:var(--muted);margin-bottom:18px}.toolbar,.progress-card,.review-card{background:var(--card);border:1px solid var(--line);border-radius:14px}.toolbar{display:flex;flex-wrap:wrap;gap:10px;padding:12px;margin-bottom:12px}.toolbar select,.toolbar button,.jump input{font:inherit;border:1px solid var(--line);background:white;border-radius:8px;padding:8px 10px}.toolbar button{cursor:pointer}.toolbar .spacer{flex:1}.progress-card{padding:14px 16px;margin-bottom:14px}.progress-row{display:flex;justify-content:space-between;gap:12px;font-weight:700}.track{height:8px;background:#e5ddcf;border-radius:5px;margin-top:10px;overflow:hidden}.fill{height:100%;background:var(--green);width:0}.review-card{padding:18px}.type{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;margin-bottom:14px}.type.automatic{background:#dcebe0;color:var(--green)}.type.suggested{background:#f1e3c8;color:var(--amber)}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.side{border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}.side h2{font-size:13px;color:var(--muted);margin:0 0 10px}.vendor{font-size:18px;font-weight:750;overflow-wrap:anywhere}.meta{display:flex;justify-content:space-between;gap:10px;margin-top:12px}.amount{font-size:24px;font-weight:800}.bank,.invoice-no{font-size:12px;color:var(--muted);margin-top:5px}.difference{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.difference span{background:#eee6d8;border-radius:7px;padding:6px 9px;font-size:13px}.items{margin-top:12px;border-top:1px dashed var(--line);padding-top:8px;max-height:180px;overflow:auto}.item{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px}.item-name{overflow-wrap:anywhere}.decisions{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}.decision{border:2px solid transparent;border-radius:10px;padding:12px;font-size:16px;font-weight:750;cursor:pointer}.decision.correct{background:#e0eee3;color:var(--green)}.decision.wrong{background:#f2deda;color:var(--red)}.decision.unsure{background:#efe6d4;color:var(--amber)}.decision.active{border-color:currentColor}.note{width:100%;min-height:60px;margin-top:12px;border:1px solid var(--line);border-radius:9px;padding:9px;font:inherit;background:white}.navigation{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:14px}.navigation button{border:1px solid var(--line);background:white;border-radius:9px;padding:9px 14px;font:inherit;cursor:pointer}.navigation button:disabled{opacity:.4}.jump{font-size:13px;color:var(--muted)}.jump input{width:75px}.empty{text-align:center;padding:50px 10px;color:var(--muted)}.status{font-size:12px;color:var(--muted);margin-top:10px}.hidden{display:none!important}@media(max-width:650px){.columns{grid-template-columns:1fr}.toolbar{align-items:stretch}.toolbar select,.toolbar button{flex:1}.decisions{grid-template-columns:1fr}.navigation{flex-wrap:wrap}.jump{order:3;width:100%;text-align:center}}
</style>
</head>
<body><main class="app">
<h1>信用卡 × 發票配對審核</h1>
<div class="privacy">完全離線頁面，不會傳送資料。判定會暫存在這個瀏覽器；請定期匯出 JSON 備份。</div>
<section class="toolbar">
  <select id="typeFilter" aria-label="配對類型"><option value="all">全部類型</option><option value="automatic">自動配對</option><option value="suggested">建議配對</option></select>
  <select id="decisionFilter" aria-label="審核狀態"><option value="all">全部狀態</option><option value="unreviewed">尚未審核</option><option value="correct">正確</option><option value="wrong">錯誤</option><option value="unsure">不確定</option></select>
  <span class="spacer"></span><button id="importBtn" type="button">匯入判定</button><button id="exportBtn" type="button">匯出判定 JSON</button><input id="importFile" class="hidden" type="file" accept=".json,application/json">
</section>
<section class="progress-card"><div class="progress-row"><span id="progressText"></span><span id="summaryText"></span></div><div class="track"><div class="fill" id="progressFill"></div></div></section>
<section class="review-card" id="reviewCard">
  <div id="typeBadge" class="type"></div>
  <div class="columns"><div class="side"><h2>💳 信用卡</h2><div class="vendor" id="ccVendor"></div><div class="meta"><span id="ccDate"></span><span class="amount" id="ccAmount"></span></div><div class="bank" id="ccBank"></div></div>
  <div class="side"><h2>🧾 發票</h2><div class="vendor" id="invoiceVendor"></div><div class="meta"><span id="invoiceDate"></span><span class="amount" id="invoiceAmount"></span></div><div class="invoice-no" id="invoiceNo"></div><div class="items" id="invoiceItems"></div></div></div>
  <div class="difference"><span id="amountDifference"></span><span id="dateDifference"></span></div>
  <div class="decisions"><button class="decision correct" data-decision="correct">✓ 正確 <small>(1)</small></button><button class="decision wrong" data-decision="wrong">✕ 錯誤 <small>(2)</small></button><button class="decision unsure" data-decision="unsure">? 不確定 <small>(3)</small></button></div>
  <textarea class="note" id="note" placeholder="備註（選填，會自動暫存）"></textarea>
  <div class="navigation"><button id="prevBtn" type="button">← 上一筆</button><label class="jump">第 <input id="jumpInput" type="number" min="1"> 筆／<span id="filteredCount"></span></label><button id="nextBtn" type="button">下一筆 →</button></div>
  <div class="status" id="saveStatus"></div>
</section><section class="review-card empty hidden" id="emptyState">目前篩選條件下沒有項目。</section>
</main>
<script>
'use strict';
const reviewData=${safeData};
const storageKey='expense-ledger-reconciliation-review-v1';
let decisions=loadDecisions();let filtered=[];let currentIndex=0;
const el=id=>document.getElementById(id);
function loadDecisions(){try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');return value&&typeof value==='object'?value:{}}catch(error){return {}}}
function saveDecisions(){localStorage.setItem(storageKey,JSON.stringify(decisions));el('saveStatus').textContent='已自動暫存於瀏覽器 · '+new Date().toLocaleTimeString('zh-TW')}
function money(value){const negative=value<0;return (negative?'-$':'$')+Math.abs(Math.round(value)).toLocaleString('zh-TW')}
function currentPair(){return filtered[currentIndex]||null}
function applyFilters(){const type=el('typeFilter').value;const decision=el('decisionFilter').value;const oldId=currentPair()&&currentPair().id;filtered=reviewData.pairs.filter(pair=>{if(type!=='all'&&pair.type!==type)return false;const value=decisions[pair.id]&&decisions[pair.id].decision;if(decision==='unreviewed')return !value;if(decision!=='all')return value===decision;return true});const oldIndex=filtered.findIndex(pair=>pair.id===oldId);currentIndex=oldIndex>=0?oldIndex:Math.min(currentIndex,Math.max(0,filtered.length-1));render()}
function setText(id,value){el(id).textContent=value}
function renderItems(items){const wrap=el('invoiceItems');wrap.textContent='';items.forEach(item=>{const row=document.createElement('div');row.className='item';const name=document.createElement('span');name.className='item-name';name.textContent=item.name;const amount=document.createElement('span');amount.textContent=money(item.amount);row.append(name,amount);wrap.appendChild(row)})}
function render(){const pair=currentPair();el('reviewCard').classList.toggle('hidden',!pair);el('emptyState').classList.toggle('hidden',!!pair);const reviewed=reviewData.pairs.filter(item=>decisions[item.id]&&decisions[item.id].decision).length;const correct=reviewData.pairs.filter(item=>decisions[item.id]&&decisions[item.id].decision==='correct').length;const wrong=reviewData.pairs.filter(item=>decisions[item.id]&&decisions[item.id].decision==='wrong').length;const unsure=reviewData.pairs.filter(item=>decisions[item.id]&&decisions[item.id].decision==='unsure').length;setText('progressText','已審核 '+reviewed+' / '+reviewData.pairs.length);setText('summaryText','正確 '+correct+' · 錯誤 '+wrong+' · 不確定 '+unsure);el('progressFill').style.width=(reviewData.pairs.length?reviewed/reviewData.pairs.length*100:0)+'%';if(!pair)return;const saved=decisions[pair.id]||{};const badge=el('typeBadge');badge.className='type '+pair.type;badge.textContent=pair.type==='automatic'?'自動配對（會直接合併）':'建議配對（等待確認）';setText('ccVendor',pair.creditCard.vendor||'未提供店家');setText('ccDate',pair.creditCard.date);setText('ccAmount',money(pair.creditCard.amount));setText('ccBank',pair.creditCard.bank?'銀行／卡片：'+pair.creditCard.bank:'未記錄銀行／卡片');setText('invoiceVendor',pair.invoice.vendor||'未提供店家');setText('invoiceDate',pair.invoice.date);setText('invoiceAmount',money(pair.invoice.amount));setText('invoiceNo','發票號碼：'+pair.invoice.invoiceNo);renderItems(pair.invoice.items);setText('amountDifference','發票－信用卡：'+money(pair.amountDifference));setText('dateDifference','日期差：'+pair.dateDifferenceDays+' 天');document.querySelectorAll('.decision').forEach(button=>button.classList.toggle('active',button.dataset.decision===saved.decision));el('note').value=saved.note||'';el('prevBtn').disabled=currentIndex===0;el('nextBtn').disabled=currentIndex>=filtered.length-1;el('jumpInput').value=String(currentIndex+1);el('jumpInput').max=String(filtered.length);setText('filteredCount',filtered.length);setText('saveStatus',saved.decision?'目前判定：'+({correct:'正確',wrong:'錯誤',unsure:'不確定'}[saved.decision]):'尚未審核')}
function choose(decision){const pair=currentPair();if(!pair)return;decisions[pair.id]={decision:decision,note:el('note').value.trim(),reviewedAt:new Date().toISOString()};saveDecisions();const filter=el('decisionFilter').value;if(filter==='unreviewed'||(filter!=='all'&&filter!==decision)){applyFilters();return}render();if(currentIndex<filtered.length-1){currentIndex++;render()}}
document.querySelectorAll('.decision').forEach(button=>button.addEventListener('click',()=>choose(button.dataset.decision)));el('note').addEventListener('input',()=>{const pair=currentPair();if(!pair)return;const existing=decisions[pair.id]||{};decisions[pair.id]={...existing,note:el('note').value,reviewedAt:existing.reviewedAt||null};saveDecisions()});el('prevBtn').addEventListener('click',()=>{if(currentIndex>0){currentIndex--;render()}});el('nextBtn').addEventListener('click',()=>{if(currentIndex<filtered.length-1){currentIndex++;render()}});el('jumpInput').addEventListener('change',()=>{const target=Math.max(1,Math.min(filtered.length,Number(el('jumpInput').value)||1));currentIndex=target-1;render()});el('typeFilter').addEventListener('change',()=>{currentIndex=0;applyFilters()});el('decisionFilter').addEventListener('change',()=>{currentIndex=0;applyFilters()});
el('exportBtn').addEventListener('click',()=>{const output={format:'expense-ledger-reconciliation-decisions',version:1,exportedAt:new Date().toISOString(),sourceGeneratedAt:reviewData.generatedAt,decisions:Object.entries(decisions).filter(entry=>entry[1]&&entry[1].decision).map(entry=>({pairId:entry[0],...entry[1]}))};const blob=new Blob([JSON.stringify(output,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='reconciliation-decisions.json';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url)});el('importBtn').addEventListener('click',()=>el('importFile').click());el('importFile').addEventListener('change',async event=>{const file=event.target.files&&event.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(!data||data.format!=='expense-ledger-reconciliation-decisions'||!Array.isArray(data.decisions))throw new Error('格式不符');data.decisions.forEach(item=>{if(item&&item.pairId&&['correct','wrong','unsure'].includes(item.decision))decisions[item.pairId]={decision:item.decision,note:item.note||'',reviewedAt:item.reviewedAt||null}});saveDecisions();applyFilters();alert('判定匯入完成')}catch(error){alert('無法匯入判定檔：'+error.message)}event.target.value=''});
document.addEventListener('keydown',event=>{if(event.target===el('note')||event.target===el('jumpInput'))return;if(event.key==='1')choose('correct');else if(event.key==='2')choose('wrong');else if(event.key==='3')choose('unsure');else if(event.key==='ArrowLeft')el('prevBtn').click();else if(event.key==='ArrowRight')el('nextBtn').click()});
applyFilters();
</script></body></html>`;
}

const fullData = await buildReviewData();
await Deno.writeTextFile(REVIEW_DATA_URL, JSON.stringify(fullData, null, 2));
const data = await applyPrivateReviewSelection(fullData);
await Deno.writeTextFile(OUTPUT_URL, buildHtml(data));
console.log(JSON.stringify({
  output: OUTPUT_URL.pathname,
  originalPairCounts: data.originalPairCounts || data.pairCounts,
  automatic: data.pairCounts.automatic,
  suggested: data.pairCounts.suggested,
  total: data.pairs.length,
}));
