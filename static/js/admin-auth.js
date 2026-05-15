(() => {
  const ME_KEY = "admin_me_cache";

  function readCsrfFromCookie() {
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1].trim()) : "";
  }

  window.adminAuth = {
    invalidateMeCache() {
      try {
        sessionStorage.removeItem(ME_KEY);
      } catch (_) {}
    },
    async fetchMe(options = {}) {
      const force = options.force === true;
      if (location.protocol === "file:") {
        return {
          full_name: "",
          email: "",
          staff_position: null,
          can_manage_applications: true,
          can_manage_content: true,
        };
      }
      if (!force) {
        try {
          const raw = sessionStorage.getItem(ME_KEY);
          if (raw) return JSON.parse(raw);
        } catch (_) {}
      }
      const res = await this.fetch("/api/admin/me");
      if (!res.ok) throw new Error(await this.parseError(res));
      const me = await res.json();
      try {
        sessionStorage.setItem(ME_KEY, JSON.stringify(me));
      } catch (_) {}
      return me;
    },
    ensureCsrf() {
      let t = sessionStorage.getItem("csrf");
      if (!t) {
        t = readCsrfFromCookie();
        if (t) sessionStorage.setItem("csrf", t);
      }
      return t || "";
    },
    saveCsrf(token) {
      if (token) sessionStorage.setItem("csrf", token);
    },
    async fetch(url, options = {}) {
      const csrf = this.ensureCsrf();
      const isFormData = options.body instanceof FormData;
      const headers = {
        ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...options.headers,
      };
      const res = await fetch(url, { credentials: "include", ...options, headers });
      if (res.status === 401) {
        this.invalidateMeCache();
        window.location.href = "/admin/login.html";
        throw new Error("unauthorized");
      }
      return res;
    },
    async parseError(res) {
      let msg = res.statusText;
      try {
        const data = await res.json();
        if (data.detail) {
          msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
        }
      } catch (_) {}
      return msg;
    },
  };
})();
