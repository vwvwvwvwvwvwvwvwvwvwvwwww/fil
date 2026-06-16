/**
 * Модальные окна для панели сотрудника: уведомления и подтверждения.
 */
(function () {
  let root = null;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "admin-modal-root";
    root.className = "admin-modal-root hidden";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      '<div class="admin-modal-backdrop" data-admin-modal-close></div>' +
      '<div class="admin-modal-panel" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title">' +
      '<p id="admin-modal-badge" class="admin-modal-badge hidden"></p>' +
      '<h2 id="admin-modal-title" class="admin-modal-title"></h2>' +
      '<p id="admin-modal-body" class="admin-modal-body"></p>' +
      '<div class="admin-modal-actions">' +
      '<button type="button" id="admin-modal-secondary" class="admin-modal-btn admin-modal-btn--ghost hidden">Отмена</button>' +
      '<button type="button" id="admin-modal-primary" class="admin-modal-btn admin-modal-btn--primary">OK</button>' +
      "</div></div>";
    document.body.appendChild(root);

    root.querySelector("[data-admin-modal-close]").addEventListener("click", () => close(false));
    root.querySelector("#admin-modal-secondary").addEventListener("click", () => close(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root && !root.classList.contains("hidden")) close(false);
    });
    return root;
  }

  let resolver = null;
  let confirmMode = false;

  function close(result) {
    if (!root) return;
    root.classList.add("hidden");
    root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("admin-modal-open");
    const fn = resolver;
    resolver = null;
    confirmMode = false;
    if (fn) fn(result);
  }

  function open(opts) {
    ensureRoot();
    const badge = root.querySelector("#admin-modal-badge");
    const titleEl = root.querySelector("#admin-modal-title");
    const bodyEl = root.querySelector("#admin-modal-body");
    const primary = root.querySelector("#admin-modal-primary");
    const secondary = root.querySelector("#admin-modal-secondary");
    const panel = root.querySelector(".admin-modal-panel");

    panel.classList.remove("admin-modal-panel--success", "admin-modal-panel--error", "admin-modal-panel--confirm");
    const type = opts.type || "success";
    if (type === "error") panel.classList.add("admin-modal-panel--error");
    else if (type === "confirm") panel.classList.add("admin-modal-panel--confirm");
    else panel.classList.add("admin-modal-panel--success");

    const labels = { success: "Готово", error: "Ошибка", confirm: "Подтверждение", info: "Сообщение" };
    badge.textContent = labels[type] || labels.info;
    badge.classList.remove("hidden");

    titleEl.textContent = opts.title || (type === "error" ? "Не удалось выполнить действие" : "Успешно");
    bodyEl.textContent = opts.message || "";

    confirmMode = type === "confirm";
    secondary.classList.toggle("hidden", !confirmMode);
    primary.textContent = opts.confirmLabel || (confirmMode ? "Да" : "OK");
    secondary.textContent = opts.cancelLabel || "Отмена";

    primary.onclick = () => close(confirmMode ? true : true);

    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    document.body.classList.add("admin-modal-open");
    primary.focus();
  }

  window.adminModal = {
    /** Уведомление об успехе или ошибке */
    alert(message, options) {
      const opts = typeof options === "string" ? { title: options } : options || {};
      return new Promise((resolve) => {
        resolver = () => resolve();
        open({
          type: opts.type || "success",
          title: opts.title,
          message: message,
          confirmLabel: opts.confirmLabel || "OK",
        });
      });
    },
    /** Подтверждение действия */
    confirm(message, options) {
      const opts = options || {};
      return new Promise((resolve) => {
        resolver = resolve;
        open({
          type: "confirm",
          title: opts.title || "Подтвердите действие",
          message: message,
          confirmLabel: opts.confirmLabel || "Да",
          cancelLabel: opts.cancelLabel || "Отмена",
        });
      });
    },
  };
})();
