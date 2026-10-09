/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("subpolar_automations")
  const enabled = collection.fields.getByName("enabled")
  if (enabled) {
    enabled.required = false
    app.save(collection)
  }
}, (app) => {
  // Disabled is represented by false, which PocketBase's required bool rejects.
  // Keep the value optional when rolling back this compatibility migration.
})
