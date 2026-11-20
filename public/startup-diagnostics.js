(() => {
  const report = (detail) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (invoke) void invoke("report_frontend_startup", { ready: false, detail }).catch(() => {});
  };
  window.addEventListener("error", (event) => report(event.message || "A frontend resource failed to load"), true);
  window.addEventListener("unhandledrejection", (event) => report(String(event.reason)));
})();
