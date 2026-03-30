const express = require("express");
const {
  getLeadStatusLabel,
  isCanonicalLeadStatus,
  normalizeLeadStatus,
} = require("../../domain/lead-status");

function createAdminRoutes({
  repos,
  conversationService,
  adminId,
  leadStatusService,
}) {
  const router = express.Router();

  // --- Leads ---

  router.get("/leads", (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const requestedStatus =
      typeof req.query.status === "string" ? req.query.status : null;
    const status = normalizeLeadStatus(requestedStatus);

    let leads;
    let total;
    if (status && isCanonicalLeadStatus(status)) {
      leads = repos.leads.listByStatusPaginated(status, limit, offset);
      total = repos.leads.countByStatus(status);
    } else {
      leads = repos.leads.listPaginated(limit, offset);
      total = repos.leads.countAll();
    }

    res.json({
      ok: true,
      leads: leads.map((l) => ({
        ...l,
        status_label: getLeadStatusLabel(l.status),
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  });

  router.get("/leads/:id", (req, res) => {
    const lead = repos.leads.getById(Number(req.params.id));
    if (!lead) {
      return res.status(404).json({ ok: false, error: "Lead not found" });
    }

    const user = repos.users.getById(lead.client_telegram_id);
    res.json({
      ok: true,
      lead: { ...lead, status_label: getLeadStatusLabel(lead.status) },
      client: user || null,
    });
  });

  router.patch("/leads/:id/status", async (req, res) => {
    const normalizedStatus = normalizeLeadStatus(req.body?.status);
    if (!normalizedStatus || !isCanonicalLeadStatus(normalizedStatus)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const lead = await leadStatusService.updateStatus(
      Number(req.params.id),
      normalizedStatus,
    );
    if (!lead) {
      return res.status(404).json({ ok: false, error: "Lead not found" });
    }

    res.json({
      ok: true,
      lead: { ...lead, status_label: getLeadStatusLabel(lead.status) },
    });
  });

  // --- Conversations ---

  router.get("/conversations", (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const conversations = repos.conversations.listRecent(limit);
    res.json({ ok: true, conversations });
  });

  router.get("/conversations/:clientId/messages", (req, res) => {
    const clientId = Number(req.params.clientId);
    const conversation = repos.conversations.getByClientId(clientId);
    if (!conversation) {
      return res.status(404).json({ ok: false, error: "Conversation not found" });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const messages = repos.messages.listByConversation(conversation.id, limit);
    const client = repos.users.getById(clientId);

    res.json({
      ok: true,
      conversation,
      client: client || null,
      messages: messages.reverse(),
    });
  });

  router.post("/conversations/:clientId/reply", async (req, res) => {
    const clientId = Number(req.params.clientId);
    const { text } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }

    try {
      await conversationService.sendAdminReply({
        adminTelegramId: adminId,
        clientId,
        text: text.trim(),
      });
      res.json({ ok: true });
    } catch (error) {
      if (error?.code === "TELEGRAM_DELIVERY_DISABLED") {
        return res.status(503).json({
          ok: false,
          error: "Telegram delivery is disabled for this runtime",
        });
      }
      res.status(500).json({ ok: false, error: "Failed to send reply" });
    }
  });

  // --- Products ---

  router.get("/products", (_req, res) => {
    const products = repos.products.listAll();
    res.json({ ok: true, products });
  });

  router.post("/products", (req, res) => {
    const { code, title, description, price_text } = req.body;
    if (!code || !title) {
      return res.status(400).json({ ok: false, error: "code and title are required" });
    }

    const existing = repos.products.getByCode(code);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Product code already exists" });
    }

    const product = repos.products.create({
      code,
      title,
      description: description || "",
      price_text: price_text || "",
      sort_order: 0,
    });

    res.status(201).json({ ok: true, product });
  });

  router.patch("/products/:id", (req, res) => {
    const id = Number(req.params.id);
    const existing = repos.products.getById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    const product = repos.products.update({
      id,
      title: req.body.title !== undefined ? req.body.title : existing.title,
      description: req.body.description !== undefined ? req.body.description : existing.description,
      price_text: req.body.price_text !== undefined ? req.body.price_text : existing.price_text,
      sort_order: req.body.sort_order !== undefined ? req.body.sort_order : existing.sort_order,
    });

    res.json({ ok: true, product });
  });

  router.patch("/products/:id/toggle", (req, res) => {
    const id = Number(req.params.id);
    const existing = repos.products.getById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Product not found" });
    }

    const product = repos.products.setActive(id, !existing.is_active);
    res.json({ ok: true, product });
  });

  // --- Users ---

  router.get("/users", (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const users = repos.users.listPaginated(limit, offset);
    const total = repos.users.countAll();

    res.json({
      ok: true,
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  });

  router.patch("/users/:id/block", (req, res) => {
    const telegramId = Number(req.params.id);
    const user = repos.users.getById(telegramId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    if (user.is_blocked) {
      repos.users.unblock(telegramId);
    } else {
      repos.users.block(telegramId);
    }

    const updated = repos.users.getById(telegramId);
    res.json({ ok: true, user: updated });
  });

  // --- Stats ---

  router.get("/stats", (_req, res) => {
    const total = repos.stats.totalLeads();
    const byStatus = repos.stats.leadCountsByStatus();
    const topProducts = repos.stats.topProductsByLeads(5);
    const newToday = repos.leads.countNewToday();
    const dashboard = {
      last24Hours: {
        draftsStarted: repos.leadEvents?.countByTypeSince?.(
          "lead_flow_started",
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        ) || 0,
        confirmedLeads: repos.leadEvents?.countByTypeSince?.(
          "lead_confirmed",
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        ) || 0,
      },
      overdueLeads: repos.stats.countOverdueLeads(),
    };

    res.json({
      ok: true,
      stats: { total, newToday, byStatus, topProducts, dashboard },
    });
  });

  router.get("/stats/daily", (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const daily = repos.stats.dailyLeadCounts(days);
    res.json({ ok: true, daily });
  });

  // --- Export ---

  router.get("/export/leads", (_req, res) => {
    const leads = repos.leads.listAll();

    const headers = [
      "id", "status", "closed_reason", "product_code", "product_name", "quantity",
      "comment", "contact_label", "client_telegram_id", "username",
      "first_name", "last_name", "source_payload", "first_admin_reply_at",
      "next_follow_up_at", "created_at", "updated_at",
    ];

    // Protects exported CSV from spreadsheet formula injection.
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

    const rows = leads.map((l) => headers.map((h) => escapeCsv(l[h])).join(","));
    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=leads_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  });

  return router;
}

module.exports = { createAdminRoutes };
