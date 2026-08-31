function hasSupabaseConfig() {
  const config = window.EXPENSE_LEDGER_SUPABASE || {};
  try {
    const url = new URL(String(config.url || "").trim());
    return url.protocol === "https:" &&
      url.hostname.endsWith(".supabase.co") &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search && !url.hash &&
      /^sb_publishable_/.test(String(config.publishableKey || "").trim());
  } catch (_) {
    return false;
  }
}

function createExpenseLedgerSupabaseClient() {
  if (!hasSupabaseConfig() || !window.supabase?.createClient) return null;
  const config = window.EXPENSE_LEDGER_SUPABASE;
  return window.supabase.createClient(
    String(config.url).trim().replace(/\/$/, ""),
    String(config.publishableKey).trim(),
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );
}

const expenseLedgerSupabase = createExpenseLedgerSupabaseClient();

class SupabaseStorageAdapter {
  constructor(client) {
    this.client = client;
  }

  async authenticatedUser() {
    if (!this.client) throw new Error("Supabase 尚未設定");
    const { data, error } = await this.client.auth.getUser();
    if (error || !data.user) throw new Error("請先登入 Supabase");
    return data.user;
  }

  async get(key) {
    const user = await this.authenticatedUser();
    const { data, error } = await this.client.from("ledger_storage")
      .select("value").eq("user_id", user.id).eq("storage_key", key)
      .maybeSingle();
    if (error) throw error;
    return data ? { value: data.value } : null;
  }

  async set(key, value) {
    const user = await this.authenticatedUser();
    const { error } = await this.client.from("ledger_storage").upsert({
      user_id: user.id,
      storage_key: key,
      value,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,storage_key" });
    if (error) throw error;
    return { ok: true };
  }

  async delete(key) {
    const user = await this.authenticatedUser();
    const { error } = await this.client.from("ledger_storage").delete()
      .eq("user_id", user.id).eq("storage_key", key);
    if (error) throw error;
    return { ok: true };
  }

  async list(prefix) {
    const user = await this.authenticatedUser();
    const { data, error } = await this.client.from("ledger_storage")
      .select("storage_key").eq("user_id", user.id)
      .like("storage_key", `${prefix}%`).order("storage_key");
    if (error) throw error;
    return { keys: data.map((row) => row.storage_key) };
  }
}

async function initializeCloudPanel() {
  const panel = document.getElementById("cloudPanel");
  if (!panel) return;
  if (storageMode === "file") {
    panel.hidden = true;
    document.body.classList.remove("auth-checking");
    document.body.classList.remove("auth-locked");
    return;
  }
  panel.open = true;
  const status = document.getElementById("cloudStatus");
  const form = document.getElementById("cloudAuthForm");
  const email = document.getElementById("cloudEmail");
  const password = document.getElementById("cloudPassword");
  const signOut = document.getElementById("cloudSignOutBtn");

  if (!hasSupabaseConfig()) {
    const config = window.EXPENSE_LEDGER_SUPABASE;
    if (!config) {
      status.textContent = "瀏覽器沒有載入 js/supabase-config.js";
    } else if (!String(config.url || "").trim()) {
      status.textContent = "Supabase Project URL 仍是空白";
    } else if (!String(config.publishableKey || "").trim()) {
      status.textContent = "Supabase publishable key 仍是空白";
    } else {
      status.textContent = "Supabase URL 或 publishable key 格式無法辨識";
    }
    form.hidden = true;
    document.body.classList.remove("auth-checking");
    return;
  }
  if (!window.supabase?.createClient) {
    status.textContent =
      "Supabase SDK 載入失敗，請檢查網路連線或瀏覽器內容阻擋設定";
    form.hidden = true;
    document.body.classList.remove("auth-checking");
    return;
  }
  if (!expenseLedgerSupabase) {
    status.textContent = "無法建立 Supabase 連線，請重新整理後再試";
    form.hidden = true;
    document.body.classList.remove("auth-checking");
    return;
  }

  const renderSession = async () => {
    const { data } = await expenseLedgerSupabase.auth.getUser();
    const user = data.user || null;
    status.textContent = user ? `已登入：${user.email}` : "尚未登入 Supabase";
    document.getElementById("cloudPanelLabel").textContent = user
      ? "雲端已同步"
      : "帳號登入";
    form.hidden = !!user;
    signOut.hidden = !user;
    panel.classList.toggle("session-active", !!user);
    document.body.classList.toggle("auth-locked", !user);
    panel.open = !user;
    document.body.classList.remove("auth-checking");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "登入中…";
    const { error } = await expenseLedgerSupabase.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value,
    });
    if (error) {
      status.textContent = `登入失敗：${error.message}`;
    } else {
      window.location.reload();
    }
  });
  signOut.addEventListener("click", async () => {
    await expenseLedgerSupabase.auth.signOut();
    window.location.reload();
  });
  await renderSession();
}
