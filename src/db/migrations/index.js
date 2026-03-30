const initialMigration = require("./001_initial");
const phase2ColumnsMigration = require("./002_phase2_columns");
const isBlockedMigration = require("./003_is_blocked");
const normalizeLeadStatusNewMigration = require("./004_normalize_lead_status_new");
const addIndexesMigration = require("./005_add_indexes");
const openLeadUniquenessMigration = require("./006_open_lead_uniqueness");
const messageTypeMigration = require("./007_message_type");
const leadTrackingTokenMigration = require("./008_lead_tracking_token");
const leadWorkflowOpsMigration = require("./009_lead_workflow_ops");
const lawfulInquiryCleanupMigration = require("./010_lawful_inquiry_cleanup");
const lineItemsJsonMigration = require("./010_line_items_json");
const moreIndexesMigration = require("./011_more_indexes");

const migrations = [
  initialMigration,
  phase2ColumnsMigration,
  isBlockedMigration,
  normalizeLeadStatusNewMigration,
  addIndexesMigration,
  openLeadUniquenessMigration,
  messageTypeMigration,
  leadTrackingTokenMigration,
  leadWorkflowOpsMigration,
  lawfulInquiryCleanupMigration,
  lineItemsJsonMigration,
  moreIndexesMigration,
];

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function runMigrations(db) {
  ensureMigrationTable(db);

  const appliedIds = new Set(
    db
      .prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC")
      .all()
      .map((row) => row.id),
  );

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    const transaction = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(
        migration.id,
      );
    });

    transaction();
  }
}

module.exports = {
  runMigrations,
};
