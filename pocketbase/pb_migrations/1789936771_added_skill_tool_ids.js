/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const skills = app.findCollectionByNameOrId("pbc_3793906494")
  const versions = app.findCollectionByNameOrId("pbc_2090817719")

  skills.fields.add(new Field({
    "help": "Canonical tool IDs referenced by this skill as non-authoritative context hints.",
    "hidden": false,
    "id": "json7000000001",
    "maxSize": 0,
    "name": "toolIds",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))
  versions.fields.add(new Field({
    "help": "Canonical tool IDs referenced by this skill as non-authoritative context hints.",
    "hidden": false,
    "id": "json7000000002",
    "maxSize": 0,
    "name": "toolIds",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  app.save(skills)
  return app.save(versions)
}, (app) => {
  const skills = app.findCollectionByNameOrId("pbc_3793906494")
  const versions = app.findCollectionByNameOrId("pbc_2090817719")
  skills.fields.removeById("json7000000001")
  versions.fields.removeById("json7000000002")
  app.save(skills)
  return app.save(versions)
})
