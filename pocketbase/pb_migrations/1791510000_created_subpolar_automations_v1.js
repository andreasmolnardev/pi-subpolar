/// <reference path="../pb_data/types.d.ts" />
const text = (name, required = false) => ({ name, type: "text", required })
const json = (name, required = false) => ({ name, type: "json", required })
const bool = (name, required = false) => ({ name, type: "bool", required })
const number = (name, required = false) => ({ name, type: "number", required })
const select = (name, values, required = false) => ({ name, type: "select", values, maxSelect: 1, required })

const schemas = [
  {
    name: "subpolar_automations",
    fields: [text("automationId", true), text("ownerId", true), text("name", true), text("description"), bool("enabled"), text("agentId", true), text("promptTemplate", true), text("projectId"), json("trigger", true), json("actions", true), json("executionConfig"), text("createdAt", true), text("updatedAt", true), text("deletedAt")],
    indexes: ["CREATE UNIQUE INDEX idx_subpolar_automations_owner_key ON subpolar_automations (ownerId, automationId)", "CREATE INDEX idx_subpolar_automations_owner_enabled ON subpolar_automations (ownerId, enabled, updatedAt)"],
  },
  {
    name: "subpolar_automation_occurrences",
    fields: [text("occurrenceId", true), text("ownerId", true), text("automationId", true), text("occurrenceKey", true), text("triggerType", true), json("trigger"), json("payload"), text("scheduledAt"), text("receivedAt", true), select("status", ["pending", "claimed", "completed", "failed", "cancelled", "unknown"], true), text("executionId"), text("claimedAt"), text("completedAt"), json("error")],
    indexes: ["CREATE UNIQUE INDEX idx_subpolar_automation_occurrence_key ON subpolar_automation_occurrences (ownerId, automationId, occurrenceKey)", "CREATE INDEX idx_subpolar_automation_occurrence_status ON subpolar_automation_occurrences (ownerId, automationId, status, receivedAt)"],
  },
  {
    name: "subpolar_automation_executions",
    fields: [text("executionId", true), text("ownerId", true), text("automationId", true), text("agentId", true), text("projectId"), text("occurrenceId", true), text("occurrenceKey"), json("trigger"), text("canonicalRunId"), json("resolvedInput", true), select("status", ["pending", "running", "waiting_approval", "processing_output", "completed", "failed", "cancelled", "interrupted", "unknown"], true), json("output"), json("error"), text("createdAt", true), text("updatedAt", true), text("startedAt"), text("completedAt")],
    indexes: ["CREATE UNIQUE INDEX idx_subpolar_automation_execution_key ON subpolar_automation_executions (ownerId, executionId)", "CREATE INDEX idx_subpolar_automation_execution_history ON subpolar_automation_executions (ownerId, automationId, createdAt)"],
  },
  {
    name: "subpolar_automation_action_executions",
    fields: [text("actionExecutionId", true), text("ownerId", true), text("executionId", true), text("actionId", true), text("actionType", true), number("ordinal"), select("status", ["pending", "running", "completed", "failed", "skipped", "unknown"], true), json("input"), json("result"), json("error"), text("createdAt", true), text("updatedAt", true), text("startedAt"), text("completedAt")],
    indexes: ["CREATE UNIQUE INDEX idx_subpolar_automation_action_key ON subpolar_automation_action_executions (ownerId, actionExecutionId)", "CREATE UNIQUE INDEX idx_subpolar_automation_action_identity ON subpolar_automation_action_executions (ownerId, executionId, actionId)", "CREATE INDEX idx_subpolar_automation_action_order ON subpolar_automation_action_executions (ownerId, executionId, ordinal)"],
  },
  {
    name: "subpolar_automation_schedules",
    fields: [text("ownerId", true), text("automationId", true), text("nextRunAt"), text("lastRunAt"), text("lastOccurrenceKey"), text("updatedAt", true)],
    indexes: ["CREATE UNIQUE INDEX idx_subpolar_automation_schedule_owner ON subpolar_automation_schedules (ownerId, automationId)", "CREATE INDEX idx_subpolar_automation_schedule_due ON subpolar_automation_schedules (nextRunAt)"],
  },
]

migrate((app) => {
  for (const schema of schemas) {
    app.save(new Collection({
      name: schema.name,
      type: "base",
      system: false,
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: schema.fields,
      indexes: schema.indexes,
    }))
  }
}, (app) => {
  for (const schema of [...schemas].reverse()) {
    const collection = app.findCollectionByNameOrId(schema.name)
    app.delete(collection)
  }
})
