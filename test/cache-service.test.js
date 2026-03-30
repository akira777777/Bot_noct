const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

const {
  CacheService,
  CACHE_KEYS,
} = require("../src/services/cache-service");

test("cache service memory mode stores values and evicts expired entries", async () => {
  const cache = new CacheService(null);

  assert.equal(cache.getMode(), "memory");

  await cache.setSession("draft-1", { step: 2 });
  assert.deepEqual(await cache.getSession("draft-1"), { step: 2 });

  await cache.set("temp:key", { ok: true }, 60);
  cache.memoryCacheExpiry.set("temp:key", Date.now() - 1);

  assert.equal(await cache.get("temp:key"), null);
  assert.equal(cache.memoryCache.has("temp:key"), false);
});

test("cache service memory mode enforces rate limits and reports degraded health", async () => {
  const cache = new CacheService(null);

  const first = await cache.checkRateLimit("lead-submit", 2, 30);
  const second = await cache.checkRateLimit("lead-submit", 2, 30);
  const third = await cache.checkRateLimit("lead-submit", 2, 30);

  assert.deepEqual(first, {
    allowed: true,
    remaining: 1,
    resetIn: 30,
    limit: 2,
  });
  assert.deepEqual(second, {
    allowed: true,
    remaining: 0,
    resetIn: 30,
    limit: 2,
  });
  assert.deepEqual(third, {
    allowed: false,
    remaining: 0,
    resetIn: 30,
    limit: 2,
  });

  assert.deepEqual(await cache.healthCheck(), {
    status: "degraded",
    mode: "memory",
  });
  assert.deepEqual(await cache.getCacheStats(), {
    isConnected: false,
    fallback: true,
    memoryKeys: 1,
  });
});

test("cache service memory rate limit resets after window expires", async () => {
  const cache = new CacheService(null);

  const first = await cache.checkRateLimit("lead-submit", 1, 1);
  const second = await cache.checkRateLimit("lead-submit", 1, 1);

  await delay(1100);

  const third = await cache.checkRateLimit("lead-submit", 1, 1);

  assert.deepEqual(first, {
    allowed: true,
    remaining: 0,
    resetIn: 1,
    limit: 1,
  });
  assert.deepEqual(second, {
    allowed: false,
    remaining: 0,
    resetIn: 1,
    limit: 1,
  });
  assert.deepEqual(third, {
    allowed: true,
    remaining: 0,
    resetIn: 1,
    limit: 1,
  });
});

test("cache service invalidateAll clears catalog, product and stats namespaces only", async () => {
  const cache = new CacheService(null);

  await cache.setCatalog([{ code: "basic" }]);
  await cache.setProduct(5, { id: 5, title: "Basic" });
  await cache.setStats({ openLeads: 3 });
  await cache.setUser(77, { role: "client" });

  await cache.invalidateAll();

  assert.equal(await cache.get(`${CACHE_KEYS.CATALOG}all`), null);
  assert.equal(await cache.get(`${CACHE_KEYS.PRODUCT}5`), null);
  assert.equal(await cache.get(`${CACHE_KEYS.STATS}dashboard`), null);
  assert.deepEqual(await cache.getUser(77), { role: "client" });
});
