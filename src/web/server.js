/**
 * Web Server - Express application with optimizations
 */
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");

const { createPublicRoutes } = require("./routes/public");
const { createAdminRoutes } = require("./routes/admin");
const { createLeadStatusService } = require("../services/lead-status-service");
const { createHealthRouter } = require("./routes/health");
const { createApiKeyAuth } = require("./middleware/api-key-auth");
const { createRateLimiter } = require("./middleware/rate-limit");
const {
  createErrorHandler,
  createNotFoundHandler,
  createRequestLogger,
  asyncHandler,
  trustProxy,
} = require("./middleware/error-handler");

function createWebServer({
  repos,
  conversationService,
  bot,
  adminId,
  apiSecret,
  corsOrigin,
  isProduction,
  compressionEnabled = true,
  cacheService = null,
  queueService = null,
  webhookRouter = null,
  environment = isProduction ? "production" : "development",
}) {
  const app = express();
  app.set("trust proxy", trustProxy({ isProduction }));
  const leadStatusService = createLeadStatusService({ repos, bot });

  // ==========================================================================
  // Security Middleware
  // ==========================================================================

  // CORS
  app.use(
    cors(
      corsOrigin
        ? {
            origin: corsOrigin.split(",").map((s) => s.trim()),
            credentials: true,
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowedHeaders: [
              "Content-Type",
              "Authorization",
              "X-Request-ID",
              "X-API-Key",
            ],
          }
        : undefined,
    ),
  );

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable for API server
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Body parsing
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Compression (should be before routes)
  if (compressionEnabled) {
    app.use(
      compression({
        level: 6,
        threshold: 1024,
        filter: (req, res) => {
          if (req.headers["x-no-compression"]) {
            return false;
          }
          return compression.filter(req, res);
        },
      }),
    );
  }

  // Request ID
  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("X-Request-ID", req.requestId);
    next();
  });

  // Request logging
  app.use(createRequestLogger());

  // ==========================================================================
  // Health & Monitoring Routes
  // ==========================================================================

  // Mount health routes
  app.use(
    "/",
    createHealthRouter({
      environment,
      dbCheck:
        repos && repos.users && typeof repos.users.getById === "function"
          ? async () => {
              try {
                repos.users.getById(-1);
                return { status: "ok" };
              } catch (error) {
                return { status: "error", message: error.message };
              }
            }
          : null,
      cacheService,
    }),
  );

  // ==========================================================================
  // API Routes
  // ==========================================================================

  // Public API (rate limited)
  const publicLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    message: "Слишком много запросов. Попробуйте позже.",
  });
  const isPublicApiPath = (path) =>
    path === "/catalog" ||
    path.startsWith("/catalog/") ||
    path === "/lead" ||
    path.startsWith("/lead/");
  const publicApiLimiter = (req, res, next) => {
    if (!isPublicApiPath(req.path)) {
      return next();
    }
    return publicLimiter(req, res, next);
  };

  app.use(
    "/api",
    publicApiLimiter,
    createPublicRoutes({
      repos,
      bot,
      adminId,
      cacheService,
      queueService,
      isProduction,
    }),
  );

  // Admin API (API key auth + rate limited)
  const adminLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: "Слишком много запросов. Попробуйте позже.",
  });

  const apiKeyAuth = createApiKeyAuth({ apiSecret });

  app.use(
    "/api/admin",
    adminLimiter,
    apiKeyAuth,
    createAdminRoutes({
      repos,
      conversationService,
      adminId,
      leadStatusService,
      cacheService,
      queueService,
    }),
  );

  // ==========================================================================
  // Queue & Cache Management Routes (Admin only)
  // ==========================================================================

  if (queueService) {
    app.get(
      "/api/admin/queues",
      adminLimiter,
      apiKeyAuth,
      asyncHandler(async (req, res) => {
        const stats = await queueService.getQueueStats();
        res.json({ success: true, data: stats });
      }),
    );

    app.post(
      "/api/admin/queues/:name/pause",
      adminLimiter,
      apiKeyAuth,
      asyncHandler(async (req, res) => {
        await queueService.pauseQueue(req.params.name);
        res.json({ success: true, message: `Queue ${req.params.name} paused` });
      }),
    );

    app.post(
      "/api/admin/queues/:name/resume",
      adminLimiter,
      apiKeyAuth,
      asyncHandler(async (req, res) => {
        await queueService.resumeQueue(req.params.name);
        res.json({
          success: true,
          message: `Queue ${req.params.name} resumed`,
        });
      }),
    );
  }

  if (cacheService) {
    app.get(
      "/api/admin/cache",
      adminLimiter,
      apiKeyAuth,
      asyncHandler(async (req, res) => {
        const stats = await cacheService.getCacheStats();
        res.json({ success: true, data: stats });
      }),
    );

    app.post(
      "/api/admin/cache/clear",
      adminLimiter,
      apiKeyAuth,
      asyncHandler(async (req, res) => {
        await cacheService.invalidateAll();
        res.json({ success: true, message: "Cache cleared" });
      }),
    );
  }

  // ==========================================================================
  // Debug Routes (only in non-production)
  // ==========================================================================

  if (!isProduction) {
    // Memory stats
    app.get(
      "/debug/memory",
      asyncHandler(async (req, res) => {
        const mem = process.memoryUsage();
        res.json({
          rss: Math.round(mem.rss / 1024 / 1024) + " MB",
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + " MB",
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + " MB",
          external: Math.round(mem.external / 1024 / 1024) + " MB",
        });
      }),
    );

    // Active handles
    app.get(
      "/debug/handles",
      asyncHandler(async (req, res) => {
        const handles = process._getActiveHandles();
        const requests = process._getActiveRequests();
        res.json({
          handles: handles.length,
          requests: requests.length,
          uptime: process.uptime(),
        });
      }),
    );
  }

  // Webhook endpoint should be mounted before 404/error handlers.
  if (webhookRouter) {
    app.use(webhookRouter);
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  // 404 handler
  app.use(createNotFoundHandler());

  // Global error handler
  app.use(createErrorHandler({ isProduction }));

  return app;
}

module.exports = { createWebServer };
