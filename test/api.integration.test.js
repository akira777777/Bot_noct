const test = require("node:test");
const assert = require("node:assert/strict");

const { createRepositories } = require("../src/repositories");
const { createWebServer } = require("../src/web/server");
const { clientLeadTakenMessage } = require("../src/ui/messages");
const {
  createTempDb,
  startServer,
  stopServer,
} = require("../test-support/api-test-helpers");

test("admin API manages leads with status filters", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);

  repos.users.upsert({
    telegram_id: adminId,
    username: "admin",
    first_name: "Admin",
    last_name: null,
    role: "admin",
  });
  repos.users.upsert({
    telegram_id: 1001,
    username: "client_1001",
    first_name: "Client",
    last_name: null,
    role: "client",
  });

  const createdLead = repos.leads.create({
    client_telegram_id: 1001,
    product_code: "basic",
    product_name: "Базовый пакет",
    quantity: 2,
    comment: "",
    contact_label: "Telegram",
    source_payload: "from_channel",
    status: "new",
  });

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
  const headers = {
    "X-Api-Key": apiSecret,
    "Content-Type": "application/json",
  };

  // List leads filtered by status
  const newResponse = await fetch(`${baseUrl}/api/admin/leads?status=new`, {
    headers,
  });
  const newPayload = await newResponse.json();
  assert.equal(newResponse.status, 200);
  assert.deepEqual(
    newPayload.leads.map((lead) => lead.id),
    [createdLead.id],
  );

  // Update status
  const patchResponse = await fetch(
    `${baseUrl}/api/admin/leads/${createdLead.id}/status`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    },
  );
  const patchPayload = await patchResponse.json();
  assert.equal(patchResponse.status, 200);
  assert.equal(patchPayload.lead.status, "in_progress");

  // Invalid status returns 400
  const patchInvalidResponse = await fetch(
    `${baseUrl}/api/admin/leads/${createdLead.id}/status`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "unknown" }),
    },
  );
  assert.equal(patchInvalidResponse.status, 400);

  const exportResponse = await fetch(`${baseUrl}/api/admin/export/leads`, {
    headers,
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-type") || "", /text\/csv/i);
});

test("admin CSV export stays protected by API key auth", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
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

  const unauthorized = await fetch(`${baseUrl}/api/admin/export/leads`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/admin/export/leads`, {
    headers: { "X-Api-Key": apiSecret },
  });
  assert.equal(authorized.status, 200);
});

test("admin CSV export prefixes risky string values before CSV escaping", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);

  repos.users.upsert({
    telegram_id: 2002,
    username: "@danger",
    first_name: "=2+2",
    last_name: "-user",
    role: "client",
  });
  repos.leads.create({
    client_telegram_id: 2002,
    product_code: "+code",
    product_name: "=HYPERLINK(\"http://evil\")",
    quantity: -3,
    comment: "@sum(1,2)",
    contact_label: "-phone",
    source_payload: "=channel",
    status: "new",
  });

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
  const response = await fetch(`${baseUrl}/api/admin/export/leads`, {
    headers: { "X-Api-Key": apiSecret },
  });
  const csv = await response.text();

  assert.equal(response.status, 200);
  assert.match(csv, /'@danger/);
  assert.match(csv, /'=2\+2/);
  assert.match(csv, /'-user/);
  assert.match(csv, /'\+code/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /"'@sum\(1,2\)"/);
  assert.match(csv, /'-phone/);
  assert.match(csv, /'=channel/);
  assert.match(csv, /,-3,/);
});

test("admin API status update reuses lead workflow side effects", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);
  const sentMessages = [];

  repos.users.upsert({
    telegram_id: adminId,
    username: "admin",
    first_name: "Admin",
    last_name: null,
    role: "admin",
  });
  repos.users.upsert({
    telegram_id: 1001,
    username: "client_1001",
    first_name: "Client",
    last_name: null,
    role: "client",
  });

  const createdLead = repos.leads.create({
    client_telegram_id: 1001,
    product_code: "basic",
    product_name: "Базовый пакет",
    quantity: 2,
    comment: "",
    contact_label: "Telegram",
    source_payload: "from_channel",
    status: "new",
  });

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {
      telegram: {
        async sendMessage(chatId, text) {
          sentMessages.push({ chatId, text });
          return { ok: true };
        },
      },
    },
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
  const headers = {
    "X-Api-Key": apiSecret,
    "Content-Type": "application/json",
  };

  const patchResponse = await fetch(
    `${baseUrl}/api/admin/leads/${createdLead.id}/status`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    },
  );

  assert.equal(patchResponse.status, 200);
  assert.deepEqual(sentMessages, [
    {
      chatId: 1001,
      text: clientLeadTakenMessage(),
    },
  ]);
});

test("public web lead creation returns a tracking token and status lookup works by token", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);

  repos.products.create({
    code: "basic",
    title: "Базовый пакет",
    description: "Тестовый товар",
    price_text: "100 USDT",
    sort_order: 1,
  });

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {
      telegram: {
        async sendMessage() {
          return { ok: true };
        },
      },
    },
    adminId,
    apiSecret,
    corsOrigin: null,
    isProduction: true,
  });
  const server = await startServer(app);
  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const createResponse = await fetch(`${baseUrl}/api/lead`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_code: "basic",
      quantity: 2,
      comment: "Позвоните вечером",
      contact_label: "@client",
    }),
  });

  assert.equal(createResponse.status, 201);
  const createPayload = await createResponse.json();
  assert.equal(createPayload.ok, true);
  assert.match(createPayload.lead.tracking_token, /^[a-f0-9]{24}$/);
  assert.equal(createPayload.lead.status, "new");

  const statusResponse = await fetch(
    `${baseUrl}/api/lead/track/${createPayload.lead.tracking_token}/status`,
  );

  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.equal(statusPayload.ok, true);
  assert.equal(
    statusPayload.lead.tracking_token,
    createPayload.lead.tracking_token,
  );
  assert.equal(statusPayload.lead.product_name, "Базовый пакет");
  assert.equal(statusPayload.lead.quantity, 2);
});

test("admin reply returns 503 when Telegram delivery is disabled", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);

  const app = createWebServer({
    repos,
    conversationService: {
      async sendAdminReply() {
        const error = new Error("Telegram delivery is disabled");
        error.code = "TELEGRAM_DELIVERY_DISABLED";
        throw error;
      },
    },
    bot: null,
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
  const response = await fetch(
    `${baseUrl}/api/admin/conversations/1001/reply`,
    {
      method: "POST",
      headers: {
        "X-Api-Key": apiSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Проверяю детали заявки" }),
    },
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /disabled/i);
});

test("admin queue/cache routes keep contracts and remain API-key protected", async (t) => {
  const adminId = 9001;
  const apiSecret = "test-api-secret";
  const { db, cleanup } = createTempDb("bot-noct-api-");
  const repos = createRepositories(db);

  const queueService = {
    async getQueueStats() {
      return [{ name: "default", waiting: 1, active: 0 }];
    },
    async pauseQueue() {},
    async resumeQueue() {},
  };
  const cacheService = {
    async getCacheStats() {
      return { keys: 3, hits: 10, misses: 2 };
    },
    async invalidateAll() {},
  };

  const app = createWebServer({
    repos,
    conversationService: {},
    bot: {},
    adminId,
    apiSecret,
    corsOrigin: null,
    isProduction: false,
    queueService,
    cacheService,
  });
  const server = await startServer(app);
  t.after(async () => {
    await stopServer(server);
    cleanup();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorizedQueues = await fetch(`${baseUrl}/api/admin/queues`);
  assert.equal(unauthorizedQueues.status, 401);

  const headers = { "X-Api-Key": apiSecret };

  const queuesResponse = await fetch(`${baseUrl}/api/admin/queues`, { headers });
  assert.equal(queuesResponse.status, 200);
  const queuesPayload = await queuesResponse.json();
  assert.deepEqual(queuesPayload, {
    success: true,
    data: [{ name: "default", waiting: 1, active: 0 }],
  });

  const pauseResponse = await fetch(`${baseUrl}/api/admin/queues/default/pause`, {
    method: "POST",
    headers,
  });
  assert.equal(pauseResponse.status, 200);
  const pausePayload = await pauseResponse.json();
  assert.deepEqual(pausePayload, {
    success: true,
    message: "Queue default paused",
  });

  const resumeResponse = await fetch(
    `${baseUrl}/api/admin/queues/default/resume`,
    {
      method: "POST",
      headers,
    },
  );
  assert.equal(resumeResponse.status, 200);
  const resumePayload = await resumeResponse.json();
  assert.deepEqual(resumePayload, {
    success: true,
    message: "Queue default resumed",
  });

  const cacheResponse = await fetch(`${baseUrl}/api/admin/cache`, { headers });
  assert.equal(cacheResponse.status, 200);
  const cachePayload = await cacheResponse.json();
  assert.deepEqual(cachePayload, {
    success: true,
    data: { keys: 3, hits: 10, misses: 2 },
  });

  const clearResponse = await fetch(`${baseUrl}/api/admin/cache/clear`, {
    method: "POST",
    headers,
  });
  assert.equal(clearResponse.status, 200);
  const clearPayload = await clearResponse.json();
  assert.deepEqual(clearPayload, {
    success: true,
    message: "Cache cleared",
  });
});
