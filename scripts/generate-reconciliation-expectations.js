const PROJECT_ROOT = new URL("../", import.meta.url);
const REVIEW_DATA_URL = new URL(
  "test-fixtures/private/reconciliation-review-data.json",
  PROJECT_ROOT,
);
const DECISIONS_URL = new URL(
  "test-fixtures/private/reconciliation-decisions.json",
  PROJECT_ROOT,
);
const SELECTION_URL = new URL(
  "test-fixtures/private/reconciliation-review-selection.json",
  PROJECT_ROOT,
);
const OUTPUT_URL = new URL(
  "test-fixtures/private/reconciliation-expectations.json",
  PROJECT_ROOT,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const reviewData = JSON.parse(await Deno.readTextFile(REVIEW_DATA_URL));
const decisionsDocument = JSON.parse(await Deno.readTextFile(DECISIONS_URL));
const selection = JSON.parse(await Deno.readTextFile(SELECTION_URL));

assert(
  reviewData?.format === "expense-ledger-reconciliation-review",
  "完整審核資料格式不符",
);
assert(
  decisionsDocument?.format === "expense-ledger-reconciliation-decisions",
  "人工判定資料格式不符",
);
assert(
  selection?.format === "expense-ledger-reconciliation-review-selection",
  "精簡審核選擇資料格式不符",
);

const humanDecisions = new Map(
  (decisionsDocument.decisions || []).map((item) => [item.pairId, item]),
);
const wrongPairIds = new Set(selection.wrongPairIds || []);
const resolvedPairIds = new Set(selection.resolvedUserReviewPairIds || []);
for (const pairId of resolvedPairIds) {
  assert(humanDecisions.has(pairId), `已完成人工審核的 ${pairId} 缺少判定`);
}

const expectations = reviewData.pairs.map((pair) => {
  const human = humanDecisions.get(pair.id);
  if (human?.decision) {
    return {
      pairId: pair.id,
      originalType: pair.type,
      decision: human.decision,
      provenance: "user",
    };
  }
  if (wrongPairIds.has(pair.id)) {
    return {
      pairId: pair.id,
      originalType: pair.type,
      decision: "wrong",
      provenance: "assistant-review",
    };
  }
  if (
    pair.type === "automatic" && selection.automaticMatches === "assume-correct"
  ) {
    return {
      pairId: pair.id,
      originalType: pair.type,
      decision: "correct",
      provenance: "user-policy",
    };
  }
  if (
    pair.type === "suggested" &&
    selection.unreviewedSuggestionDefault === "assistant-reviewed-correct"
  ) {
    return {
      pairId: pair.id,
      originalType: pair.type,
      decision: "correct",
      provenance: "assistant-review",
    };
  }
  throw new Error(`配對 ${pair.id} 尚未得到最終判定`);
});

const expectedIds = new Set(expectations.map((item) => item.pairId));
assert(expectedIds.size === expectations.length, "最終對帳期望包含重複 pairId");
for (const item of decisionsDocument.decisions || []) {
  assert(
    expectedIds.has(item.pairId),
    `人工判定 ${item.pairId} 已不在目前配對資料中`,
  );
}

const counts = expectations.reduce((result, item) => {
  result[item.decision] = (result[item.decision] || 0) + 1;
  return result;
}, {});
const output = {
  format: "expense-ledger-reconciliation-expectations",
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceGeneratedAt: reviewData.generatedAt,
  counts,
  expectations,
};
await Deno.writeTextFile(OUTPUT_URL, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ output: OUTPUT_URL.pathname, counts }));
