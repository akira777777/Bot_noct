/**
 * Queue Service - Bull-based async job processing
 * Handles background tasks like message sending, webhooks, batch operations
 */
const Queue = require("bull");
const Redis = require("ioredis");
const log = require("../utils/logger-enhanced");

// Queue names
const QUEUES = {
  MESSAGES: "messages",
  WEBHOOKS: "webhooks",
  NOTIFICATIONS: "notifications",
  BATCH_OPERATIONS: "batch-operations",
  ANALYTICS: "analytics",
};

// Job types
const JOB_TYPES = {
  SEND_MESSAGE: "send_message",
  SEND_BULK_MESSAGES: "send_bulk_messages",
  PROCESS_WEBHOOK: "process_webhook",
  SEND_NOTIFICATION: "send_notification",
  SYNC_LEAD: "sync_lead",
  EXPORT_DATA: "export_data",
  CLEANUP: "cleanup",
  ANALYTICS_REPORT: "analytics_report",
};

// Retry configuration
const RETRY_CONFIG = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000, // Start with 2 seconds
  },
};

// Rate limiting per queue
const RATE_LIMITS = {
  [QUEUES.MESSAGES]: {
    max: 30, // 30 messages per second
    duration: 1000,
  },
  [QUEUES.WEBHOOKS]: {
    max: 100,
    duration: 1000,
  },
  [QUEUES.NOTIFICATIONS]: {
    max: 50,
    duration: 1000,
  },
};

// Active queues storage
const queues = {};

async function validateRedisConnection(redisConfig) {
  let connected = false;
  let firstConnectionError = null;
  const client = new Redis({
    host: redisConfig.host || "localhost",
    port: redisConfig.port || 6379,
    password: redisConfig.password || undefined,
    db: redisConfig.db || 0,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });

  client.on("error", () => {
    // no-op placeholder replaced below
  });

  client.removeAllListeners("error");
  client.on("error", (error) => {
    if (!firstConnectionError) {
      firstConnectionError = error;
    }
    // Suppress unhandled ioredis error events for the short-lived probe client.
    // The actual failure is surfaced through connect/ping rejection below.
  });

  try {
    await client.connect();
    connected = true;
    await client.ping();
  } catch (error) {
    throw firstConnectionError || error;
  } finally {
    if (connected && client.status !== "end") {
      client.disconnect();
    }
  }
}

/**
 * Initialize queue service
 */
async function initQueueService(redisConfig) {
  log.info("Initializing queue service", {
    redisConfig: {
      host: redisConfig.host || "localhost",
      port: redisConfig.port || 6379,
      db: redisConfig.db || 0,
      hasPassword: Boolean(redisConfig.password),
    },
  });

  await validateRedisConnection(redisConfig);

  // Create queues with Redis connection
  for (const queueName of Object.values(QUEUES)) {
    queues[queueName] = createQueue(queueName, redisConfig);
  }

  // Setup event handlers
  setupQueueEvents();

  // Schedule recurring jobs
  await scheduleRecurringJobs();

  log.info("Queue service initialized successfully");
}

/**
 * Create a queue with configuration
 */
function createQueue(name, redisConfig) {
  const queueOptions = {
    redis: {
      host: redisConfig.host || "localhost",
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
      retryStrategy: (times) => {
        if (times > 10) {
          log.error(`Queue ${name}: Max retries exceeded`);
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    },
    defaultJobOptions: {
      removeOnComplete: 100, // Keep last 100 completed jobs
      removeOnFail: 500, // Keep last 500 failed jobs
      attempts: RETRY_CONFIG.attempts,
      backoff: RETRY_CONFIG.backoff,
    },
  };

  if (RATE_LIMITS[name]) {
    queueOptions.limiter = RATE_LIMITS[name];
  }

  const queue = new Queue(name, queueOptions);

  return queue;
}

/**
 * Setup queue event handlers
 */
function setupQueueEvents() {
  for (const [name, queue] of Object.entries(queues)) {
    // Job completed
    queue.on("completed", (job, result) => {
      log.debug(`Job ${job.id} completed in queue ${name}`, {
        jobId: job.id,
        queue: name,
        type: job.name,
        duration: job.finishedOn - job.processedOn,
      });
    });

    // Job failed
    queue.on("failed", (job, err) => {
      log.error(`Job ${job?.id} failed in queue ${name}`, {
        jobId: job?.id,
        queue: name,
        type: job?.name,
        error: err.message,
        stack: err.stack,
        attemptsMade: job?.attemptsMade,
      });
    });

    // Job progress
    queue.on("progress", (job, progress) => {
      log.debug(`Job ${job.id} progress: ${progress}%`, {
        jobId: job.id,
        queue: name,
        progress,
      });
    });

    // Job waiting
    queue.on("waiting", (jobId) => {
      log.debug(`Job ${jobId} is waiting in queue ${name}`, {
        jobId,
        queue: name,
      });
    });

    // Job active
    queue.on("active", (job) => {
      log.debug(`Job ${job.id} started processing`, {
        jobId: job.id,
        queue: name,
        type: job.name,
      });
    });

    // Queue stalled
    queue.on("stalled", (job) => {
      log.warn(`Job ${job.id} stalled in queue ${name}`, {
        jobId: job.id,
        queue: name,
      });
    });
  }
}

/**
 * Schedule recurring jobs
 */
async function scheduleRecurringJobs() {
  // Schedule daily cleanup at midnight
  queues[QUEUES.BATCH_OPERATIONS].add(
    JOB_TYPES.CLEANUP,
    {},
    {
      repeat: { cron: "0 0 * * *" }, // Every day at midnight
      jobId: "daily-cleanup",
    },
  );

  // Schedule analytics report every hour
  queues[QUEUES.ANALYTICS].add(
    JOB_TYPES.ANALYTICS_REPORT,
    {},
    {
      repeat: { cron: "0 * * * *" }, // Every hour
      jobId: "hourly-analytics",
    },
  );

  log.info("Recurring jobs scheduled");
}

/**
 * Add message sending job
 */
async function queueMessage(chatId, text, options = {}) {
  return queues[QUEUES.MESSAGES].add(
    JOB_TYPES.SEND_MESSAGE,
    {
      chatId,
      text,
      options: {
        parse_mode: options.parse_mode || "HTML",
        reply_markup: options.reply_markup,
        disable_web_page_preview: options.disable_web_page_preview,
        ...options,
      },
    },
    {
      priority: options.priority || 0,
      timeout: 30000, // 30 seconds timeout
    },
  );
}

/**
 * Add bulk message sending job
 */
async function queueBulkMessages(chatIds, text, options = {}) {
  return queues[QUEUES.MESSAGES].add(
    JOB_TYPES.SEND_BULK_MESSAGES,
    {
      chatIds,
      text,
      options,
    },
    {
      priority: 1, // Lower priority than single messages
      timeout: 300000, // 5 minutes timeout
    },
  );
}

/**
 * Add webhook processing job
 */
async function queueWebhook(webhookData) {
  return queues[QUEUES.WEBHOOKS].add(
    JOB_TYPES.PROCESS_WEBHOOK,
    {
      ...webhookData,
      timestamp: Date.now(),
    },
    {
      timeout: 60000, // 1 minute timeout
    },
  );
}

/**
 * Add notification job
 */
async function queueNotification(userId, notification) {
  return queues[QUEUES.NOTIFICATIONS].add(
    JOB_TYPES.SEND_NOTIFICATION,
    {
      userId,
      notification,
    },
    {
      timeout: 30000,
    },
  );
}

/**
 * Add batch operation job
 */
async function queueBatchOperation(operationType, data) {
  return queues[QUEUES.BATCH_OPERATIONS].add(
    operationType,
    {
      ...data,
      timestamp: Date.now(),
    },
    {
      timeout: 600000, // 10 minutes timeout
    },
  );
}

/**
 * Add lead sync job
 */
async function queueLeadSync(leadId, action = "sync") {
  return queues[QUEUES.BATCH_OPERATIONS].add(
    JOB_TYPES.SYNC_LEAD,
    {
      leadId,
      action,
    },
    {
      timeout: 30000,
    },
  );
}

/**
 * Add analytics job
 */
async function queueAnalyticsReport(reportType = "daily") {
  return queues[QUEUES.ANALYTICS].add(
    JOB_TYPES.ANALYTICS_REPORT,
    {
      reportType,
      generatedAt: new Date().toISOString(),
    },
    {
      timeout: 60000,
    },
  );
}

/**
 * Process message jobs - this should be connected to the bot
 */
function processMessageJobs(handler) {
  queues[QUEUES.MESSAGES].process(JOB_TYPES.SEND_MESSAGE, async (job) => {
    const { chatId, text, options } = job.data;
    log.debug(`Processing message job ${job.id}`, { chatId });
    return handler(chatId, text, options);
  });

  queues[QUEUES.MESSAGES].process(JOB_TYPES.SEND_BULK_MESSAGES, async (job) => {
    const { chatIds, text, options } = job.data;
    log.debug(`Processing bulk message job ${job.id}`, {
      chatIdsCount: chatIds.length,
    });

    const results = [];
    for (const chatId of chatIds) {
      try {
        await handler(chatId, text, options);
        results.push({ chatId, success: true });
      } catch (error) {
        results.push({ chatId, success: false, error: error.message });
      }
      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return results;
  });
}

/**
 * Process webhook jobs
 */
function processWebhookJobs(handler) {
  queues[QUEUES.WEBHOOKS].process(JOB_TYPES.PROCESS_WEBHOOK, async (job) => {
    const { url, payload, headers } = job.data;
    log.debug(`Processing webhook job ${job.id}`, { url });
    return handler(url, payload, headers);
  });
}

/**
 * Process notification jobs
 */
function processNotificationJobs(handler) {
  queues[QUEUES.NOTIFICATIONS].process(
    JOB_TYPES.SEND_NOTIFICATION,
    async (job) => {
      const { userId, notification } = job.data;
      log.debug(`Processing notification job ${job.id}`, { userId });
      return handler(userId, notification);
    },
  );
}

/**
 * Process batch operation jobs
 */
function processBatchJobs(handlers) {
  queues[QUEUES.BATCH_OPERATIONS].process(JOB_TYPES.SYNC_LEAD, async (job) => {
    const { leadId, action } = job.data;
    if (handlers.syncLead) {
      return handlers.syncLead(leadId, action);
    }
    return { success: false, error: "Handler not configured" };
  });

  queues[QUEUES.BATCH_OPERATIONS].process(JOB_TYPES.CLEANUP, async () => {
    if (handlers.cleanup) {
      return handlers.cleanup();
    }
    return { success: true };
  });
}

/**
 * Process analytics jobs
 */
function processAnalyticsJobs(handler) {
  queues[QUEUES.ANALYTICS].process(JOB_TYPES.ANALYTICS_REPORT, async (job) => {
    const { reportType } = job.data;
    if (handler) {
      return handler(reportType);
    }
    return { success: true };
  });
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
  const stats = {};

  for (const [name, queue] of Object.entries(queues)) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    stats[name] = {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
    };
  }

  return stats;
}

/**
 * Get job counts for a specific queue
 */
async function getJobCounts(queueName) {
  const queue = queues[queueName];
  if (!queue) {
    throw new Error(`Queue ${queueName} not found`);
  }

  return {
    waiting: await queue.getWaitingCount(),
    active: await queue.getActiveCount(),
    completed: await queue.getCompletedCount(),
    failed: await queue.getFailedCount(),
    delayed: await queue.getDelayedCount(),
  };
}

/**
 * Pause a queue
 */
async function pauseQueue(queueName) {
  const queue = queues[queueName];
  if (queue) {
    await queue.pause();
    log.info(`Queue ${queueName} paused`);
  }
}

/**
 * Resume a queue
 */
async function resumeQueue(queueName) {
  const queue = queues[queueName];
  if (queue) {
    await queue.resume();
    log.info(`Queue ${queueName} resumed`);
  }
}

/**
 * Clear all jobs from a queue
 */
async function clearQueue(queueName) {
  const queue = queues[queueName];
  if (queue) {
    await queue.empty();
    log.info(`Queue ${queueName} cleared`);
  }
}

/**
 * Close all queues gracefully
 */
async function closeQueueService() {
  log.info("Closing queue service...");

  const closePromises = Object.entries(queues).map(([name, queue]) =>
    queue
      .close()
      .then(() => {
        log.debug(`Queue ${queue.name} closed`);
      })
      .finally(() => {
        delete queues[name];
      }),
  );

  await Promise.all(closePromises);
  log.info("Queue service closed");
}

/**
 * Health check for queues
 */
async function queueHealthCheck() {
  const redisAvailable = await queues[QUEUES.MESSAGES]?.client
    ?.ping()
    .then(() => true)
    .catch(() => false);

  return {
    status: redisAvailable ? "healthy" : "unhealthy",
    redis: redisAvailable ? "connected" : "disconnected",
    queues: Object.keys(queues).length,
  };
}

module.exports = {
  initQueueService,
  closeQueueService,
  queueHealthCheck,
  getQueueStats,
  getJobCounts,
  pauseQueue,
  resumeQueue,
  clearQueue,
  queueMessage,
  queueBulkMessages,
  queueWebhook,
  queueNotification,
  queueBatchOperation,
  queueLeadSync,
  queueAnalyticsReport,
  processMessageJobs,
  processWebhookJobs,
  processNotificationJobs,
  processBatchJobs,
  processAnalyticsJobs,
  QUEUES,
  JOB_TYPES,
};
