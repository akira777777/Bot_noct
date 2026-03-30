const DEFAULT_QUICK_TEMPLATES = {
  availability:
    "Заявка принята. Сейчас проверю наличие и напишу вам в ближайшее время.",
  terms:
    "Проверяю сроки и доступный объём. Вернусь с ответом в ближайшее время.",
  contact:
    "Чтобы не потерять заявку, пришлите удобный контакт для связи, если Telegram неудобен.",
  ack: "Заявка уже в работе. Я на связи и вернусь с апдейтом в рамках текущего окна ответа.",
  payment: "После подтверждения деталей пришлю доступные варианты оплаты.",
  delivery: "После подтверждения заявки подберём удобный вариант доставки.",
};

const { logWarn } = require("../utils/logger");

function createAdminService({ repos, templates = DEFAULT_QUICK_TEMPLATES }) {
  function upsertAdmin(from) {
    repos.users.upsert({
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      last_name: from.last_name || null,
      role: "admin",
    });

    return repos.users.getById(from.id);
  }

  function getActiveClientId(adminTelegramId) {
    const state = repos.adminState.get(adminTelegramId);
    return state?.active_client_telegram_id || null;
  }

  function selectClient(adminTelegramId, clientId) {
    repos.adminState.setActiveClient(adminTelegramId, clientId);
    return clientId;
  }

  function clearSelectedClient(adminTelegramId) {
    repos.adminState.clear(adminTelegramId);
  }

  function listRecentDialogs(limit = 10) {
    return repos.conversations.listRecent(limit);
  }

  function listInbox(limit = 10) {
    return repos.leads.listPriorityInbox(limit);
  }

  function listRecentLeads(limit = 10) {
    return repos.leads.list(limit);
  }

  function listRecentDialogsPage(offset = 0) {
    const rows = repos.conversations.listRecentPaginated(
      ADMIN_PAGE_SIZE + 1,
      offset,
    );
    return {
      rows: rows.slice(0, ADMIN_PAGE_SIZE),
      hasMore: rows.length > ADMIN_PAGE_SIZE,
    };
  }

  function listInboxPage(offset = 0) {
    const rows = repos.leads.listPriorityInboxPaginated(
      ADMIN_PAGE_SIZE + 1,
      offset,
    );
    return {
      rows: rows.slice(0, ADMIN_PAGE_SIZE),
      hasMore: rows.length > ADMIN_PAGE_SIZE,
    };
  }

  function listRecentLeadsPage(offset = 0) {
    const rows = repos.leads.listPaginated(ADMIN_PAGE_SIZE + 1, offset);
    return {
      rows: rows.slice(0, ADMIN_PAGE_SIZE),
      hasMore: rows.length > ADMIN_PAGE_SIZE,
    };
  }

  function getLatestLeadByClient(clientId) {
    return repos.leads.getLatestByClient(clientId);
  }

  function takeLead(leadId) {
    return repos.leads.updateStatus(leadId, "in_progress");
  }

  function closeLead(leadId, metadata = {}) {
    return repos.leads.updateStatus(leadId, "closed", metadata);
  }

  function markLeadCalledBack(leadId) {
    return repos.leads.updateStatus(leadId, "called_back");
  }

  function markLeadAwaitingPayment(leadId) {
    return repos.leads.updateStatus(leadId, "awaiting_payment");
  }

  function markLeadFulfilled(leadId) {
    return repos.leads.updateStatus(leadId, "fulfilled");
  }

  function getTemplate(templateKey) {
    return templates[templateKey] || null;
  }

  function listAllProducts() {
    return repos.products.listAll();
  }

  function addProduct({ code, title, description, price_text, sort_order }) {
    const existing = repos.products.getByCode(code);
    if (existing) {
      return { ok: false, error: `Товар с кодом "${code}" уже существует.` };
    }
    const product = repos.products.create({
      code,
      title,
      description: description || "",
      price_text: price_text || "",
      sort_order: sort_order || 0,
    });
    return { ok: true, product };
  }

  function editProduct({ id, title, description, price_text, sort_order }) {
    const existing = repos.products.getById(id);
    if (!existing) {
      return { ok: false, error: `Товар #${id} не найден.` };
    }
    const product = repos.products.update({
      id,
      title: title !== undefined ? title : existing.title,
      description:
        description !== undefined ? description : existing.description,
      price_text: price_text !== undefined ? price_text : existing.price_text,
      sort_order: sort_order !== undefined ? sort_order : existing.sort_order,
    });
    return { ok: true, product };
  }

  function toggleProduct(id) {
    const existing = repos.products.getById(id);
    if (!existing) {
      return { ok: false, error: `Товар #${id} не найден.` };
    }
    const product = repos.products.setActive(id, !existing.is_active);
    return { ok: true, product };
  }

  function getStats() {
    const total = repos.stats.totalLeads();
    const byStatus = repos.stats.leadCountsByStatus();
    const topProducts = repos.stats.topProductsByLeads(5);
    return { total, byStatus, topProducts };
  }

  function getDashboardWindowStats(hours) {
    const sinceIso = new Date(
      Date.now() - hours * 60 * 60 * 1000,
    ).toISOString();
    const draftsStarted = repos.leadEvents.countByTypeSince(
      "lead_flow_started",
      sinceIso,
    );
    const confirmedLeads = repos.leadEvents.countByTypeSince(
      "lead_confirmed",
      sinceIso,
    );
    const responseDurations = repos.leads
      .firstResponseDurationsSince(sinceIso)
      .map((row) => row.response_seconds)
      .filter((value) => Number.isFinite(value) && value >= 0);
    const avgResponseSeconds = responseDurations.length
      ? Math.round(
          responseDurations.reduce((sum, value) => sum + value, 0) /
            responseDurations.length,
        )
      : null;
    const medianResponseSeconds = responseDurations.length
      ? responseDurations[Math.floor(responseDurations.length / 2)]
      : null;

    return {
      draftsStarted,
      confirmedLeads,
      conversionRate:
        draftsStarted > 0
          ? Number(((confirmedLeads / draftsStarted) * 100).toFixed(1))
          : 0,
      avgResponseSeconds,
      medianResponseSeconds,
      overdueLeads: repos.stats.countOverdueLeads(),
      topSources: repos.leadEvents.topSourcesByEventSince(
        "lead_confirmed",
        sinceIso,
        5,
      ),
    };
  }

  function getDashboardStats() {
    return {
      last24Hours: getDashboardWindowStats(24),
      last7Days: getDashboardWindowStats(24 * 7),
    };
  }

  function getClientHistory(clientTelegramId, limit = 10) {
    const conversation = repos.conversations.getByClientId(clientTelegramId);
    if (!conversation) {
      return { ok: false, error: "Диалог для этого клиента не найден." };
    }
    const messages = repos.messages.listByConversation(conversation.id, limit);
    return { ok: true, messages: messages.reverse() };
  }

  function exportLeadsCsv() {
    const leads = repos.leads.listAll();

    const headers = [
      "id",
      "status",
      "closed_reason",
      "product_code",
      "product_name",
      "quantity",
      "comment",
      "contact_label",
      "client_telegram_id",
      "username",
      "first_name",
      "last_name",
      "source_payload",
      "first_admin_reply_at",
      "next_follow_up_at",
      "created_at",
      "updated_at",
    ];

    function escapeCsv(value) {
      if (value === null || value === undefined) return "";
      const isString = typeof value === "string";
      const str = String(value);
      const startsWithFormulaToken = isString && /^[=+\-@]/.test(str);
      const safeStr = startsWithFormulaToken ? `'${str}` : str;
      if (safeStr.includes(",") || safeStr.includes('"') || safeStr.includes("\n")) {
        return '"' + safeStr.replace(/"/g, '""') + '"';
      }
      return safeStr;
    }

    const rows = leads.map((l) =>
      headers.map((h) => escapeCsv(l[h])).join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");
    return { ok: true, csv, count: leads.length };
  }

  function searchUser(query) {
    const byId = Number(query);
    if (byId && !isNaN(byId)) {
      const user = repos.users.getById(byId);
      return user ? { ok: true, user } : { ok: false, reason: "not_found" };
    }
    const user = repos.users.getByUsername(query);
    return user ? { ok: true, user } : { ok: false, reason: "not_found" };
  }

  async function broadcastToClients(bot, text) {
    const clients = repos.users.listClients();
    const chatIds = clients.map((c) => c.telegram_id);

    if (
      queueService &&
      typeof queueService.queueBulkMessages === "function" &&
      chatIds.length > 0
    ) {
      try {
        const job = await queueService.queueBulkMessages(chatIds, text, {});
        const results = await job.finished();
        const sent = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        return { total: clients.length, sent, failed };
      } catch (err) {
        logError("broadcast queue failed; falling back to direct send", err);
      }
    }

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      try {
        await bot.telegram.sendMessage(client.telegram_id, text);
        sent++;
      } catch (err) {
        logWarn("Broadcast delivery failed for client", {
          clientId: client.telegram_id,
          error: err.message,
        });
        failed++;
      }
      if (i < clients.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, BROADCAST_DIRECT_DELAY_MS),
        );
      }
    }
    return { total: clients.length, sent, failed };
  }

  function resolveConversation(clientTelegramId) {
    const conversation = repos.conversations.getByClientId(clientTelegramId);
    if (!conversation) return { ok: false, reason: "not_found" };
    if (conversation.status === "closed")
      return { ok: false, reason: "already_closed" };
    repos.conversations.close(clientTelegramId);
    return { ok: true };
  }

  function blockUser(telegramId) {
    const user = repos.users.getById(telegramId);
    if (!user) return { ok: false, reason: "not_found" };
    if (user.is_blocked) return { ok: false, reason: "already_blocked" };
    repos.users.block(telegramId);
    return { ok: true };
  }

  function unblockUser(telegramId) {
    const user = repos.users.getById(telegramId);
    if (!user) return { ok: false, reason: "not_found" };
    if (!user.is_blocked) return { ok: false, reason: "not_blocked" };
    repos.users.unblock(telegramId);
    return { ok: true };
  }

  return {
    upsertAdmin,
    getActiveClientId,
    selectClient,
    clearSelectedClient,
    ADMIN_PAGE_SIZE,
    listRecentDialogs,
    listInbox,
    listRecentLeads,
    listRecentDialogsPage,
    listInboxPage,
    listRecentLeadsPage,
    getLatestLeadByClient,
    takeLead,
    closeLead,
    markLeadCalledBack,
    markLeadAwaitingPayment,
    markLeadFulfilled,
    getTemplate,
    templates,
    listAllProducts,
    addProduct,
    editProduct,
    toggleProduct,
    getClientHistory,
    getStats,
    getDashboardStats,
    exportLeadsCsv,
    searchUser,
    broadcastToClients,
    resolveConversation,
    blockUser,
    unblockUser,
  };
}

module.exports = {
  createAdminService,
  DEFAULT_QUICK_TEMPLATES,
};
