/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2726680096")

  // add field
  collection.fields.addAt(10, new Field({
    "help": "",
    "hidden": false,
    "id": "select2539659139",
    "maxSelect": 1,
    "name": "template",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "select",
    "values": [
      "general",
      "coding",
      "plan",
      "reviewer"
    ]
  }))

  // add field
  collection.fields.addAt(11, new Field({
    "autogeneratePattern": "",
    "help": "",
    "hidden": false,
    "id": "text3616895705",
    "max": 0,
    "min": 0,
    "name": "model",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // add field
  collection.fields.addAt(12, new Field({
    "help": "",
    "hidden": false,
    "id": "select2131879744",
    "maxSelect": 1,
    "name": "thinking",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "select",
    "values": [
      "off",
      "minimal",
      "low",
      "medium",
      "high"
    ]
  }))

  // add field
  collection.fields.addAt(13, new Field({
    "help": "",
    "hidden": false,
    "id": "select1125801284",
    "maxSelect": 1,
    "name": "approval_mode",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "select",
    "values": [
      "auto",
      "ask",
      "deny"
    ]
  }))

  // add field
  collection.fields.addAt(14, new Field({
    "help": "",
    "hidden": false,
    "id": "json3767254990",
    "maxSize": 0,
    "name": "policies",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  // add field
  collection.fields.addAt(15, new Field({
    "help": "",
    "hidden": false,
    "id": "json3671105325",
    "maxSize": 0,
    "name": "project_overrides",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  // add field
  collection.fields.addAt(16, new Field({
    "help": "",
    "hidden": false,
    "id": "json3585983705",
    "maxSize": 0,
    "name": "tool_context_modes",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  // add field
  collection.fields.addAt(17, new Field({
    "help": "",
    "hidden": false,
    "id": "json3843432174",
    "maxSize": 0,
    "name": "skill_context_modes",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  // add field
  collection.fields.addAt(18, new Field({
    "help": "",
    "hidden": false,
    "id": "json3020342330",
    "maxSize": 0,
    "name": "effective_source",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2726680096")

  // remove field
  collection.fields.removeById("select2539659139")

  // remove field
  collection.fields.removeById("text3616895705")

  // remove field
  collection.fields.removeById("select2131879744")

  // remove field
  collection.fields.removeById("select1125801284")

  // remove field
  collection.fields.removeById("json3767254990")

  // remove field
  collection.fields.removeById("json3671105325")

  // remove field
  collection.fields.removeById("json3585983705")

  // remove field
  collection.fields.removeById("json3843432174")

  // remove field
  collection.fields.removeById("json3020342330")

  return app.save(collection)
})
