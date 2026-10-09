/// <reference path="../pb_data/types.d.ts" />
const text = (name, required = false) => ({ name, type: "text", required })

migrate((app) => {
  app.save(new Collection({
    name: "subpolar_automation_webhook_secrets",
    type: "base",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      text("ownerId", true),
      text("automationId", true),
      text("credentialRef", true),
      text("secretHash", true),
      text("createdAt", true),
      text("updatedAt", true),
      text("lastUsedAt"),
      text("revokedAt"),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_subpolar_automation_webhook_secret_ref ON subpolar_automation_webhook_secrets (credentialRef)",
      "CREATE INDEX idx_subpolar_automation_webhook_secret_owner ON subpolar_automation_webhook_secrets (ownerId, automationId)",
    ],
  }))
}, (app) => {
  const collection = app.findCollectionByNameOrId("subpolar_automation_webhook_secrets")
  app.delete(collection)
})
