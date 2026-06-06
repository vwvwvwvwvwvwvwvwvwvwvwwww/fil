import fs from "fs";
import path from "path";
import crypto from "crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import validator from "validator";
import { config } from "./config.js";
import { getDb, initDb } from "./db.js";
import {
  createAccessToken,
  decodeToken,
  generateCsrfToken,
  hashPassword,
  verifyPassword,
} from "./auth.js";
import { checkApplyRateLimit } from "./rateLimit.js";

function logLine(msg) {
  const line = `${new Date().toISOString()} [INFO] app: ${msg}`;
  console.info(line);
  if (!config.logFile || String(config.logFile).trim() === "-") return;
  try {
    const p = path.isAbsolute(config.logFile) ? config.logFile : path.join(config.root, config.logFile);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${line}\n`, "utf8");
  } catch (e) {
    console.error("log fail", e);
  }
}

function asIso(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toISOString();
}

function sendDetail(reply, status, detail) {
  return reply.code(status).send({ detail });
}

/** Кэш ответа VK wall.get (между запросами клиента). */
let vkWallCache = { at: 0, json: null };

function vkWallPostUrl(ownerId, postId) {
  return `https://vk.com/wall${ownerId}_${postId}`;
}

function vkBestPhotoFromSizes(sizes) {
  if (!sizes || !sizes.length) return null;
  const sorted = [...sizes].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

function vkExtractPhoto(item) {
  const atts = item.attachments;
  if (!Array.isArray(atts)) return null;
  for (const a of atts) {
    if (a.type === "photo" && a.photo?.sizes?.length) {
      const u = vkBestPhotoFromSizes(a.photo.sizes);
      if (u) return u;
    }
    if (a.type === "posted_photo" && a.posted_photo?.photo?.sizes?.length) {
      const u = vkBestPhotoFromSizes(a.posted_photo.photo.sizes);
      if (u) return u;
    }
    if (a.type === "video" && a.video?.image) {
      const arr = Array.isArray(a.video.image) ? a.video.image : Object.values(a.video.image);
      const u = vkBestPhotoFromSizes(arr);
      if (u) return u;
    }
    if (a.type === "link" && a.link?.photo?.sizes?.length) {
      const u = vkBestPhotoFromSizes(a.link.photo.sizes);
      if (u) return u;
    }
  }
  return null;
}

const NAME_PATTERN = /^[\p{L}\s\-\.'’]{2,200}$/u;

function validateApplication(body) {
  const errors = [];

  const full_name = body.full_name != null ? String(body.full_name).trim() : "";
  if (!full_name || full_name.length < 2) {
    errors.push({ loc: ["body", "full_name"], msg: "invalid" });
  } else if (full_name.length > 200 || !NAME_PATTERN.test(full_name)) {
    errors.push({ loc: ["body", "full_name"], msg: "invalid" });
  }

  const emailRaw = body.email != null ? String(body.email).trim() : "";
  if (!emailRaw || !validator.isEmail(emailRaw) || emailRaw.length > 254) {
    errors.push({ loc: ["body", "email"], msg: "value is not a valid email address" });
  }

  let phone = body.phone != null && String(body.phone).trim() !== "" ? String(body.phone).trim() : null;
  if (phone) {
    const digitCount = [...phone].filter((c) => /\d/.test(c)).length;
    if (digitCount < 10 || digitCount > 15) {
      errors.push({ loc: ["body", "phone"], msg: "Укажите корректный номер телефона" });
    }
  }

  let motivation =
    body.motivation != null && String(body.motivation).trim() !== "" ? String(body.motivation) : null;
  if (motivation && motivation.length > 5000) {
    errors.push({ loc: ["body", "motivation"], msg: "too long" });
  }

  return { errors, phone, motivation, email: emailRaw, full_name };
}

/** Права сотрудника панели (роль advisor). Оба false трактуем как полный доступ — для старых записей. */
function advisorCapabilities(row) {
  if (!row || row.role !== "advisor") {
    return { can_manage_applications: false, can_manage_content: false };
  }
  const a = row.can_manage_applications === 1 || row.can_manage_applications === true;
  const c = row.can_manage_content === 1 || row.can_manage_content === true;
  if (!a && !c) {
    return { can_manage_applications: true, can_manage_content: true };
  }
  return { can_manage_applications: a, can_manage_content: c };
}

async function requireAdvisor(request, reply) {
  const token = request.cookies[config.cookieName];
  if (!token) return sendDetail(reply, 401, "Требуется вход");
  let payload;
  try {
    payload = decodeToken(token);
  } catch {
    return sendDetail(reply, 401, "Недействительная сессия");
  }
  if (payload.role !== "advisor") return sendDetail(reply, 403, "Доступ только для советников");
  const uid = payload.uid;
  if (!uid) return sendDetail(reply, 401, "Недействительная сессия");
  const user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!user || user.role !== "advisor" || !(user.is_active === 1 || user.is_active === true)) {
    return sendDetail(reply, 403, "Пользователь не найден или отключён");
  }
  request.advisor = user;
  request.advisorCaps = advisorCapabilities(user);
}

async function requireStaffApplications(request, reply) {
  await requireAdvisor(request, reply);
  if (reply.sent) return;
  if (!request.advisorCaps.can_manage_applications) {
    return sendDetail(reply, 403, "Недостаточно прав для работы с заявками волонтёров");
  }
}

async function requireStaffContent(request, reply) {
  await requireAdvisor(request, reply);
  if (reply.sent) return;
  if (!request.advisorCaps.can_manage_content) {
    return sendDetail(reply, 403, "Недостаточно прав для изменения мероприятий и материалов");
  }
}

async function requireVolunteer(request, reply) {
  const token = request.cookies[config.cookieName];
  if (!token) return sendDetail(reply, 401, "Требуется вход");
  let payload;
  try {
    payload = decodeToken(token);
  } catch {
    return sendDetail(reply, 401, "Недействительная сессия");
  }
  if (payload.role !== "volunteer") return sendDetail(reply, 403, "Доступ только для волонтёров");
  const uid = payload.uid;
  if (!uid) return sendDetail(reply, 401, "Недействительная сессия");
  const user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!user || user.role !== "volunteer" || !(user.is_active === 1 || user.is_active === true)) {
    return sendDetail(reply, 403, "Пользователь не найден или отключён");
  }
  request.volunteer = user;
}

async function csrfHook(request, reply) {
  const m = ["POST", "PUT", "DELETE", "PATCH"];
  if (!m.includes(request.method)) return;
  const pathOnly = request.url.split("?")[0];
  const csrfExempt =
    pathOnly === "/api/admin/login" ||
    pathOnly === "/api/volunteer/login" ||
    pathOnly === "/api/volunteer/activate";
  if (
    (pathOnly.startsWith("/api/admin") || pathOnly.startsWith("/api/volunteer")) &&
    !csrfExempt
  ) {
    const c = request.cookies[config.csrfCookieName];
    const h = request.headers["x-csrf-token"];
    if (!c || !h || c !== h) {
      return reply.code(403).send({ detail: "CSRF: недопустимый или отсутствующий токен" });
    }
  }
}

export async function buildServer() {
  initDb();
  fs.mkdirSync(config.staticRoot, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const app = Fastify({
    logger: true,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie, {
    hook: "onRequest",
  });

  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  await app.register(fastifyStatic, {
    root: config.staticRoot,
    prefix: "/static/",
  });

  app.addHook("onRequest", csrfHook);

  app.get("/health", async () => ({ status: "ok" }));

  /* ---------- Public API ---------- */
  app.post("/api/apply", async (request, reply) => {
    const body = request.body || {};
    const v = validateApplication(body);
    if (v.errors.length) {
      return reply.code(400).send({ detail: v.errors });
    }
    try {
      checkApplyRateLimit(v.email);
    } catch (e) {
      return reply.code(e.statusCode || 429).send({ detail: e.message });
    }
    const pending = getDb()
      .prepare("SELECT id FROM applications WHERE email = ? AND status = 'pending'")
      .get(v.email);
    if (pending) {
      return sendDetail(reply, 400, "По этому email уже есть заявка на рассмотрении");
    }
    const r = getDb()
      .prepare(
        `INSERT INTO applications (full_name, email, phone, motivation, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(v.full_name, v.email, v.phone, v.motivation);
    return reply.code(201).send({ id: Number(r.lastInsertRowid), message: "Заявка принята" });
  });

  app.get("/api/events", async () => {
    const now = new Date().toISOString();
    const rows = getDb()
      .prepare(
        `SELECT * FROM events WHERE status = 'published'
         AND (date_end IS NULL OR date_end >= ?)
         ORDER BY date_start ASC`
      )
      .all(now);
    return rows.map((ev) => ({
      id: ev.id,
      title: ev.title,
      description: ev.description,
      date_start: asIso(ev.date_start),
      date_end: ev.date_end ? asIso(ev.date_end) : null,
      location: ev.location,
      status: ev.status,
    }));
  });

  app.get("/api/events/:id", async (request, reply) => {
    const eventId = Number(request.params.id);
    const ev = getDb()
      .prepare("SELECT * FROM events WHERE id = ? AND status = 'published'")
      .get(eventId);
    if (!ev) return sendDetail(reply, 404, "Мероприятие не найдено");

    const parts = getDb()
      .prepare(
        `SELECT ep.id, ep.external_name, ep.role_in_event, ep.user_id, u.full_name AS user_full_name
         FROM event_participants ep
         LEFT JOIN users u ON ep.user_id = u.id
         WHERE ep.event_id = ?`
      )
      .all(eventId);

    const participants = parts.map((p) => {
      const display =
        p.user_full_name ||
        (p.external_name && String(p.external_name).trim()) ||
        "Участник";
      return {
        id: p.id,
        external_name: p.external_name,
        role_in_event: p.role_in_event,
        display_name: display,
      };
    });

    return {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      date_start: asIso(ev.date_start),
      date_end: ev.date_end ? asIso(ev.date_end) : null,
      location: ev.location,
      status: ev.status,
      participants,
    };
  });

  app.get("/api/blog", async () => {
    const rows = getDb()
      .prepare(`SELECT * FROM blog_posts WHERE is_visible = 1 ORDER BY published_at DESC`)
      .all();
    return rows.map(mapBlogPublic);
  });

  const vkCommunityUrl = `https://vk.com/${config.vkGroupDomain}`;

  function loadVkWallSnapshot() {
    try {
      const p = path.join(config.staticRoot, "data", "vk-gapou-wall-cache.json");
      if (!fs.existsSync(p)) return null;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const posts = j.posts;
      if (!Array.isArray(posts) || !posts.length) return null;
      return posts
        .filter((x) => x && (String(x.text || "").trim() || x.photo_url))
        .map((x) => ({
          id: String(x.id || ""),
          text: String(x.text || "").trim(),
          date: x.date || new Date().toISOString(),
          url: String(x.url || "").trim() || vkCommunityUrl,
          photo_url: x.photo_url ? String(x.photo_url) : null,
        }));
    } catch (e) {
      logLine(`vk_wall_snapshot_read ${e?.message || e}`);
      return null;
    }
  }

  app.get("/api/vk/wall", async () => {
    if (!config.vkAccessToken) {
      const snap = loadVkWallSnapshot();
      if (snap && snap.length) {
        return {
          ok: true,
          configured: false,
          snapshot: true,
          community_url: vkCommunityUrl,
          posts: snap,
          hint:
            "Показан сохранённый снимок записей сообщества (файл static/data/vk-gapou-wall-cache.json). Чтобы подставлять живую ленту автоматически, добавьте VK_ACCESS_TOKEN в .env.",
        };
      }
      return {
        ok: true,
        configured: false,
        community_url: vkCommunityUrl,
        posts: [],
        hint:
          "Чтобы здесь автоматически появлялись записи сообщества, добавьте в .env переменную VK_ACCESS_TOKEN (сервисный ключ приложения VK). Либо заполните статический снимок static/data/vk-gapou-wall-cache.json.",
      };
    }

    const ttl = config.vkWallCacheSeconds * 1000;
    const now = Date.now();
    if (vkWallCache.json && now - vkWallCache.at < ttl) {
      return { ...vkWallCache.json, cached: true };
    }

    const params = new URLSearchParams({
      v: "5.199",
      domain: config.vkGroupDomain,
      count: String(config.vkWallCount),
      filter: "owner",
      access_token: config.vkAccessToken,
    });
    const url = `https://api.vk.com/method/wall.get?${params}`;

    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      const data = await res.json();

      if (data.error) {
        logLine(`vk_wall_api_error code=${data.error.error_code} msg=${data.error.error_msg || ""}`);
        const snap = loadVkWallSnapshot();
        if (snap && snap.length) {
          return {
            ok: true,
            configured: true,
            snapshot: true,
            fallback_from_snapshot: true,
            community_url: vkCommunityUrl,
            posts: snap,
            detail: data.error.error_msg || "Ошибка API ВКонтакте — показан локальный снимок ленты.",
          };
        }
        const payload = {
          ok: false,
          configured: true,
          community_url: vkCommunityUrl,
          posts: [],
          detail: data.error.error_msg || "Ошибка API ВКонтакте",
        };
        return payload;
      }

      const items = data.response?.items || [];
      const posts = items
        .map((item) => {
          const text = String(item.text || "").trim();
          const photo_url = vkExtractPhoto(item);
          return {
            id: `${item.owner_id}_${item.id}`,
            text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
            date: new Date((item.date || 0) * 1000).toISOString(),
            url: vkWallPostUrl(item.owner_id, item.id),
            photo_url,
          };
        })
        .filter((p) => p.text || p.photo_url);

      const payload = {
        ok: true,
        configured: true,
        community_url: vkCommunityUrl,
        posts,
      };
      vkWallCache = { at: now, json: payload };
      return payload;
    } catch (e) {
      logLine(`vk_wall_fetch_fail ${e?.message || e}`);
      const snap = loadVkWallSnapshot();
      if (snap && snap.length) {
        return {
          ok: true,
          configured: true,
          snapshot: true,
          fallback_from_snapshot: true,
          community_url: vkCommunityUrl,
          posts: snap,
          detail: "Не удалось связаться с сервером ВКонтакте — показан локальный снимок ленты.",
        };
      }
      return {
        ok: false,
        configured: true,
        community_url: vkCommunityUrl,
        posts: [],
        detail: "Не удалось связаться с сервером ВКонтакте",
      };
    }
  });

  app.get("/api/blog/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const post = getDb()
      .prepare("SELECT * FROM blog_posts WHERE id = ? AND is_visible = 1")
      .get(id);
    if (!post) return sendDetail(reply, 404, "Публикация не найдена");
    getDb().prepare("UPDATE blog_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?").run(id);
    const updated = getDb().prepare("SELECT * FROM blog_posts WHERE id = ?").get(id);
    return mapBlogPublic(updated);
  });

  function mapBlogPublic(row) {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      image_url: row.image_url,
      published_at: asIso(row.published_at),
    };
  }

  /* ---------- Auth ---------- */
  function setAuthCookies(reply, user) {
    const csrf = generateCsrfToken();
    const token = createAccessToken(user.email, user.id, user.role);
    const maxAge = config.accessTokenExpireMinutes * 60;
    reply.setCookie(config.cookieName, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge,
    });
    reply.setCookie(config.csrfCookieName, csrf, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge,
    });
    return csrf;
  }

  app.post("/api/admin/login", async (request, reply) => {
    const body = request.body || {};
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "").trim();
    if (!email || !password || !validator.isEmail(email)) {
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    const user = getDb().prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email);
    if (!user || user.role !== "advisor" || !user.password_hash) {
      logLine(`failed_login attempt for ${email}`);
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    if (!verifyPassword(password, user.password_hash)) {
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    if (!(user.is_active === 1 || user.is_active === true))
      return sendDetail(reply, 403, "Учётная запись отключена");

    const csrf = setAuthCookies(reply, user);
    logLine(`advisor_login user_id=${user.id}`);
    return { ok: true, csrf };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const c = { path: "/", secure: config.cookieSecure };
    reply.clearCookie(config.cookieName, c);
    reply.clearCookie(config.csrfCookieName, c);
    return { ok: true };
  });

  app.post("/api/volunteer/login", async (request, reply) => {
    const body = request.body || {};
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "").trim();
    if (!email || !password || !validator.isEmail(email)) {
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    const user = getDb().prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email);
    if (!user) {
      logLine(`failed_volunteer_login attempt for ${email}`);
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    if (user.role === "advisor") {
      return sendDetail(
        reply,
        403,
        "Этот email относится к учётной записи сотрудника. Вход для сотрудников — на странице /admin/login.html (не на странице волонтёра)."
      );
    }
    if (user.role !== "volunteer") {
      logLine(`failed_volunteer_login attempt for ${email}`);
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    if (!user.password_hash) {
      return sendDetail(
        reply,
        403,
        "Пароль ещё не задан. На этой странице заполните форму «Первый вход» (активация), затем войдите с тем же паролем."
      );
    }
    if (!verifyPassword(password, user.password_hash)) {
      return sendDetail(reply, 401, "Неверный email или пароль");
    }
    if (!(user.is_active === 1 || user.is_active === true))
      return sendDetail(reply, 403, "Учётная запись отключена");

    const csrf = setAuthCookies(reply, user);
    logLine(`volunteer_login user_id=${user.id}`);
    return { ok: true, csrf };
  });

  app.post("/api/volunteer/activate", async (request, reply) => {
    const body = request.body || {};
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const password2 = String(body.password_confirm || body.password2 || "");
    if (!validator.isEmail(email)) {
      return sendDetail(reply, 400, "Укажите корректный email.");
    }
    if (password.length < 6) {
      return sendDetail(reply, 400, "Пароль не короче 6 символов.");
    }
    if (password !== password2) {
      return sendDetail(reply, 400, "Пароли не совпадают.");
    }
    const user = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || user.role !== "volunteer") {
      return sendDetail(reply, 400, "Учётная запись не найдена. Проверьте email или подайте заявку.");
    }
    if (!(user.is_active === 1 || user.is_active === true)) {
      return sendDetail(reply, 403, "Запись ещё не активирована — дождитесь одобрения заявки воспитательным отделом.");
    }
    if (user.password_hash) {
      return sendDetail(reply, 400, "Пароль уже задан — войдите через форму входа.");
    }
    const hash = hashPassword(password);
    getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
    const refreshed = getDb().prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    const csrf = setAuthCookies(reply, refreshed);
    logLine(`volunteer_activate user_id=${user.id}`);
    return { ok: true, csrf };
  });

  app.post("/api/volunteer/logout", async (request, reply) => {
    const c = { path: "/", secure: config.cookieSecure };
    reply.clearCookie(config.cookieName, c);
    reply.clearCookie(config.csrfCookieName, c);
    return { ok: true };
  });

  app.get("/api/volunteer/me", { preHandler: [requireVolunteer] }, async (request) => {
    const uid = request.volunteer.id;
    const rows = getDb()
      .prepare(
        `SELECT e.id, e.title, e.date_start, e.date_end, e.location, e.status, ep.role_in_event
         FROM event_participants ep
         JOIN events e ON e.id = ep.event_id
         WHERE ep.user_id = ?
         ORDER BY e.date_start DESC`
      )
      .all(uid);
    const events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      date_start: asIso(r.date_start),
      date_end: r.date_end ? asIso(r.date_end) : null,
      location: r.location,
      status: r.status,
      role_in_event: r.role_in_event,
    }));
    return {
      full_name: request.volunteer.full_name,
      email: request.volunteer.email,
      phone: request.volunteer.phone,
      events,
    };
  });

  /* ---------- Admin API ---------- */
  app.get("/api/admin/me", { preHandler: [requireAdvisor] }, async (request) => {
    const u = request.advisor;
    const caps = request.advisorCaps;
    return {
      full_name: u.full_name,
      email: u.email,
      phone: u.phone ?? null,
      staff_position: u.staff_position ?? null,
      can_manage_applications: caps.can_manage_applications,
      can_manage_content: caps.can_manage_content,
    };
  });

  app.get("/api/admin/volunteers", { preHandler: [requireStaffApplications] }, async () => {
    const rows = getDb()
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.phone, u.created_at, u.password_hash,
                (SELECT COUNT(*) FROM event_participants ep WHERE ep.user_id = u.id) AS events_count
         FROM users u
         WHERE u.role = 'volunteer' AND u.is_active = 1
         ORDER BY u.full_name COLLATE NOCASE`
      )
      .all();
    return rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      email: r.email,
      phone: r.phone,
      created_at: asIso(r.created_at),
      has_password: !!(r.password_hash && String(r.password_hash).trim()),
      events_count: Number(r.events_count) || 0,
    }));
  });

  app.get("/api/admin/applications", { preHandler: [requireStaffApplications] }, async (request) => {
    const st = request.query.status_filter || request.query.status;
    let sql = "SELECT * FROM applications ORDER BY created_at DESC";
    const params = [];
    if (st === "pending" || st === "approved" || st === "rejected") {
      sql = "SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC";
      params.push(st);
    }
    const rows = getDb().prepare(sql).all(...params);
    return rows.map(mapApplication);
  });

  function mapApplication(r) {
    return {
      id: r.id,
      full_name: r.full_name,
      email: r.email,
      phone: r.phone,
      motivation: r.motivation,
      status: r.status,
      created_at: asIso(r.created_at),
    };
  }

  app.put("/api/admin/applications/:id/status", { preHandler: [requireStaffApplications] }, async (request, reply) => {
    const appId = Number(request.params.id);
    const status = request.body?.status;
    if (!["pending", "approved", "rejected"].includes(status)) {
      return sendDetail(reply, 400, "Недопустимый статус");
    }
    const app_row = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId);
    if (!app_row) return sendDetail(reply, 404, "Заявка не найдена");

    if (status === "approved") {
      const existing = getDb().prepare("SELECT * FROM users WHERE email = ?").get(app_row.email);
      if (existing) {
        if (existing.role === "advisor") {
          return sendDetail(reply, 400, "Email уже занят учётной записью советника");
        }
        getDb()
          .prepare(
            `UPDATE users SET full_name = ?, phone = ?, is_active = 1, role = 'volunteer' WHERE id = ?`
          )
          .run(app_row.full_name, app_row.phone, existing.id);
      } else {
        getDb()
          .prepare(
            `INSERT INTO users (full_name, email, phone, role, is_active, password_hash)
             VALUES (?, ?, ?, 'volunteer', 1, NULL)`
          )
          .run(app_row.full_name, app_row.email, app_row.phone);
      }
      logLine(`application_approved advisor_id=${request.advisor.id} application_id=${appId}`);
    } else if (status === "rejected") {
      logLine(`application_rejected advisor_id=${request.advisor.id} application_id=${appId}`);
    } else {
      logLine(`application_pending advisor_id=${request.advisor.id} application_id=${appId}`);
    }

    getDb().prepare("UPDATE applications SET status = ? WHERE id = ?").run(status, appId);
    const updated = getDb().prepare("SELECT * FROM applications WHERE id = ?").get(appId);
    return mapApplication(updated);
  });

  app.get("/api/admin/events", { preHandler: [requireStaffContent] }, async () => {
    const rows = getDb().prepare("SELECT * FROM events ORDER BY date_start DESC").all();
    return rows.map(mapEvent);
  });

  function mapEvent(ev) {
    return {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      date_start: asIso(ev.date_start),
      date_end: ev.date_end ? asIso(ev.date_end) : null,
      location: ev.location,
      status: ev.status,
    };
  }

  app.post("/api/admin/events", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const b = request.body || {};
    const title = String(b.title || "").trim();
    if (!b.date_start) return sendDetail(reply, 400, "Укажите дату и время начала.");
    if (title.length < 3 || title.length > 500) return sendDetail(reply, 400, "Название: от 3 до 500 символов.");

    let date_start;
    let date_end = null;
    try {
      date_start = normalizeIncomingDate(b.date_start);
    } catch {
      return sendDetail(reply, 400, "Неверная дата начала.");
    }
    if (b.date_end) {
      try {
        date_end = normalizeIncomingDate(b.date_end);
      } catch {
        return sendDetail(reply, 400, "Неверная дата окончания.");
      }
      if (new Date(date_end) < new Date(date_start)) {
        return sendDetail(reply, 400, "Окончание не может быть раньше начала.");
      }
    }

    const description = b.description != null ? String(b.description) : "";
    if (description.length > 10000) return sendDetail(reply, 400, "Описание: не более 10000 символов.");

    const locationRaw = b.location != null ? String(b.location) : "";
    if (locationRaw.length > 500) return sendDetail(reply, 400, "Место: не более 500 символов.");

    const status = b.status || "published";
    const r = getDb()
      .prepare(
        `INSERT INTO events (title, description, date_start, date_end, location, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        b.description != null && String(b.description).trim() !== "" ? description : null,
        date_start,
        date_end,
        locationRaw.trim() !== "" ? locationRaw.trim() : null,
        status,
        request.advisor.id
      );
    const id = Number(r.lastInsertRowid);
    logLine(`event_created advisor_id=${request.advisor.id} event_id=${id}`);
    const ev = getDb().prepare("SELECT * FROM events WHERE id = ?").get(id);
    return reply.code(201).send(mapEvent(ev));
  });

  function normalizeIncomingDate(d) {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) throw new Error("bad date");
    return x.toISOString();
  }

  app.put("/api/admin/events/:id", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const ev = getDb().prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    if (!ev) return sendDetail(reply, 404, "Мероприятие не найдено");
    const b = request.body || {};

    let mergedStart = ev.date_start;
    let mergedEnd = ev.date_end;
    try {
      if (b.date_start != null) mergedStart = normalizeIncomingDate(b.date_start);
      if (b.date_end !== undefined) {
        mergedEnd = b.date_end ? normalizeIncomingDate(b.date_end) : null;
      }
    } catch {
      return sendDetail(reply, 400, "Неверная дата.");
    }
    if (mergedEnd && new Date(mergedEnd) < new Date(mergedStart)) {
      return sendDetail(reply, 400, "Окончание не может быть раньше начала.");
    }

    const fields = [];
    const vals = [];
    if (b.title != null) {
      const t = String(b.title).trim();
      if (t.length < 3 || t.length > 500) return sendDetail(reply, 400, "Название: от 3 до 500 символов.");
      fields.push("title = ?");
      vals.push(t);
    }
    if (b.description !== undefined) {
      const d = b.description == null ? null : String(b.description);
      if (d && d.length > 10000) return sendDetail(reply, 400, "Описание: не более 10000 символов.");
      fields.push("description = ?");
      vals.push(d);
    }
    if (b.date_start != null) {
      fields.push("date_start = ?");
      vals.push(normalizeIncomingDate(b.date_start));
    }
    if (b.date_end !== undefined) {
      fields.push("date_end = ?");
      vals.push(b.date_end ? normalizeIncomingDate(b.date_end) : null);
    }
    if (b.location !== undefined) {
      const loc = b.location == null ? null : String(b.location);
      if (loc && loc.length > 500) return sendDetail(reply, 400, "Место: не более 500 символов.");
      fields.push("location = ?");
      vals.push(loc);
    }
    if (b.status != null) {
      fields.push("status = ?");
      vals.push(b.status);
    }
    if (fields.length) {
      vals.push(eventId);
      getDb().prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    }
    logLine(`event_updated advisor_id=${request.advisor.id} event_id=${eventId}`);
    const updated = getDb().prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    return mapEvent(updated);
  });

  app.delete("/api/admin/events/:id", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const ev = getDb().prepare("SELECT id FROM events WHERE id = ?").get(eventId);
    if (!ev) return sendDetail(reply, 404, "Мероприятие не найдено");
    getDb().prepare("DELETE FROM events WHERE id = ?").run(eventId);
    logLine(`event_deleted advisor_id=${request.advisor.id} event_id=${eventId}`);
    return reply.code(204).send();
  });

  app.get("/api/admin/events/:id/detail", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const ev = getDb().prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    if (!ev) return sendDetail(reply, 404, "Мероприятие не найдено");
    const parts = getDb()
      .prepare(
        `SELECT ep.id, ep.external_name, ep.role_in_event, u.full_name AS user_full_name
         FROM event_participants ep
         LEFT JOIN users u ON ep.user_id = u.id
         WHERE ep.event_id = ?`
      )
      .all(eventId);
    const participants = parts.map((p) => ({
      id: p.id,
      external_name: p.external_name,
      role_in_event: p.role_in_event,
      display_name: p.user_full_name || (p.external_name && String(p.external_name).trim()) || "Участник",
    }));
    return {
      ...mapEvent(ev),
      participants,
    };
  });

  app.post("/api/admin/events/:id/participants", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const ev = getDb().prepare("SELECT id FROM events WHERE id = ?").get(eventId);
    if (!ev) return sendDetail(reply, 404, "Мероприятие не найдено");
    const items = request.body?.items;
    if (!Array.isArray(items)) return sendDetail(reply, 400, "items: массив обязателен");
    let added = 0;
    const ins = getDb().prepare(
      `INSERT INTO event_participants (event_id, user_id, external_name, role_in_event)
       VALUES (?, NULL, ?, ?)`
    );
    for (const item of items) {
      let name = String(item.external_name || "").trim();
      let role =
        item.role != null && String(item.role).trim() !== ""
          ? String(item.role).trim()
          : "участник";
      if (name.includes(" — ") && (!item.role || String(item.role).trim() === "")) {
        const [a, b] = name.split(" — ");
        name = a.trim();
        role = (b && b.trim()) || "участник";
      }
      if (!name) continue;
      ins.run(eventId, name, role);
      added++;
    }
    logLine(`participants_added advisor_id=${request.advisor.id} event_id=${eventId} count=${added}`);
    return reply.code(201).send({ added });
  });

  app.get("/api/admin/blog", { preHandler: [requireStaffContent] }, async () => {
    const rows = getDb().prepare("SELECT * FROM blog_posts ORDER BY published_at DESC").all();
    return rows.map((r) => ({
      ...mapBlogPublic(r),
      is_visible: !!r.is_visible,
    }));
  });

  app.post("/api/admin/blog", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const b = request.body || {};
    const title = String(b.title || "").trim();
    const content = String(b.content || "");
    if (!title || !content.trim()) return sendDetail(reply, 400, "Заголовок и текст обязательны.");
    if (title.length < 3 || title.length > 300) return sendDetail(reply, 400, "Заголовок: от 3 до 300 символов.");
    if (content.trim().length < 10 || content.length > 200000) {
      return sendDetail(reply, 400, "Текст: от 10 до 200000 символов.");
    }
    const r = getDb()
      .prepare(
        `INSERT INTO blog_posts (title, content, author_id, is_visible, image_url)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(title, content, request.advisor.id, b.is_visible === false ? 0 : 1, b.image_url ?? null);
    const id = Number(r.lastInsertRowid);
    logLine(`blog_created advisor_id=${request.advisor.id} post_id=${id}`);
    return reply.code(201).send({ id });
  });

  app.put("/api/admin/blog/:id", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const postId = Number(request.params.id);
    const post = getDb().prepare("SELECT * FROM blog_posts WHERE id = ?").get(postId);
    if (!post) return sendDetail(reply, 404, "Публикация не найдена");
    const b = request.body || {};
    const fields = [];
    const vals = [];
    if (b.title != null) {
      const t = String(b.title).trim();
      if (t.length < 3 || t.length > 300) return sendDetail(reply, 400, "Заголовок: от 3 до 300 символов.");
      fields.push("title = ?");
      vals.push(t);
    }
    if (b.content != null) {
      const c = String(b.content);
      if (c.trim().length < 10 || c.length > 200000) {
        return sendDetail(reply, 400, "Текст: от 10 до 200000 символов.");
      }
      fields.push("content = ?");
      vals.push(c);
    }
    if (b.image_url !== undefined) {
      fields.push("image_url = ?");
      vals.push(b.image_url);
    }
    if (b.is_visible !== undefined) {
      fields.push("is_visible = ?");
      vals.push(b.is_visible ? 1 : 0);
    }
    if (fields.length) {
      vals.push(postId);
      getDb().prepare(`UPDATE blog_posts SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    }
    logLine(`blog_updated advisor_id=${request.advisor.id} post_id=${postId}`);
    return { ok: true };
  });

  app.delete("/api/admin/blog/:id", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const postId = Number(request.params.id);
    const post = getDb().prepare("SELECT id FROM blog_posts WHERE id = ?").get(postId);
    if (!post) return sendDetail(reply, 404, "Публикация не найдена");
    getDb().prepare("DELETE FROM blog_posts WHERE id = ?").run(postId);
    logLine(`blog_deleted advisor_id=${request.advisor.id} post_id=${postId}`);
    return reply.code(204).send();
  });

  app.post("/api/admin/upload", { preHandler: [requireStaffContent] }, async (request, reply) => {
    const data = await request.file();
    if (!data) return sendDetail(reply, 400, "Файл не указан");
    const filename = data.filename || "";
    const suffix = path.extname(filename).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(suffix)) {
      return sendDetail(reply, 400, "Допустимы изображения: jpg, png, gif, webp");
    }
    const buf = await data.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return sendDetail(reply, 400, "Файл больше 5 МБ");
    const name = `${crypto.randomBytes(16).toString("hex")}${suffix}`;
    const dest = path.join(config.uploadDir, name);
    fs.writeFileSync(dest, buf);
    const url = `/static/uploads/${name}`;
    logLine(`file_uploaded advisor_id=${request.advisor.id} path=${url}`);
    return { url };
  });

  app.get("/api/admin/stats", { preHandler: [requireAdvisor] }, async (request) => {
    const now = new Date().toISOString();
    const approved_volunteers = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'volunteer' AND is_active = 1`)
      .get().c;
    const active_events = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM events WHERE status = 'published'
         AND (date_end IS NULL OR date_end >= ?)`
      )
      .get(now).c;
    const blog_views = getDb()
      .prepare(`SELECT COALESCE(SUM(view_count), 0) AS s FROM blog_posts`)
      .get().s;
    const u = request.advisor;
    const caps = request.advisorCaps;
    return {
      advisor: {
        email: u.email,
        full_name: u.full_name,
        staff_position: u.staff_position ?? null,
        can_manage_applications: caps.can_manage_applications,
        can_manage_content: caps.can_manage_content,
      },
      approved_volunteers: Number(approved_volunteers),
      active_events: Number(active_events),
      blog_views: Number(blog_views),
    };
  });

  /* ---------- HTML & redirects ---------- */
  function htmlPage(relPath) {
    const abs = path.join(config.staticRoot, relPath);
    return (_req, reply) => {
      try {
        const html = fs.readFileSync(abs, "utf8");
        return reply.type("text/html; charset=utf-8").send(html);
      } catch {
        return reply.code(404).type("text/plain").send("Страница не найдена");
      }
    };
  }

  app.get("/staff", async (_req, reply) => reply.redirect("/staff.html", 302));
  app.get("/volunteer", async (_req, reply) => reply.redirect("/volunteer/login.html", 302));

  if (config.staffEntryPath) {
    app.get(`/${config.staffEntryPath}`, async (_req, reply) => reply.redirect("/admin/login.html", 302));
    logLine(`staff_entry_path enabled → /${config.staffEntryPath} → admin login`);
  }

  app.get("/admin/login", async (req, reply) => reply.redirect("/admin/login.html", 302));
  app.get("/admin/dashboard", async (req, reply) => reply.redirect("/admin/dashboard.html", 302));
  app.get("/admin", async (req, reply) => reply.redirect("/admin/login.html", 302));
  app.get("/", htmlPage("index.html"));
  app.get("/index.html", (_req, reply) => reply.redirect("/", 302));
  app.get("/about.html", htmlPage("about.html"));
  app.get("/how.html", htmlPage("how.html"));
  app.get("/events.html", htmlPage("events.html"));
  app.get("/materials.html", htmlPage("materials.html"));
  app.get("/college-news.html", htmlPage("college-news.html"));
  app.get("/faq.html", htmlPage("faq.html"));
  app.get("/apply.html", htmlPage("apply.html"));
  app.get("/event.html", htmlPage("event.html"));
  app.get("/staff.html", htmlPage("staff.html"));
  app.get("/volunteer/login.html", htmlPage("volunteer/login.html"));
  app.get("/volunteer/account.html", htmlPage("volunteer/account.html"));
  app.get("/admin/login.html", htmlPage("admin/login.html"));
  app.get("/admin/dashboard.html", htmlPage("admin/dashboard.html"));
  app.get("/admin/applications.html", htmlPage("admin/applications.html"));
  app.get("/admin/volunteers.html", htmlPage("admin/volunteers.html"));
  app.get("/admin/events.html", htmlPage("admin/events.html"));
  app.get("/admin/blog.html", htmlPage("admin/blog.html"));

  return app;
}
