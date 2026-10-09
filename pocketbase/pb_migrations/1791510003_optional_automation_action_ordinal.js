/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("subpolar_automation_action_executions")
  const ordinal = collection.fields.getByName("ordinal")
  if (ordinal) {
    ordinal.required = false
    app.save(collection)
  }
}, (app) => {
  // Zero-based action order remains valid after a rollback.
})
