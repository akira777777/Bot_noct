const path = require("path");
const {
  loadEnvFiles,
  optionalString,
  optionalInteger,
  optionalBoolean,
  optionalUrlString,
  emitConfigWarning,
} = require("./helpers");

loadEnvFiles();

// URL validation is centralized in src/config/helpers.js::optionalUrlString.
const NODE_ENV = optionalString("NODE_ENV") || "development";
const isProduction = NODE_ENV === "production";
const BOT_ENABLED = optionalBoolean("BOT_ENABLED", true);
const ADMIN_ID = optionalInteger("ADMIN_ID", null);
const DB_PATH =
  optionalString("DB_PATH", ["DATABASE_PATH"]) ||
  path.join(process.cwd(), "data", "bot.sqlite");
const PORT = optionalInteger("PORT", 3000);
const API_SECRET = optionalString("API_SECRET");
const CORS_ORIGIN = optionalString("CORS_ORIGIN", ["ALLOWED_ORIGINS"]);
const WEB_APP_URL = optionalUrlString("WEB_APP_URL", ["WEBAPP_URL"]);
const API_COMPRESSION = optionalBoolean("API_COMPRESSION", true);
const LOG_LEVEL =
  optionalString("LOG_LEVEL") || (isProduction ? "info" : "debug");
const LOG_FORMAT =
  optionalString("LOG_FORMAT") || (isProduction ? "json" : "pretty");
const MEMORY_LIMIT_WARN = optionalInteger("MEMORY_LIMIT_WARN", 512);
const MEMORY_LIMIT_CRITICAL = optionalInteger("MEMORY_LIMIT_CRITICAL", 768);
const TELEGRAM_STARTUP_TIMEOUT_MS = optionalInteger(
  "TELEGRAM_STARTUP_TIMEOUT_MS",
  15000,
);
const ALLOW_BOT_LAUNCH_FAILURE = optionalBoolean(
  "ALLOW_BOT_LAUNCH_FAILURE",
  false,
);
const APP_VERSION = optionalString("APP_VERSION", ["npm_package_version"]) || "1.0.0";
// AI via Vercel AI Gateway. Auth options:
//   • OIDC (recommended): run `vercel link` then `vercel env pull`
//   • Manual key: set AI_GATEWAY_API_KEY from the Vercel dashboard
// On Vercel, VERCEL_OIDC_TOKEN is auto-provisioned. Model uses "provider/model" format: "anthropic/claude-haiku-4.5"
const AI_GATEWAY_API_KEY = optionalString("AI_GATEWAY_API_KEY");
const VERCEL_OIDC_TOKEN = optionalString("VERCEL_OIDC_TOKEN");
const AI_MODEL = optionalString("AI_MODEL") || "anthropic/claude-haiku-4.5";
const AI_ENABLED = Boolean(AI_GATEWAY_API_KEY || VERCEL_OIDC_TOKEN);
const REDIS_URL = optionalString("REDIS_URL");
const REDIS_HOST = optionalString("REDIS_HOST") || "localhost";
const REDIS_PORT = optionalInteger("REDIS_PORT", 6379);
const REDIS_PASSWORD = optionalString("REDIS_PASSWORD");
const REDIS_DB = optionalInteger("REDIS_DB", 0);
const REDIS_CONFIG = Object.freeze({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD || undefined,
  db: REDIS_DB,
});
const CACHE_TTL = Object.freeze({
  SESSION: optionalInteger("CACHE_TTL_SESSION", 3600, ["REDIS_TTL_SESSION"]),
  CATALOG: optionalInteger("CACHE_TTL_CATALOG", 300, ["REDIS_TTL_CATALOG"]),
  PRODUCT: optionalInteger("CACHE_TTL_PRODUCT", 600, ["REDIS_TTL_PRODUCT"]),
  STATS: optionalInteger("CACHE_TTL_STATS", 60, ["REDIS_TTL_STATS"]),
  USER: optionalInteger("CACHE_TTL_USER", 1800, ["REDIS_TTL_USER"]),
  LEAD: optionalInteger("CACHE_TTL_LEAD", 300, ["REDIS_TTL_LEAD"]),
  CONVERSATION: optionalInteger("CACHE_TTL_CONVERSATION", 900, [
    "REDIS_TTL_CONVERSATION",
  ]),
});

if (ADMIN_ID !== null && (Number.isNaN(ADMIN_ID) || ADMIN_ID <= 0)) {
  throw new Error("ADMIN_ID must be a positive integer");
}

if (isProduction && !API_SECRET) {
  emitConfigWarning(
    "API_SECRET is not set in production; admin API endpoints are disabled",
  );
}

if (isProduction && !CORS_ORIGIN) {
  emitConfigWarning("CORS_ORIGIN is not set in production; all origins are allowed");
}

module.exports = {
  NODE_ENV,
  isProduction,
  BOT_ENABLED,
  AI_GATEWAY_API_KEY,
  AI_MODEL,
  AI_ENABLED,
  ADMIN_ID,
  DB_PATH,
  PORT,
  API_SECRET,
  CORS_ORIGIN,
  WEB_APP_URL,
  API_COMPRESSION,
  LOG_LEVEL,
  LOG_FORMAT,
  MEMORY_LIMIT_WARN,
  MEMORY_LIMIT_CRITICAL,
  TELEGRAM_STARTUP_TIMEOUT_MS,
  ALLOW_BOT_LAUNCH_FAILURE,
  APP_VERSION,
  REDIS_URL,
  REDIS_CONFIG,
  CACHE_TTL,
};
