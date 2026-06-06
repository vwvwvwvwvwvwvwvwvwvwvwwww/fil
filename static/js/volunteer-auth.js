(() => {
  function readCsrfFromCookie() {
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1].trim()) : "";
  }

  window.volunteerAuth = {
    ensureCsrf() {
      let t = sessionStorage.getItem("csrf_volunteer");
      if (!t) {
        t = readCsrfFromCookie();
        if (t) sessionStorage.setItem("csrf_volunteer", t);
      }
      return t || "";
    },
    saveCsrf(token) {
      if (token) sessionStorage.setItem("csrf_volunteer", token);
    },
    buildHeaders(options = {}) {
      const csrf = this.ensureCsrf();
      const isFormData = options.body instanceof FormData;
      return {
        ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...options.headers,
      };
    },
    async fetch(url, options = {}) {
      const res = await fetch(url, {
        credentials: "include",
        ...options,
        headers: this.buildHeaders(options),
      });
      if (res.status === 401) {
        sessionStorage.removeItem("csrf_volunteer");
        window.location.href = "/volunteer/login.html";
        throw new Error("unauthorized");
      }
      return res;
    },
    /** Как fetch, но без редиректа на страницу входа (для публичных страниц). */
    async fetchOptional(url, options = {}) {
      return fetch(url, {
        credentials: "include",
        ...options,
        headers: this.buildHeaders(options),
      });
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
