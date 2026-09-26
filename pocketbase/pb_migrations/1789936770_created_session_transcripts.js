/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    name: "session_transcripts",
    type: "base",
    system: false,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        id: "text3208210256", name: "id", type: "text", system: true, primaryKey: true,
        required: true, autogeneratePattern: "[a-z0-9]{15}", min: 15, max: 15, pattern: "^[a-z0-9]+$",
      },
      { name: "owner_id", type: "text", required: true },
      { name: "session_id", type: "text", required: true },
      { name: "entries", type: "json", required: true },
      { name: "leaf_id", type: "text" },
      { name: "updated_at", type: "number", required: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_session_transcripts_key ON session_transcripts (owner_id, session_id)",
      "CREATE INDEX idx_session_transcripts_updated ON session_transcripts (owner_id, updated_at)",
    ],
  })
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("session_transcripts")
  return app.delete(collection)
})
