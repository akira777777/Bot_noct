const test = require("node:test");
const assert = require("node:assert/strict");

const { createRepositories } = require("../src/repositories");
const { createWebServer } = require("../src/web/server");
const {
  createTempDb,
  startServer,
  stopServer,
} = require("../test-support/api-test-helpers");

test("webhook route is mounted before 404 handler", async (t) => {
  const adminId = 9001;
  const { db, cleanup } = createTempDb("bot-noct-webhook-");
  const repos = createRepositories(db);

  const webhookToken = "test-token";
  let handled = false;

  const webhookRouter = (req, res, next) => {
    if (req.method === "POST" && req.path === `/webhook/${webhookToken}`) {
      handled = true;
      res.status(200).json({ ok: true });
      return;
    }
    next();
  };

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret: "test-secret",
    corsOrigin: null,
    isProduction: false,
    webhookRouter,
  });

  const server = await startServer(app);
  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/webhook/${webhookToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ update_id: 1 }),
  });

  assert.equal(response.status, 200);
  assert.equal(handled, true);
  assert.deepEqual(await response.json(), { ok: true });
});
