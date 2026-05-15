import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/** На Railway и аналогах за reverse proxy (HTTPS, корректный IP). */
const onRailway = Boolean(
  String(process.env.RAILWAY_ENVIRONMENT || "").trim() ||
    String(process.env.RAILWAY_PROJECT_ID || "").trim()
);

export const config = {
  root: ROOT,
  staticRoot: path.join(ROOT, "static"),
  uploadDir: path.join(ROOT, "static", "uploads"),
  databaseUrl: process.env.DATABASE_URL || "sqlite:///./data/app.db",
  secretKey: process.env.SECRET_KEY || "dev-secret-change-in-production-min-32-characters-long",
  jwtAlgorithm: process.env.JWT_ALGORITHM || "HS256",
  accessTokenExpireMinutes: Number(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || 43200),
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  cookieName: process.env.COOKIE_NAME || "access_token",
  csrfCookieName: process.env.CSRF_COOKIE_NAME || "csrf_token",
  logFile: process.env.LOG_FILE || "logs/app.log",
  /** За HTTPS (Railway): обязательно для работы cookies в браузере. */
  cookieSecure:
    String(process.env.COOKIE_SECURE || "").trim() === "1" ||
    (String(process.env.COOKIE_SECURE || "").trim() !== "0" && onRailway),
  trustProxy:
    String(process.env.TRUST_PROXY || "").trim() === "1" ||
    (String(process.env.TRUST_PROXY || "").trim() !== "0" && onRailway),
  /**
   * Один сегмент URL без слэшей: открывает страницу входа советника по адресу /{значение}.
   * В интерфейсе сайта ссылка не показывается — знают только сотрудники.
   * Пусто в .env — для разработки можно заходить напрямую на /admin/login.html.
   */
  staffEntryPath: parseStaffEntryPath(process.env.STAFF_ENTRY_PATH),
  /** Опционально: сервисный ключ приложения VK для подгрузки стены сообщества (см. https://dev.vk.com) */
  vkAccessToken: String(process.env.VK_ACCESS_TOKEN || "").trim(),
  vkGroupDomain: String(process.env.VK_GROUP_DOMAIN || "gapou_okei").trim() || "gapou_okei",
  vkWallCount: Math.min(30, Math.max(1, Number(process.env.VK_WALL_COUNT || 12))),
  vkWallCacheSeconds: Math.min(3600, Math.max(60, Number(process.env.VK_WALL_CACHE_SECONDS || 600))),
};

function parseStaffEntryPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const seg = s.replace(/^\/+|\/+$/g, "");
  if (seg.includes("/")) {
    console.warn("STAFF_ENTRY_PATH: укажите один сегмент без «/», например advisor-x9k2m7… — игнорируется");
    return "";
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(seg)) {
    console.warn(
      "STAFF_ENTRY_PATH: нужна строка 16–128 символов [a-zA-Z0-9_-] для достаточной длины секрета — игнорируется"
    );
    return "";
  }
  return seg;
}

export function sqlitePath() {
  const u = config.databaseUrl;
  if (u.startsWith("sqlite:///./")) {
    return path.join(ROOT, u.replace("sqlite:///./", ""));
  }
  if (u.startsWith("sqlite:///")) {
    return u.replace("sqlite:///", "");
  }
  return path.join(ROOT, "data", "app.db");
}
