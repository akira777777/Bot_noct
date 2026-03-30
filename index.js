/**
 * Bot_noct - Telegram Bot Application
 * Enhanced version with Redis caching, Bull queues, and advanced monitoring
 */
const { createDatabase } = require("./src/db/sqlite");
const { createRepositories } = require("./src/repositories");
const { createBot } = require("./src/bot");
const {
  BOT_ENABLED,
  ADMIN_ID,
  PORT,
  API_SECRET,
  CORS_ORIGIN,
  WEB_APP_URL,
  isProduction,
  NODE_ENV,
  API_COMPRESSION,
  MEMORY_LIMIT_WARN,
  MEMORY_LIMIT_CRITICAL,
  REDIS_CONFIG,
} = require("./src/config/env");
const { resolveBotConfig } = require("./src/config/bot");
const { createWebServer } = require("./src/web/server");
const {
  createConversationService,
} = require("./src/services/conversation-service");
const { createSchedulerService } = require("./src/services/scheduler-service");
const {
  initCacheService,
} = require("./src/services/cache-service");
const {
  initQueueService,
  closeQueueService,
  processMessageJobs,
} = require("./src/services/queue-service");
const {
  createShutdownHandler,
  createMemoryMonitor,
} = require("./src/utils/graceful-shutdown");
const {
  launchTelegramRuntime,
} = require("./src/services/telegram-runtime");
const { inspect } = require("node:util");
// Import logger with fallback to console if module fails
let log;
try {
  const loggerModule = require("./src/utils/logger-enhanced");
  log = loggerModule.log || loggerModule;
  if (!log || !log.info) {
    throw new Error("Logger module did not export valid log object");
  }
} catch (err) {
  console.error(
    "Failed to load logger-enhanced, using console fallback:",
    err.message,
  );
  log = {
    info: (...args) => console.log("[INFO]", ...args),
    warn: (...args) => console.warn("[WARN]", ...args),
    error: (...args) => console.error("[ERROR]", ...args),
    debug: (...args) => console.debug("[DEBUG]", ...args),
    fatal: (...args) => console.error("[FATAL]", ...args),
  };
}

// Application resources
let appResources = null;
let teardownInProgress = false;

function formatError(error) {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function serializeErrorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (typeof error === "object" && error !== null) {
    return { inspected: inspect(error, { depth: 4, breakLength: 120 }) };
  }

  return { value: String(error) };
}

function startHttpServer(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once("error", reject);
  });
}

function shouldUseWebhookMode(webhookDomain) {
  if (!webhookDomain) {
    return false;
  }
  const normalized = String(webhookDomain).trim().toLowerCase();
  // Guard against placeholder values that break local bot updates.
  if (
    normalized.includes("your-app.onrender.com") ||
    normalized.includes("example.com")
  ) {
    return false;
  }
  return true;
}

async function teardown(resources, reason) {
  if (!resources) {
    return;
  }

  if (teardownInProgress) {
    log.warn("Teardown already in progress", { reason });
    return;
  }

  teardownInProgress = true;

  log.info("Starting application teardown", { reason });

  // Clear timers
  if (resources.sessionCleanupTimer) {
    clearInterval(resources.sessionCleanupTimer);
  }
  if (resources.schedulerTimers) {
    resources.schedulerTimers.forEach((t) => clearInterval(t));
  }

  // Stop memory monitor
  if (resources.memoryMonitor) {
    resources.memoryMonitor.stop();
  }

  // Stop bot
  if (resources.botLaunched && resources.bot) {
    try {
      resources.bot.stop(reason);
      log.info("Bot stopped");
    } catch (error) {
      log.error("Error stopping bot", { error: formatError(error) });
    }
  }

  // Close HTTP server
  if (resources.httpServer) {
    try {
      await new Promise((resolve, reject) => {
        resources.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      log.info("HTTP server closed");
    } catch (error) {
      log.error("Error closing HTTP server", { error: formatError(error) });
    }
  }

  // Close queue service
  if (resources.queueService) {
    try {
      await closeQueueService();
      log.info("Queue service closed");
    } catch (error) {
      log.error("Error closing queue service", { error: formatError(error) });
    }
  }

  // Close cache service
  if (resources.cacheService) {
    try {
      await resources.cacheService.disconnect();
      log.info("Cache service closed");
    } catch (error) {
      log.error("Error closing cache service", { error: formatError(error) });
    }
  }

  // Close database
  if (resources.db) {
    try {
      resources.db.close();
      log.info("Database closed");
    } catch (error) {
      log.error("Error closing database", { error: formatError(error) });
    }
  }

  log.info("Application teardown complete");
  teardownInProgress = false;
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function startSessionCleanup(repos) {
  const timer = setInterval(() => {
    try {
      repos.sessions.clearExpired();
      log.debug("Session cleanup completed");
    } catch (error) {
      log.error("Session cleanup failed", { error: formatError(error) });
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}

function startScheduledTasks(scheduler) {
  const timers = [];

  const draftReminderTimer = setInterval(
    () => {
      scheduler
        .sendDraftReminders()
        .catch((err) =>
          log.error("Draft reminders check failed", { error: err.message }),
        );
    },
    5 * 60 * 1000,
  );
  draftReminderTimer.unref();
  timers.push(draftReminderTimer);

  // Check stale leads every 30 minutes
  const staleTimer = setInterval(
    () => {
      scheduler
        .checkStaleLeads()
        .catch((err) =>
          log.error("Stale leads check failed", { error: err.message }),
        );
    },
    30 * 60 * 1000,
  );
  staleTimer.unref();
  timers.push(staleTimer);

  // Send follow-ups every hour
  const followUpTimer = setInterval(
    () => {
      scheduler
        .sendFollowUps()
        .catch((err) =>
          log.error("Follow-ups check failed", { error: err.message }),
        );
    },
    60 * 60 * 1000,
  );
  followUpTimer.unref();
  timers.push(followUpTimer);

  return timers;
}

async function bootstrap() {
  log.info("Starting application bootstrap", {
    environment: NODE_ENV,
    nodeVersion: process.version,
  });
  const runtimeConfig = {
    BOT_ENABLED,
    ADMIN_ID,
    PORT,
    API_SECRET,
    CORS_ORIGIN,
    WEB_APP_URL,
    isProduction,
    NODE_ENV,
    API_COMPRESSION,
    MEMORY_LIMIT_WARN,
    MEMORY_LIMIT_CRITICAL,
    REDIS_CONFIG,
  };
  const botConfig = resolveBotConfig(runtimeConfig);

  if (BOT_ENABLED && !Number.isInteger(ADMIN_ID)) {
    throw new Error("ADMIN_ID must be set when BOT_ENABLED=true");
  }

  // Initialize database
  const db = createDatabase();
  log.info("Database initialized");

  // Initialize repositories
  const repos = createRepositories(db);

  // Initialize cache service (Redis with in-memory fallback)
  let cacheService = null;
  try {
    cacheService = await initCacheService(REDIS_CONFIG);
    log.info("Cache service initialized", {
      mode: cacheService.getMode(),
    });
  } catch (error) {
    log.warn("Cache service initialization failed, continuing without cache", {
      error: formatError(error),
    });
  }

  // Initialize queue service (Bull)
  let queueService = null;
  try {
    await initQueueService(REDIS_CONFIG);
    queueService = require("./src/services/queue-service");
    log.info("Queue service initialized");
  } catch (error) {
    log.warn("Queue service initialization failed, continuing without queues", {
      error: formatError(error),
    });
  }

  // Create bot only when Telegram runtime is enabled
  let bot = null;
  if (botConfig) {
    bot = createBot({
      db,
      repos,
      botToken: botConfig.BOT_TOKEN,
      adminId: ADMIN_ID,
      webAppUrl: WEB_APP_URL,
      cacheService,
      queueService,
    });
  } else {
    log.info("BOT_ENABLED=false, skipping Telegram bot initialization");
  }

  // Setup queue processors with bot instance
  if (queueService && bot?.telegram?.sendMessage) {
    // Process outgoing messages from queue
    processMessageJobs(async (chatId, text, options) => {
      try {
        await bot.telegram.sendMessage(chatId, text, options);
        return { success: true };
      } catch (error) {
        log.error("Failed to send queued message", {
          chatId,
          error: formatError(error),
        });
        throw error;
      }
    });
  } else if (queueService) {
    log.info(
      "Queue service initialized without Telegram runtime; message jobs are not registered",
    );
  }

  // Create services
  const conversationService = createConversationService({
    repos,
    bot,
    adminId: ADMIN_ID,
    cacheService,
    queueService,
  });

  const scheduler = createSchedulerService({
    repos,
    bot,
    adminId: ADMIN_ID,
    cacheService,
  });

  let webhookEnabled = false;
  if (botConfig?.TELEGRAM_DELIVERY_MODE === "webhook") {
    webhookEnabled = shouldUseWebhookMode(botConfig.WEBHOOK_DOMAIN);
    if (!webhookEnabled) {
      log.warn(
        "Webhook mode requested but domain is not usable; using polling",
        {
          webhookDomain: botConfig.WEBHOOK_DOMAIN || null,
        },
      );
    }
  }
  if (botConfig) {
    log.info("Telegram delivery mode resolved", {
      requestedMode: botConfig.TELEGRAM_DELIVERY_MODE,
      effectiveMode: webhookEnabled ? "webhook" : "polling",
    });
  }

  let webhookRouter = null;
  if (webhookEnabled && botConfig && bot) {
    const webhookPath = `/webhook/${botConfig.BOT_TOKEN}`;
    webhookRouter = bot.webhookCallback(webhookPath);
    log.info("Webhook handler configured", { path: webhookPath });
  }

  // Create web server
  const webServer = createWebServer({
    repos,
    conversationService,
    bot,
    adminId: ADMIN_ID,
    apiSecret: API_SECRET,
    corsOrigin: CORS_ORIGIN,
    isProduction,
    compressionEnabled: API_COMPRESSION,
    cacheService,
    queueService,
    webhookRouter,
    environment: NODE_ENV,
  });

  // Initialize resources
  const resources = {
    db,
    repos,
    bot,
    botLaunched: false,
    httpServer: null,
    sessionCleanupTimer: null,
    schedulerTimers: null,
    memoryMonitor: null,
    cacheService,
    queueService,
  };

  try {
    // Start HTTP server
    resources.httpServer = await startHttpServer(webServer, PORT);
    log.info(`HTTP server started on port ${PORT}`);

    // Launch bot
    if (bot && botConfig) {
      try {
        const launchedBot = await launchTelegramRuntime({
          bot,
          webhookEnabled,
          webhookDomain: botConfig.WEBHOOK_DOMAIN,
          botToken: botConfig.BOT_TOKEN,
          timeoutMs: botConfig.TELEGRAM_STARTUP_TIMEOUT_MS,
          log,
        });
        resources.botLaunched = true;
        log.info(`Bot started in ${launchedBot.mode} mode`, launchedBot.details);
      } catch (error) {
        if (isProduction && !botConfig.ALLOW_BOT_LAUNCH_FAILURE) {
          throw error;
        }
        log.warn("Bot launch failed; continuing in API-only mode", {
          error: formatError(error),
          details: serializeErrorDetails(error),
          productionFallbackEnabled: botConfig.ALLOW_BOT_LAUNCH_FAILURE,
        });
      }
    } else {
      log.info("Telegram runtime is disabled; application started in API-only mode");
    }

    // Start session cleanup
    resources.sessionCleanupTimer = startSessionCleanup(repos);
    repos.sessions.clearExpired();

    // Start scheduled tasks
    resources.schedulerTimers = startScheduledTasks(scheduler);

    // Start memory monitor
    const memoryLimitWarn = MEMORY_LIMIT_WARN * 1024 * 1024;
    const memoryLimitCritical = MEMORY_LIMIT_CRITICAL * 1024 * 1024;

    resources.memoryMonitor = createMemoryMonitor({
      warnThreshold: memoryLimitWarn,
      criticalThreshold: memoryLimitCritical,
      checkInterval: 30000,
    });
    resources.memoryMonitor.start();

    // Setup graceful shutdown
    const shutdownHandler = createShutdownHandler({
      bot: resources.bot,
      cache: resources.cacheService,
      queue: resources.queueService,
      db: resources.db,
      server: resources.httpServer,
    });
    shutdownHandler.registerShutdownHandlers();

    log.info("Application bootstrap completed successfully", {
      uptime: process.uptime(),
    });

    return resources;
  } catch (error) {
    log.error("Application bootstrap failed", {
      error: formatError(error),
      stack: error.stack,
    });
    await teardown(resources, "bootstrap_failed");
    throw error;
  }
}

// Handle fatal errors
process.on("uncaughtException", (error) => {
  // Use console if log is not yet initialized (module loading errors)
  if (typeof log !== "undefined" && log?.error) {
    log.error("Uncaught exception", error, { stack: error.stack });
  } else {
    console.error("Uncaught exception (logger not ready):", error);
  }
  teardown(appResources, "uncaughtException").then(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  const error =
    reason instanceof Error
      ? reason
      : new Error(`Unhandled rejection: ${reason}`);
  if (typeof log !== "undefined" && log?.error) {
    log.error("Unhandled rejection", error, { stack: error.stack });
  } else {
    console.error("Unhandled rejection (logger not ready):", error);
  }
  teardown(appResources, "unhandledRejection").then(() => {
    process.exit(1);
  });
});

// Bootstrap application
bootstrap()
  .then((resources) => {
    appResources = resources;
    log.info("Application is ready", {
      uptime: process.uptime(),
      pid: process.pid,
    });
  })
  .catch((error) => {
    if (typeof log !== "undefined" && log?.error) {
      log.error("Application failed to start", {
        error: formatError(error),
        stack: error.stack,
      });
    } else {
      console.error("Application failed to start:", error);
    }
    process.exit(1);
  });
