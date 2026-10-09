/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const collection = app.findCollectionByNameOrId("subpolar_automations")
  const config = collection.fields.getByName("executionConfig")
  if (config) {
    config.required = false
    app.save(collection)
  }
}, (app) => {
  // An empty execution config is a valid domain default, so keep it optional
  // when rolling back this schema adjustment.
})
