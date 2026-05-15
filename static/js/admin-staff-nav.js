/**
 * Скрывает пункты меню панели по правам сотрудника и перенаправляет с запрещённых страниц.
 * Требует admin-auth.js (adminAuth.fetchMe).
 */
(function () {
  function redirectIfForbidden(me) {
    const page = document.body.getAttribute("data-staff-page");
    if (!page) return false;
    if (page === "applications" && !me.can_manage_applications) {
      window.location.replace(me.can_manage_content ? "/admin/events.html" : "/admin/dashboard.html");
      return true;
    }
    if (page === "content" && !me.can_manage_content) {
      window.location.replace(me.can_manage_applications ? "/admin/applications.html" : "/admin/dashboard.html");
      return true;
    }
    return false;
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (location.protocol === "file:" || !window.adminAuth || typeof window.adminAuth.fetchMe !== "function") {
      return;
    }
    try {
      const me = await window.adminAuth.fetchMe();
      if (redirectIfForbidden(me)) return;
      document.querySelectorAll('[data-staff-nav="applications"]').forEach(function (el) {
        if (!me.can_manage_applications) el.classList.add("hidden");
      });
      document.querySelectorAll('[data-staff-nav="content"]').forEach(function (el) {
        if (!me.can_manage_content) el.classList.add("hidden");
      });
    } catch (_) {
      /* сессия и права проверяются при запросах к API */
    }
  });
})();
