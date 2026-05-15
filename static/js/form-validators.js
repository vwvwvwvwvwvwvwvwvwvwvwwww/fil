/**
 * Клиентские проверки форм (дублируют логику сервера для UX).
 * Подключать перед inline-скриптами страниц.
 */
(function () {
  const NAME_PATTERN = /^[\p{L}\s\-\.'’]{2,200}$/u;

  function digitsOnly(s) {
    return [...String(s)].filter((c) => /\d/.test(c)).join("");
  }

  function showErr(el, text, inputEl) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("hidden", !text);
    if (text) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", "true");
    if (inputEl) {
      if (text) {
        inputEl.classList.add("border-red-500", "ring-2", "ring-red-500/25");
        inputEl.setAttribute("aria-invalid", "true");
      } else {
        inputEl.classList.remove("border-red-500", "ring-2", "ring-red-500/25");
        inputEl.removeAttribute("aria-invalid");
      }
    }
  }

  function clearErrors(map, inputMap) {
    Object.keys(map).forEach((key) => {
      const inp = inputMap && inputMap[key];
      showErr(map[key], "", inp);
    });
  }

  function validateApply(fields, errMap, inputMap) {
    clearErrors(errMap, inputMap);
    const errs = [];

    const fn = String(fields.full_name || "").trim();
    if (!fn || fn.length < 2) {
      showErr(errMap.full_name, "Укажите ФИО (не короче 2 символов).", inputMap && inputMap.full_name);
      errs.push("full_name");
    } else if (!NAME_PATTERN.test(fn)) {
      showErr(errMap.full_name, "ФИО: только буквы, пробелы, точка и дефис (2–200 символов).", inputMap && inputMap.full_name);
      errs.push("full_name");
    }

    const em = String(fields.email || "").trim();
    if (!em) {
      showErr(errMap.email, "Укажите электронную почту.", inputMap && inputMap.email);
      errs.push("email");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      showErr(errMap.email, "Некорректный формат email.", inputMap && inputMap.email);
      errs.push("email");
    }

    const phRaw = String(fields.phone || "").trim();
    if (phRaw) {
      const d = digitsOnly(phRaw);
      if (d.length < 10 || d.length > 15) {
        showErr(errMap.phone, "Телефон: от 10 до 15 цифр (можно с +7 и скобками).", inputMap && inputMap.phone);
        errs.push("phone");
      }
    }

    const mot = fields.motivation != null ? String(fields.motivation) : "";
    if (mot.length > 5000) {
      showErr(errMap.motivation, "Текст не длиннее 5000 символов.", inputMap && inputMap.motivation);
      errs.push("motivation");
    }

    return errs.length === 0;
  }

  function validateLogin(email, password, errEmail, errPass, inputEmail, inputPass) {
    showErr(errEmail, "", inputEmail);
    showErr(errPass, "", inputPass);
    const em = String(email || "").trim();
    const pw = String(password || "");
    let ok = true;
    if (!em) {
      showErr(errEmail, "Введите email.", inputEmail);
      ok = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      showErr(errEmail, "Некорректный формат email.", inputEmail);
      ok = false;
    }
    if (!pw) {
      showErr(errPass, "Введите пароль.", inputPass);
      ok = false;
    } else if (pw.length < 4) {
      showErr(errPass, "Пароль не короче 4 символов.", inputPass);
      ok = false;
    }
    return ok;
  }

  function validateEventCreate(payload) {
    const title = String(payload.title || "").trim();
    if (title.length < 3) return "Название: минимум 3 символа.";
    if (title.length > 500) return "Название: не более 500 символов.";
    if (!payload.date_start) return "Укажите дату и время начала.";
    const ds = new Date(payload.date_start);
    if (Number.isNaN(ds.getTime())) return "Неверная дата начала.";
    if (payload.date_end) {
      const de = new Date(payload.date_end);
      if (Number.isNaN(de.getTime())) return "Неверная дата окончания.";
      if (de < ds) return "Окончание не может быть раньше начала.";
    }
    const loc = payload.location != null ? String(payload.location) : "";
    if (loc.length > 500) return "Место: не более 500 символов.";
    const desc = payload.description != null ? String(payload.description) : "";
    if (desc.length > 10000) return "Описание: не более 10000 символов.";
    return null;
  }

  function validateBlogCreate(title, content) {
    const t = String(title || "").trim();
    const c = String(content || "");
    if (t.length < 3) return "Заголовок: минимум 3 символа.";
    if (t.length > 300) return "Заголовок: не более 300 символов.";
    if (c.trim().length < 10) return "Текст публикации: минимум 10 символов.";
    if (c.length > 200000) return "Текст слишком длинный.";
    return null;
  }

  window.FormValidators = {
    validateApply,
    validateLogin,
    validateEventCreate,
    validateBlogCreate,
    showErr,
    clearErrors,
  };
})();
