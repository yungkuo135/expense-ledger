const CATEGORIES = [
  "餐飲",
  "交通",
  "日用",
  "飲料",
  "娛樂",
  "醫療",
  "運動健身",
  "折扣調整",
  "平台服務費",
  "其他",
  "服飾",
];
const STORAGE_KEYS = Object.freeze({
  entriesPrefix: "expense-entries-",
  legacyEntries: "expense-entries",
  ledgerMeta: "ledger-meta",
  vendorAliases: "vendor-aliases",
  importBatches: "import-batches-v1",
  legacyMigration: "ledger-migration-entries-v1",
});

// Supports hosts that provide the original asynchronous window.storage API.
class WindowStorageAdapter {
  constructor(storage) {
    this.storage = storage;
  }

  get(key) {
    return this.storage.get(key);
  }
  set(key, value) {
    return this.storage.set(key, value);
  }
  delete(key) {
    return this.storage.delete(key);
  }
  list(prefix) {
    return this.storage.list(prefix);
  }
}

// Standard browser fallback. It preserves the adapter's {value} response
// shape while using the widely supported synchronous localStorage API.
class LocalStorageAdapter {
  constructor(storage) {
    this.storage = storage;
  }

  get(key) {
    const value = this.storage.getItem(key);
    return value === null ? null : { value };
  }
  set(key, value) {
    this.storage.setItem(key, value);
    return { ok: true };
  }
  delete(key) {
    this.storage.removeItem(key);
    return { ok: true };
  }
  list(prefix) {
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return { keys };
  }
}

class UnavailableStorageAdapter {
  unavailable() {
    throw new Error("此瀏覽器無法使用本機儲存空間");
  }
  get() {
    return this.unavailable();
  }
  set() {
    return this.unavailable();
  }
  delete() {
    return this.unavailable();
  }
  list() {
    return this.unavailable();
  }
}

class HttpFileStorageAdapter {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  async request(path, options) {
    const response = await fetch(this.endpoint + path, options);
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).error || "";
      } catch (e) { /* response was not JSON */ }
      throw new Error(detail || `本機測試儲存失敗 (${response.status})`);
    }
    return response.json();
  }

  get(key) {
    return this.request(`?key=${encodeURIComponent(key)}`);
  }
  set(key, value) {
    return this.request("", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
  }
  delete(key) {
    return this.request(`?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }
  list(prefix) {
    return this.request(`/list?prefix=${encodeURIComponent(prefix)}`);
  }
}

function requestedStorageMode() {
  const location = window.location;
  if (!location) return "window";
  const fileRequested =
    new URLSearchParams(location.search || "").get("storage") === "file";
  return fileRequested && location.protocol === "http:" &&
      location.hostname === "127.0.0.1"
    ? "file"
    : "window";
}

const storageMode = requestedStorageMode();
function browserStorageAdapter() {
  const customStorage = window.storage;
  if (
    customStorage &&
    ["get", "set", "delete", "list"].every((method) =>
      typeof customStorage[method] === "function"
    )
  ) {
    return new WindowStorageAdapter(customStorage);
  }
  try {
    if (window.localStorage) {
      return new LocalStorageAdapter(window.localStorage);
    }
  } catch (error) {
    console.error("無法存取 localStorage", error);
  }
  return new UnavailableStorageAdapter();
}

const storageAdapter = storageMode === "file"
  ? new HttpFileStorageAdapter("/api/storage")
  : browserStorageAdapter();

class LedgerRepository {
  constructor(storage) {
    this.storage = storage;
  }

  entriesKeyForMonth(monthKey) {
    return STORAGE_KEYS.entriesPrefix + monthKey;
  }

  async loadEntries() {
    let loadedEntries = [];
    let knownMonthKeys = new Set();
    const listRes = await this.storage.list(STORAGE_KEYS.entriesPrefix);
    const keys = listRes ? listRes.keys : [];
    for (const key of keys) {
      const res = await this.storage.get(key);
      if (!res) continue;
      const monthEntries = JSON.parse(res.value);
      if (!Array.isArray(monthEntries)) {
        throw new Error(`月份資料格式錯誤: ${key}`);
      }
      loadedEntries.push(...monthEntries);
      knownMonthKeys.add(key.slice(STORAGE_KEYS.entriesPrefix.length));
    }

    const legacy = await this.storage.get(STORAGE_KEYS.legacyEntries);
    if (!legacy) {
      return {
        entries: loadedEntries,
        knownMonthKeys,
        migrationCleanupFailed: false,
      };
    }

    const migrationMarker = await this.storage.get(
      STORAGE_KEYS.legacyMigration,
    );
    if (!migrationMarker) {
      const legacyEntries = JSON.parse(legacy.value);
      if (!Array.isArray(legacyEntries)) {
        throw new Error("舊版記帳資料格式錯誤");
      }

      // A monthly key is an atomic snapshot. Existing monthly data is always
      // newer and authoritative; legacy data only fills months whose earlier
      // migration write never completed. This prevents stale legacy data from
      // overwriting edits or resurrecting deleted rows.
      const missingMonthEntries = legacyEntries.filter((entry) => {
        if (!entry || typeof entry.date !== "string") {
          throw new Error("舊版記帳資料包含無效日期");
        }
        return !knownMonthKeys.has(entry.date.slice(0, 7));
      });
      if (missingMonthEntries.length) {
        const merged = [...loadedEntries, ...missingMonthEntries];
        const saved = await this.saveEntries(merged, knownMonthKeys);
        loadedEntries = merged;
        knownMonthKeys = saved.knownMonthKeys;
      }
      await this.storage.set(
        STORAGE_KEYS.legacyMigration,
        JSON.stringify({ completedAt: new Date().toISOString() }),
      );
    }

    let migrationCleanupFailed = false;
    try {
      await this.storage.delete(STORAGE_KEYS.legacyEntries);
    } catch {
      migrationCleanupFailed = true;
    }
    return { entries: loadedEntries, knownMonthKeys, migrationCleanupFailed };
  }

  async saveEntries(currentEntries, currentKnownMonthKeys, affectedMonths) {
    const knownMonthKeys = new Set(currentKnownMonthKeys);
    const monthsToSave = affectedMonths ? new Set(affectedMonths) : new Set([
      ...new Set(currentEntries.map((entry) => monthKeyOf(entry.date))),
      ...knownMonthKeys,
    ]);
    for (const monthKey of monthsToSave) {
      const monthEntries = currentEntries.filter((entry) =>
        monthKeyOf(entry.date) === monthKey
      );
      if (monthEntries.length === 0) {
        await this.storage.delete(this.entriesKeyForMonth(monthKey));
        knownMonthKeys.delete(monthKey);
      } else {
        await this.storage.set(
          this.entriesKeyForMonth(monthKey),
          JSON.stringify(monthEntries),
        );
        knownMonthKeys.add(monthKey);
      }
    }
    return { knownMonthKeys };
  }

  async loadOrCreateLedgerMeta(todayKey) {
    let createdAt = null;
    const res = await this.storage.get(STORAGE_KEYS.ledgerMeta);
    if (res) createdAt = JSON.parse(res.value).createdAt || null;
    if (!createdAt) {
      createdAt = todayKey;
      await this.storage.set(
        STORAGE_KEYS.ledgerMeta,
        JSON.stringify({ createdAt }),
      );
    }
    return createdAt;
  }

  async loadVendorAliases() {
    const res = await this.storage.get(STORAGE_KEYS.vendorAliases);
    return res ? JSON.parse(res.value) : [];
  }

  saveVendorAliases(aliases) {
    return this.storage.set(
      STORAGE_KEYS.vendorAliases,
      JSON.stringify(aliases),
    );
  }

  async loadImportBatches() {
    const res = await this.storage.get(STORAGE_KEYS.importBatches);
    const batches = res ? JSON.parse(res.value) : [];
    return Array.isArray(batches) ? batches : [];
  }

  saveImportBatches(batches) {
    return this.storage.set(
      STORAGE_KEYS.importBatches,
      JSON.stringify(batches.slice(0, 20)),
    );
  }
}

const ledgerRepository = new LedgerRepository(storageAdapter);
