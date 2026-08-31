(() => {
  if (typeof window.addEventListener !== "function") return;

  const isFileStorageMode =
    new URLSearchParams(window.location?.search || "").get("storage") ===
      "file";

  function notifyConnectionChange(message) {
    if (typeof showToast === "function") showToast(message);
  }

  window.addEventListener("offline", () => {
    notifyConnectionChange("目前離線；帳務資料需連線後才能讀寫");
  });
  window.addEventListener("online", () => {
    notifyConnectionChange("網路已恢復，可繼續同步雲端帳本");
  });

  if (!("serviceWorker" in navigator)) return;

  if (isFileStorageMode) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) registration.unregister();
    });
    return;
  }

  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (error) {
      console.warn("PWA Service Worker 註冊失敗", error);
    }
  });
})();
