const PROJECT_ROOT = new URL("../", import.meta.url);
const INDEX_URL = new URL("index.html", PROJECT_ROOT);
const STATIC_ASSETS = new Map([
  ["/", { url: INDEX_URL, contentType: "text/html; charset=utf-8" }],
  ["/index.html", { url: INDEX_URL, contentType: "text/html; charset=utf-8" }],
  ["/css/styles.css", {
    url: new URL("css/styles.css", PROJECT_ROOT),
    contentType: "text/css; charset=utf-8",
  }],
  ...[
    "storage",
    "core",
    "render",
    "interactions",
    "import-reconciliation",
    "ui",
    "backup-init",
  ].map((name) => [
    `/js/${name}.js`,
    {
      url: new URL(`js/${name}.js`, PROJECT_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
  ]),
]);
const STATE_DIRECTORY_URL = new URL(
  "test-fixtures/private/state/",
  PROJECT_ROOT,
);
const STATE_FILE_URL = new URL("current-ledger.json", STATE_DIRECTORY_URL);
const SEED_BACKUP_URL = new URL("seed-backup.json", STATE_DIRECTORY_URL);
const SNAPSHOTS_DIRECTORY_URL = new URL("snapshots/", STATE_DIRECTORY_URL);
const HOSTNAME = "127.0.0.1";
const PORT = 8000;
const EXPECTED_ORIGIN = `http://${HOSTNAME}:${PORT}`;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export function validateStorageKey(key) {
  return typeof key === "string" &&
    /^(expense-entries(?:-\d{4}-\d{2})?|vendor-aliases|import-batches-v1|ledger-meta|ledger-migration-entries-v1)$/
      .test(key);
}

function assertStorageState(state) {
  if (
    !state || state.format !== "expense-ledger-file-storage" ||
    state.version !== 1 || !state.values || typeof state.values !== "object" ||
    Array.isArray(state.values)
  ) {
    throw new Error("current-ledger.json 格式不符，已停止啟動以避免覆寫資料");
  }
  for (const [key, value] of Object.entries(state.values)) {
    if (!validateStorageKey(key) || typeof value !== "string") {
      throw new Error(`current-ledger.json 包含無效 storage key: ${key}`);
    }
  }
  return state;
}

export function storageStateFromBackup(backup, now = new Date()) {
  if (
    !backup || backup.format !== "expense-ledger-backup" ||
    !Array.isArray(backup.entries)
  ) {
    throw new Error("seed-backup.json 不是有效的完整備份");
  }
  const entriesByMonth = new Map();
  for (const entry of backup.entries) {
    if (
      !entry || typeof entry.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
    ) {
      throw new Error("seed-backup.json 包含無效日期的紀錄");
    }
    const month = entry.date.slice(0, 7);
    if (!entriesByMonth.has(month)) entriesByMonth.set(month, []);
    entriesByMonth.get(month).push(entry);
  }
  const values = {};
  for (const [month, entries] of entriesByMonth) {
    values[`expense-entries-${month}`] = JSON.stringify(entries);
  }
  values["vendor-aliases"] = JSON.stringify(
    Array.isArray(backup.vendorAliases) ? backup.vendorAliases : [],
  );
  values["import-batches-v1"] = JSON.stringify(
    Array.isArray(backup.importBatches)
      ? backup.importBatches.slice(0, 20)
      : [],
  );
  return {
    format: "expense-ledger-file-storage",
    version: 1,
    updatedAt: now.toISOString(),
    values,
  };
}

async function pathExists(url) {
  try {
    await Deno.stat(url);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function atomicWriteJson(url, value) {
  const temporaryUrl = new URL(
    `.current-ledger.tmp-${crypto.randomUUID()}`,
    new URL("./", url),
  );
  const serialized = JSON.stringify(value, null, 2);
  JSON.parse(serialized);
  await Deno.writeTextFile(temporaryUrl, serialized);
  await Deno.rename(temporaryUrl, url);
}

export class JsonFileStorageStore {
  constructor(options = {}) {
    this.stateFileUrl = options.stateFileUrl || STATE_FILE_URL;
    this.seedBackupUrl = options.seedBackupUrl || SEED_BACKUP_URL;
    this.snapshotsDirectoryUrl = options.snapshotsDirectoryUrl ||
      SNAPSHOTS_DIRECTORY_URL;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await Deno.mkdir(new URL("./", this.stateFileUrl), { recursive: true });
    if (await pathExists(this.stateFileUrl)) {
      this.state = assertStorageState(
        JSON.parse(await Deno.readTextFile(this.stateFileUrl)),
      );
      await this.createSessionSnapshot();
      return;
    }
    if (await pathExists(this.seedBackupUrl)) {
      const backup = JSON.parse(await Deno.readTextFile(this.seedBackupUrl));
      this.state = storageStateFromBackup(backup);
    } else {
      this.state = {
        format: "expense-ledger-file-storage",
        version: 1,
        updatedAt: new Date().toISOString(),
        values: {},
      };
    }
    await atomicWriteJson(this.stateFileUrl, this.state);
  }

  async createSessionSnapshot() {
    await Deno.mkdir(this.snapshotsDirectoryUrl, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const snapshotUrl = new URL(
      `before-session-${timestamp}.json`,
      this.snapshotsDirectoryUrl,
    );
    await Deno.copyFile(this.stateFileUrl, snapshotUrl);
  }

  get(key) {
    if (!Object.hasOwn(this.state.values, key)) return null;
    return { value: this.state.values[key] };
  }

  list(prefix) {
    return {
      keys: Object.keys(this.state.values).filter((key) =>
        key.startsWith(prefix)
      ).sort(),
    };
  }

  async mutate(mutation) {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      const nextState = {
        ...this.state,
        updatedAt: new Date().toISOString(),
        values: { ...this.state.values },
      };
      mutation(nextState.values);
      await atomicWriteJson(this.stateFileUrl, nextState);
      this.state = nextState;
    });
    this.writeQueue = operation;
    await operation;
  }

  set(key, value) {
    return this.mutate((values) => {
      values[key] = value;
    });
  }

  delete(key) {
    return this.mutate((values) => {
      delete values[key];
    });
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function originAllowed(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === EXPECTED_ORIGIN;
}

export function createRequestHandler(store) {
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (!originAllowed(request)) {
        return errorResponse("不允許跨來源存取", 403);
      }

      const staticAsset = STATIC_ASSETS.get(url.pathname);
      if (staticAsset) {
        if (request.method !== "GET") {
          return errorResponse("Method not allowed", 405);
        }
        return new Response(await Deno.readTextFile(staticAsset.url), {
          headers: {
            "Content-Type": staticAsset.contentType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      if (url.pathname === "/api/storage/list") {
        if (request.method !== "GET") {
          return errorResponse("Method not allowed", 405);
        }
        return jsonResponse(store.list(url.searchParams.get("prefix") || ""));
      }

      if (url.pathname !== "/api/storage") {
        return errorResponse("Not found", 404);
      }
      if (request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!validateStorageKey(key)) return errorResponse("無效 storage key");
        return jsonResponse(store.get(key));
      }
      if (request.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!validateStorageKey(key)) return errorResponse("無效 storage key");
        await store.delete(key);
        return jsonResponse({ ok: true });
      }
      if (request.method === "PUT") {
        const contentLength = Number(
          request.headers.get("Content-Length") || 0,
        );
        if (contentLength > MAX_REQUEST_BYTES) {
          return errorResponse("資料超過單次寫入限制", 413);
        }
        const bodyText = await request.text();
        if (new TextEncoder().encode(bodyText).byteLength > MAX_REQUEST_BYTES) {
          return errorResponse("資料超過單次寫入限制", 413);
        }
        const body = JSON.parse(bodyText);
        if (!validateStorageKey(body?.key) || typeof body?.value !== "string") {
          return errorResponse("寫入格式不符");
        }
        await store.set(body.key, body.value);
        return jsonResponse({ ok: true });
      }
      return errorResponse("Method not allowed", 405);
    } catch (error) {
      console.error(error);
      return errorResponse("本機測試儲存發生錯誤", 500);
    }
  };
}

if (import.meta.main) {
  const store = new JsonFileStorageStore();
  await store.initialize();
  console.log(`本機測試模式：http://${HOSTNAME}:${PORT}/?storage=file`);
  console.log(`檔案狀態：${STATE_FILE_URL.pathname}`);
  Deno.serve({ hostname: HOSTNAME, port: PORT }, createRequestHandler(store));
}
