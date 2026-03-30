const test = require("node:test");
const assert = require("node:assert/strict");

const { createRepositories } = require("../src/repositories");
const { createWebServer } = require("../src/web/server");
const {
  createTempDb,
  startServer,
  stopServer,
} = require("../test-support/api-test-helpers");

test("unauthenticated request gets 401 on admin endpoints", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-secret-key";
  const { db, cleanup } = createTempDb("bot-noct-authz-");
  const repos = createRepositories(db);

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret,
    corsOrigin: null,
    isProduction: false,
  });
  const server = await startServer(app);

  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // No API key → 401
  const response = await fetch(`${baseUrl}/api/admin/leads`);
  assert.equal(response.status, 401);

  // Wrong API key → 401
  const response2 = await fetch(`${baseUrl}/api/admin/leads`, {
    headers: { "X-Api-Key": "wrong-key" },
  });
  assert.equal(response2.status, 401);

  // Correct API key → 200
  const response3 = await fetch(`${baseUrl}/api/admin/leads`, {
    headers: { "X-Api-Key": apiSecret },
  });
  assert.equal(response3.status, 200);
});

test("admin endpoints fail closed when API secret is not configured", async (t) => {
  const adminId = 9001;
  const { db, cleanup } = createTempDb("bot-noct-authz-");
  const repos = createRepositories(db);

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret: null,
    corsOrigin: null,
    isProduction: true,
  });
  const server = await startServer(app);

  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/admin/leads`);
  assert.equal(response.status, 503);

  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /disabled/i);
});

test("public lead status endpoint resolves by tracking token in production", async (t) => {
  const adminId = 9001;
  const { db, cleanup } = createTempDb("bot-noct-authz-");
  const repos = createRepositories(db);

  repos.users.upsert({
    telegram_id: 1001,
    username: "client_1001",
    first_name: "Client",
    last_name: null,
    role: "client",
  });

  const lead = repos.leads.create({
    client_telegram_id: 1001,
    product_code: "basic",
    product_name: "Базовый пакет",
    quantity: 1,
    comment: "",
    contact_label: "Telegram",
    source_payload: "web_form",
    status: "new",
  });

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret: "test-secret-key",
    corsOrigin: null,
    isProduction: true,
  });
  const server = await startServer(app);

  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(
    `${baseUrl}/api/lead/track/${lead.tracking_token}/status`,
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.lead.tracking_token, lead.tracking_token);
  assert.equal(payload.lead.status, "new");
});

test("public lead status endpoint rejects malformed tracking tokens", async (t) => {
  const adminId = 9001;
  const { db, cleanup } = createTempDb("bot-noct-authz-");
  const repos = createRepositories(db);

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret: "test-secret-key",
    corsOrigin: null,
    isProduction: false,
  });
  const server = await startServer(app);

  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/lead/track/not-a-token/status`);
  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /tracking token/i);
});

test("admin endpoints are not affected by the public API rate limiter", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-secret-key";
  const { db, cleanup } = createTempDb("bot-noct-authz-");
  const repos = createRepositories(db);

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret,
    corsOrigin: null,
    isProduction: false,
  });
  const server = await startServer(app);

  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Api-Key": apiSecret };

  for (let i = 0; i < 61; i += 1) {
    const response = await fetch(`${baseUrl}/api/admin/leads`, { headers });
    assert.equal(response.status, 200);
  }
});
