import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { hashPassword, verifyPassword } from "./auth.js";
import { config, sqlitePath } from "./config.js";

let db;

export function getDb() {
  if (!db) throw new Error("БД не инициализирована");
  return db;
}

export function initDb() {
  const file = sqlitePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      role TEXT CHECK(role IN ('volunteer', 'advisor')) DEFAULT 'volunteer',
      is_active INTEGER DEFAULT 0,
      password_hash TEXT,
      staff_position TEXT,
      can_manage_applications INTEGER NOT NULL DEFAULT 1,
      can_manage_content INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      motivation TEXT,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      date_start TEXT NOT NULL,
      date_end TEXT,
      location TEXT,
      status TEXT CHECK(status IN ('draft', 'published', 'finished')) DEFAULT 'published',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      external_name TEXT,
      role_in_event TEXT DEFAULT 'участник',
      added_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      image_url TEXT,
      author_id INTEGER REFERENCES users(id),
      published_at TEXT DEFAULT (datetime('now')),
      is_visible INTEGER DEFAULT 1,
      view_count INTEGER DEFAULT 0
    );
  `);
  migrateUsersStaffColumns();
  return db;
}

/** Для БД, созданных до появления полей должностей и прав сотрудника. */
export function migrateUsersStaffColumns() {
  const d = getDb();
  const cols = d.prepare("PRAGMA table_info(users)").all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("staff_position")) {
    d.exec("ALTER TABLE users ADD COLUMN staff_position TEXT;");
  }
  if (!names.has("can_manage_applications")) {
    d.exec(
      "ALTER TABLE users ADD COLUMN can_manage_applications INTEGER NOT NULL DEFAULT 1;"
    );
  }
  if (!names.has("can_manage_content")) {
    d.exec("ALTER TABLE users ADD COLUMN can_manage_content INTEGER NOT NULL DEFAULT 1;");
  }
}

/**
 * Учётные записи сотрудников воспитательного отдела (роль advisor, разные права).
 * Пароль задаётся в .env: STAFF_ACCOUNTS_PASSWORD (или по умолчанию для демо).
 */
export function seedStaffAccounts() {
  const password = String(process.env.STAFF_ACCOUNTS_PASSWORD || "StaffDemo2026").trim();
  if (!password || password.length < 6) {
    console.warn("STAFF_ACCOUNTS_PASSWORD не задан или короче 6 символов — сид сотрудников пропущен");
    return;
  }
  const hash = hashPassword(password);

  const semikinaEmail =
    String(process.env.STAFF_SEMIKINA_EMAIL || "").trim() || "e.semikina@vup-oksei.example.org";
  const zhiganovaEmail =
    String(process.env.STAFF_ZHIGANOVA_EMAIL || "").trim() || "y.zhiganova@vup-oksei.example.org";
  const kustomovaEmail =
    String(process.env.STAFF_KUSTOMOVA_EMAIL || "").trim() || "k.kustomova@vup-oksei.example.org";

  const adminEmail = String(config.adminEmail || "").trim().toLowerCase();
  const rows = [
    {
      full_name: "Семикина Евгения Владимировна",
      email: semikinaEmail,
      phone: null,
      staff_position: "Социальный педагог",
      can_manage_applications: 1,
      can_manage_content: 0,
    },
    {
      full_name: "Жиганова Юлия Александровна",
      email: zhiganovaEmail,
      phone: null,
      staff_position:
        "Советник директора по воспитанию и взаимодействию с детскими общественными организациями",
      can_manage_applications: 0,
      can_manage_content: 1,
    },
    {
      full_name: "Кустумова Ксения Игоревна",
      email: kustomovaEmail,
      phone: null,
      staff_position: "Педагог-организатор",
      can_manage_applications: 1,
      can_manage_content: 1,
    },
  ];

  const insert = getDb().prepare(
    `INSERT INTO users (full_name, email, phone, role, is_active, password_hash, staff_position, can_manage_applications, can_manage_content)
     VALUES (@full_name, @email, @phone, 'advisor', 1, @password_hash, @staff_position, @can_manage_applications, @can_manage_content)`
  );

  let added = 0;
  let synced = 0;
  for (const row of rows) {
    const em = String(row.email).trim().toLowerCase();
    if (adminEmail && em === adminEmail) {
      console.warn(`seedStaffAccounts: email ${em} совпадает с ADMIN_EMAIL — запись пропущена`);
      continue;
    }
    const exists = getDb().prepare("SELECT id, password_hash FROM users WHERE email = ?").get(row.email);
    if (!exists) {
      insert.run({ ...row, password_hash: hash });
      added += 1;
      continue;
    }
    if (!exists.password_hash || !verifyPassword(password, exists.password_hash)) {
      getDb().prepare("UPDATE users SET password_hash = ?, is_active = 1, role = 'advisor' WHERE id = ?").run(
        hash,
        exists.id
      );
      synced += 1;
    }
  }
  if (added > 0) {
    console.info(
      `Добавлены учётные записи сотрудников (${added}): заявки / контент — см. staff_position и права в БД; пароль из STAFF_ACCOUNTS_PASSWORD`
    );
  }
  if (synced > 0) {
    console.info(`Обновлены пароли сотрудников (${synced}) из STAFF_ACCOUNTS_PASSWORD`);
  }
}

function upsertAdvisorAccount(email, password, fullName, extra = {}) {
  const em = String(email).trim().toLowerCase();
  const pw = String(password || "").trim();
  if (!em || !pw) return false;
  const hash = hashPassword(pw);
  const row = getDb().prepare("SELECT id, role, password_hash FROM users WHERE lower(email) = ?").get(em);
  if (!row) {
    getDb()
      .prepare(
        `INSERT INTO users (full_name, email, phone, role, is_active, password_hash, staff_position, can_manage_applications, can_manage_content)
         VALUES (?, ?, ?, 'advisor', 1, ?, ?, ?, ?)`
      )
      .run(
        fullName,
        em,
        extra.phone ?? null,
        hash,
        extra.staff_position ?? null,
        extra.can_manage_applications ?? 1,
        extra.can_manage_content ?? 1
      );
    return true;
  }
  if (row.role !== "advisor") return false;
  if (!row.password_hash || !verifyPassword(pw, row.password_hash)) {
    getDb()
      .prepare(
        `UPDATE users SET password_hash = ?, is_active = 1, role = 'advisor',
         staff_position = COALESCE(?, staff_position),
         can_manage_applications = COALESCE(?, can_manage_applications),
         can_manage_content = COALESCE(?, can_manage_content)
         WHERE id = ?`
      )
      .run(
        hash,
        extra.staff_position ?? null,
        extra.can_manage_applications ?? null,
        extra.can_manage_content ?? null,
        row.id
      );
    return true;
  }
  return false;
}

export function seedAdmin() {
  const email = String(config.adminEmail || "").trim().toLowerCase();
  const password = String(config.adminPassword || "").trim();
  if (!email || !password) {
    console.warn("ADMIN_EMAIL / ADMIN_PASSWORD не заданы — первичный советник не создан");
    return;
  }
  if (upsertAdvisorAccount(email, password, "Советник (начальный)")) {
    console.info(`Синхронизирован начальный советник ${email}`);
  }
}

/** Демо-вход advisor@example.com — всегда доступен по паролю из УЧЁТНЫЕ-ДАННЫЕ.md */
export function ensureDemoAdvisorLogin() {
  const email = "advisor@example.com";
  const password =
    config.adminEmail === email
      ? config.adminPassword
      : String(process.env.ADMIN_PASSWORD || "change_me_secure").trim();
  if (upsertAdvisorAccount(email, password, "Советник (начальный)")) {
    console.info(`Синхронизирован демо-советник ${email}`);
  }
}

/** Если в БД ещё нет мероприятий — добавляем несколько опубликованных (для демонстрации и проверки календаря). */
export function seedDemoEvents() {
  const c = getDb().prepare("SELECT COUNT(*) AS c FROM events").get().c;
  if (c > 0) return;

  const advisor = getDb().prepare("SELECT id FROM users WHERE role = 'advisor' LIMIT 1").get();
  const createdBy = advisor?.id ?? null;

  const now = new Date();
  const addDays = (n, h = 10, min = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    d.setHours(h, min, 0, 0);
    return d.toISOString();
  };

  const rows = [
    {
      title: "Зимний сбор для приюта и разбор гардероба",
      description:
        "Сбор тёплых вещей, корма и средств гигиены. Встреча у главного входа, дальше — согласованная доставка в приют. Нужны волонтёры для сортировки и фотоотчёта. Кураторы из воспитательного отдела на связи в чате.",
      date_start: addDays(5, 11, 0),
      date_end: addDays(5, 15, 0),
      location: "Главный корпус колледжа, холл первого этажа",
    },
    {
      title: "Субботник на территории кампуса",
      description:
        "Уборка скверика у колледжа, сбор мусора, мелкий ремонт скамеек. Форма — удобная одежда и перчатки, инвентарь выдадим на месте. Запись по спискам до пятницы.",
      date_start: addDays(12, 9, 30),
      date_end: addDays(12, 13, 0),
      location: "Территория ГАПОУ ОКЭИ, сбор у актового зала",
    },
    {
      title: "Профориентация: «Волонтёрство в резюме»",
      description:
        "Открытая встреча с выпускниками и партнёрами: как оформить часы волонтёрства, справки и участие в конкурсах. Подойдёт тем, кто только подал заявку.",
      date_start: addDays(18, 14, 0),
      date_end: addDays(18, 16, 0),
      location: "Актовый зал",
    },
    {
      title: "Экологический выезд: раздельный сбор и экотропа",
      description:
        "Выезд в парк города (маршрут согласован). Задачи — раздельный сбор, раздача листовок посетителям, фиксация результатов. Обязательна регистрация для страховки.",
      date_start: addDays(25, 8, 0),
      date_end: addDays(25, 14, 30),
      location: "Сбор у главного входа колледжа, выезд автобусом",
    },
  ];

  const insert = getDb().prepare(
    `INSERT INTO events (title, description, date_start, date_end, location, status, created_by)
     VALUES (@title, @description, @date_start, @date_end, @location, 'published', @created_by)`
  );

  for (const e of rows) {
    insert.run({ ...e, created_by: createdBy });
  }

  console.info(`Добавлены демонстрационные события: ${rows.length} шт.`);
}

/** Праздничные мероприятия 1 и 9 мая («Вальс Победы»). Добавляются по уникальному названию, если записи ещё нет. */
export function seedMayVictoryEvents() {
  const advisor = getDb().prepare("SELECT id FROM users WHERE role = 'advisor' LIMIT 1").get();
  const createdBy = advisor?.id ?? null;

  const year = new Date().getFullYear();
  const iso = (monthIndex, day, h, min) => {
    const d = new Date(year, monthIndex, day, h, min, 0, 0);
    return d.toISOString();
  };

  const rows = [
    {
      title: "1 мая — весенняя программа и репетиция «Вальс Победы»",
      description:
        "Праздничная программа ко Дню весны и труда, знакомство с хореографией общего номера «Вальс Победы» перед 9 мая. Участие добровольное; для выступления нужна запись у куратора воспитательного отдела. Форма одежды — торжественно-деловая или по указанию организаторов.",
      date_start: iso(4, 1, 11, 0),
      date_end: iso(4, 1, 14, 30),
      location: "ГАПОУ ОКЭИ, актовый зал / холл главного корпуса",
    },
    {
      title: "9 мая — День Победы: «Вальс Победы» и памятная программа",
      description:
        "Торжественная программа ко Дню Победы: выступление с «Вальсом Победы», почётные гости и минута памяти. Волонтёры воспитательного отдела помогают со сценарием, встречей участников и организацией возложения цветов (по согласованию с администрацией). Точное время уточняйте в анонсе за несколько дней.",
      date_start: iso(4, 9, 10, 0),
      date_end: iso(4, 9, 13, 0),
      location: "ГАПОУ ОКЭИ, территория / актовый зал (расписание уточняется)",
    },
  ];

  const existsByTitle = getDb().prepare("SELECT 1 FROM events WHERE title = ?");
  const insert = getDb().prepare(
    `INSERT INTO events (title, description, date_start, date_end, location, status, created_by)
     VALUES (@title, @description, @date_start, @date_end, @location, 'published', @created_by)`
  );

  let added = 0;
  for (const e of rows) {
    if (existsByTitle.get(e.title)) continue;
    insert.run({ ...e, created_by: createdBy });
    added += 1;
  }

  if (added > 0) {
    console.info(`Добавлены мероприятия 1 и 9 мая («Вальс Победы»): ${added} шт.`);
  }
}

/** Демонстрационные публикации для ленты «Материалы». Новые заголовки добавляются при старте сервера, если такой записи ещё нет (без дубликатов). */
export function seedDemoBlogPosts() {
  const advisor = getDb().prepare("SELECT id FROM users WHERE role = 'advisor' LIMIT 1").get();
  const authorId = advisor?.id ?? null;

  const daysAgoIso = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  };

  /** Иллюстрации из ленты новостей официального сайта колледжа (https://oksei.ru/news). */
  const OKSEI_NEWS_COVERS = [
    "https://oksei.ru/public/img/news/btM9NMBKQ-Rmo0DjspqbhdFTlVXx-DnlqyK0C6C5liCl-9kWAR_NnDYEs8mF14U6gZIUIIB2-86HIBjjiVEOxhyT.jpg",
    "https://oksei.ru/public/img/news/5MyL4oP5ARNHkdUMo2HcVa2dXl8w-n3OgvN_988mVaNdV5i7MvmRYitaxtK76JvaRkFtzgSl4fkJF34kQiWiAWvA.jpg",
    "https://oksei.ru/public/img/news/HaSKXsuANBFr_iW1tPydra8JfxkjuwyQfnouqN4qlnXzwBdw3RVcddaKEcnJ2jJrjKdLEiNVCeenNF93pBoM8ciZ.jpg",
    "https://oksei.ru/public/img/news/Jjg9PnyNTB3EuiX9juuvENpBF0dCJ5TLRkZpbvD25E9TFbcN6GtnohHCneT0dD3nI3OV-rLze7NMASChJUGz0S10.jpg",
    "https://oksei.ru/public/img/news/z3-_VEce8dv--iebnUEQhjZIenBDGFiyieOOzpizL1sQomn-DRW5AptVX777N7oPk9Dj40dHQK1Z8CNPXLJ5boU9.jpg",
    "https://oksei.ru/public/img/news/R34Jk2I8cqu7H96u9ZqU1mD00WXfEFYRD20ZZi1QOqh8zOp6Ba2taGIcYL84nZFwwky8mhL5x2p-vNzEBtCV5zgr.jpg",
    "https://oksei.ru/public/img/news/pWkCUCfSx4dMxK9nhEg1Ip5tKqwuLvqhfhUVVCuYtjcHNby6NBw4UZtqEBRO8Xm5oUmtO_iwzNjS2k7Ql2QEPL3T.jpg",
    "https://oksei.ru/public/img/news/2joohsBFq5x0a21Nnu_TY2Zshww%26fn.png",
    "https://oksei.ru/public/img/news/FjoiahJQ9QjL9LQ7TRdiq4PoofQ%26fn.png",
  ];

  const posts = [
    {
      title: "Добро пожаловать в ленту воспитательного отдела",
      published_at: daysAgoIso(21),
      content: `Здесь мы публикуем короткие отчёты об акциях, памятки для волонтёров и напоминания о сроках.

Если вы только подали заявку — следите за разделом «События»: там анонсы с датой, местом и контактом куратора. После одобрения заявки у вас появится доступ к личному кабинету волонтёра.

Вопросы по часам, справкам и участию в мероприятиях собраны на странице «Частые вопросы». При необходимости обращайтесь к советникам отдела в учебное время.`,
    },
    {
      title: "Как фиксируются часы и где взять справку о волонтёрстве",
      published_at: daysAgoIso(14),
      content: `Участие в официальных акциях колледжа фиксируется через списки на мероприятиях и при необходимости — во внутренних учётах воспитательного отдела.

Перед выездом проверьте регистрацию в анонсе события: для части выездов нужна предварительная запись. После акции сохраняйте подтверждение от куратора — это пригодится для портфолио и конкурсов.

Точный порядок выдачи справок и сроки уточняйте у своего куратора группы или в воспитательном отделе: они зависят от учебного календаря и формата мероприятия.`,
    },
    {
      title: "Зимний сбор для приюта: что уже сделано и как помочь дальше",
      published_at: daysAgoIso(9),
      content: `Благодаря участникам движения собраны тёплые вещи и часть средств на закупку корма. Часть партии уже передана партнёрам; фотоотчёт будет размещён после согласования с приютом.

Если вы не успели присоединиться к сбору в холле — напишите советнику отдела: иногда нужны волонтёры для доставки или сортировки на выходных.

Следующие акции появятся в календаре на главной странице раздела «События». Не забудьте отметить участие заранее, где это требуется.`,
    },
    {
      title: "Субботник на территории кампуса: итоги и благодарность участникам",
      published_at: daysAgoIso(17),
      content: `За прошедший субботник от коллективов и волонтёров собран объёмный мешковый мусор, приведены в порядок клумбы у входа и проверены контейнеры для раздельного сбора.

Отдельное спасибо тем, кто помог с инвентарём и координацией на площадке. Фото для отчёта направлены в воспитательный отдел.

Напоминаем: удобная одежда и перчатки обязательны на подобных работах; при аллергии на пыль сообщайте куратору заранее.`,
    },
    {
      title: "Выездные акции: безопасность и страховка — короткая памятка",
      published_at: daysAgoIso(12),
      content: `Перед автобусными выездами и городскими маршрутами регистрируйтесь по спискам до указанного срока — это нужно для страховки и связи в дороге.

На площадке выполняйте указания ответственного и партнёров организации; не отходите один без предупреждения куратора.

При ухудшении самочувствия сообщите об этом сразу — здоровье важнее продолжения маршрута.`,
    },
    {
      title: "Встреча «Волонтёрство в резюме»: материалы и записи для тех, кто не смог прийти",
      published_at: daysAgoIso(10),
      content: `На встрече обсуждали оформление часов волонтёрства, примеры формулировок для резюме и участие в профильных конкурсах.

Тезисы и рекомендованные формулировки можно запросить у советника воспитательного отдела после объявления на стенде или по официальным каналам колледжа.

Следующая открытая встреча появится в анонсах раздела «События» — следите за датами.`,
    },
    {
      title: "Экологический выезд в парк: как записаться и что взять с собой",
      published_at: daysAgoIso(6),
      content: `Сбор у главного входа — не опаздывайте: автобус отправляется по расписанию. Возьмите воду, головной убор по погоде и удобную обувь.

Перчатки и пакеты для сортировки выдаём на месте; при необходимости есть запас масок по регламенту площадки.

После акции списки участников фиксируются ответственным — сохраните контакт куратора из анонса события.`,
    },
    {
      title: "График консультаций воспитательного отдела на модуль",
      published_at: daysAgoIso(5),
      content: `Часы приёма советников по вопросам волонтёрства и документов обновляются каждый модуль и вывешиваются на информационном стенде отдела.

Срочные вопросы по выездам лучше закрывать заранее в учебные дни — в день мероприятия штат может быть на площадке.

Актуальные телефоны колледжа указаны на официальном сайте ОКЭИ в разделе контактов.`,
    },
    {
      title: "Благодарность волонтёрам за участие в городских акциях партнёров",
      published_at: daysAgoIso(4),
      content: `Партнёрские организации передали благодарственные письма за помощь на массовых мероприятиях и работу с посетителями.

Грамоты и отметки по возможности передаём через кураторов групп — уточняйте у своего классного руководителя или советника.

Мы гордимся тем, что студенты ОКЭИ стабильно откликаются на такие задачи.`,
    },
    {
      title: "Напоминание: как не пропустить анонс мероприятия",
      published_at: daysAgoIso(3),
      content: `Все официальные акции колледжа публикуются в разделе «События» на этом сайте с датой, временем и местом сбора.

Если используете групповые чаты — проверяйте информацию и там, и на сайте: при расхождении ориентируйтесь на анонс на платформе или уточняйте у советника.

Для части выездов действует лимит мест — регистрация в анонсе обязательна.`,
    },
    {
      title: "Идеи для новых акций: предложите тему через советника",
      published_at: daysAgoIso(1),
      content: `Воспитательный отдел рассматривает предложения студентов по социальным и экологическим инициативам в рамках правил безопасности и партнёрских возможностей.

Кратко опишите идею, ориентировочные сроки и состав помощников — обсудим на планёрке и вернёмся с обратной связью.

Уже реализованные форматы — сборы гуманитарной помощи, субботники, профориентация и экопросвет на улицах города.`,
    },
  ];

  posts.forEach((p, i) => {
    p.image_url = OKSEI_NEWS_COVERS[i % OKSEI_NEWS_COVERS.length];
  });

  const existsByTitle = getDb().prepare("SELECT 1 FROM blog_posts WHERE title = ?");
  const insert = getDb().prepare(
    `INSERT INTO blog_posts (title, content, author_id, is_visible, published_at, image_url)
     VALUES (@title, @content, @author_id, 1, @published_at, @image_url)`
  );

  const patchCoverIfEmpty = getDb().prepare(
    `UPDATE blog_posts SET image_url = @image_url
     WHERE title = @title AND (image_url IS NULL OR TRIM(COALESCE(image_url, '')) = '')`
  );

  let added = 0;
  for (const p of posts) {
    if (existsByTitle.get(p.title)) continue;
    insert.run({ ...p, author_id: authorId });
    added += 1;
  }

  let covers = 0;
  for (const p of posts) {
    const r = patchCoverIfEmpty.run({ title: p.title, image_url: p.image_url });
    covers += r.changes;
  }

  if (added > 0) {
    console.info(`Добавлены демонстрационные записи блога: ${added} шт.`);
  }
  if (covers > 0) {
    console.info(`Добавлены обложки материалов (фото с oksei.ru/news): ${covers} шт.`);
  }
}

/** Демонстрационные волонтёры (пароль см. VOLUNTEER_DEMO_PASSWORD в .env). */
export function seedDemoVolunteers() {
  const demoPw = process.env.VOLUNTEER_DEMO_PASSWORD || "VolunteerDemo2026";
  const hash = hashPassword(demoPw);
  const rows = [
    {
      full_name: "Иванова Мария Сергеевна",
      email: "volunteer1.demo@example.com",
      phone: "+79001234567",
    },
    {
      full_name: "Петров Алексей Дмитриевич",
      email: "volunteer2.demo@example.com",
      phone: "+79007654321",
    },
  ];

  const insert = getDb().prepare(
    `INSERT INTO users (full_name, email, phone, role, is_active, password_hash)
     VALUES (@full_name, @email, @phone, 'volunteer', 1, @password_hash)`
  );

  let added = 0;
  for (const row of rows) {
    const exists = getDb().prepare("SELECT id FROM users WHERE email = ?").get(row.email);
    if (exists) continue;
    insert.run({ ...row, password_hash: hash });
    added += 1;
  }

  if (added > 0) {
    console.info(`Добавлены демонстрационные волонтёры: ${added} чел. (пароль из VOLUNTEER_DEMO_PASSWORD)`);
  }

  const demoEmails = rows.map((r) => r.email);
  const upd = getDb().prepare("UPDATE users SET password_hash = ? WHERE email = ? AND role = 'volunteer' AND password_hash IS NULL");
  let patched = 0;
  for (const email of demoEmails) {
    const r = upd.run(hash, email);
    if (r.changes) patched += r.changes;
  }
  if (patched > 0) {
    console.info(`Обновлён пароль для ${patched} демо-волонтёров без пароля (VOLUNTEER_DEMO_PASSWORD)`);
  }
}

/** Связать демо-волонтёра с первым мероприятием — чтобы в кабинете был пример списка. */
export function seedDemoVolunteerParticipation() {
  const v = getDb().prepare("SELECT id FROM users WHERE email = ?").get("volunteer1.demo@example.com");
  const ev = getDb().prepare("SELECT id FROM events ORDER BY date_start ASC LIMIT 1").get();
  if (!v || !ev) return;
  const exists = getDb()
    .prepare("SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ?")
    .get(ev.id, v.id);
  if (exists) return;
  getDb()
    .prepare(
      `INSERT INTO event_participants (event_id, user_id, external_name, role_in_event)
       VALUES (?, ?, NULL, ?)`
    )
    .run(ev.id, v.id, "волонтёр");
  console.info("Добавлена демонстрационная запись участника мероприятия для volunteer1.demo@example.com");
}
