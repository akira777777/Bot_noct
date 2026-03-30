const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadQueueServiceWithMocks() {
  const queueInstances = [];

  class FakeQueue {
    constructor(name, options) {
      this.name = name;
      this.options = options;
      this.jobs = [];
      this.client = {
        ping: async () => "PONG",
      };
      queueInstances.push(this);
    }

    on() {}

    async add(jobName, payload, options) {
      this.jobs.push({ jobName, payload, options });
      return { id: `${this.name}-${this.jobs.length}` };
    }

    process() {}

    async close() {}

    async getWaitingCount() {
      return 0;
    }

    async getActiveCount() {
      return 0;
    }

    async getCompletedCount() {
      return 0;
    }

    async getFailedCount() {
      return 0;
    }

    async getDelayedCount() {
      return 0;
    }
  }

  class FakeRedis {
    constructor() {
      this.status = "ready";
    }

    on() {}

    removeAllListeners() {}

    async connect() {
      this.status = "connect";
    }

    async ping() {
      return "PONG";
    }

    disconnect() {
      this.status = "end";
    }
  }

  const fakeLog = {
    info() {},
    debug() {},
    warn() {},
    error() {},
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "bull") {
      return FakeQueue;
    }
    if (request === "ioredis") {
      return FakeRedis;
    }
    if (request === "../utils/logger-enhanced") {
      return fakeLog;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve("../src/services/queue-service")];
  const queueService = require("../src/services/queue-service");
  Module._load = originalLoad;

  return { queueService, queueInstances };
}

test("queue service applies limiter config for burst jobs", async () => {
  const { queueService, queueInstances } = loadQueueServiceWithMocks();

  await queueService.initQueueService({
    host: "localhost",
    port: 6379,
    db: 0,
  });

  const byName = Object.fromEntries(queueInstances.map((queue) => [queue.name, queue]));

  assert.deepEqual(byName.messages.options.limiter, { max: 30, duration: 1000 });
  assert.deepEqual(byName.webhooks.options.limiter, { max: 100, duration: 1000 });
  assert.deepEqual(byName.notifications.options.limiter, {
    max: 50,
    duration: 1000,
  });

  assert.equal("limiter" in byName["batch-operations"].options, false);
  assert.equal("limiter" in byName.analytics.options, false);

  await Promise.all(
    Array.from({ length: 120 }, (_, index) =>
      queueService.queueMessage(1000 + index, `Burst #${index + 1}`),
    ),
  );

  assert.equal(byName.messages.jobs.length, 120);

  await queueService.closeQueueService();
});
