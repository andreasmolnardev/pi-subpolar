/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_3411891292")

  // add field
  collection.fields.addAt(15, new Field({
    "autogeneratePattern": "",
    "help": "",
    "hidden": false,
    "id": "text2117886457",
    "max": 0,
    "min": 0,
    "name": "owner_id",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_3411891292")

  // remove field
  collection.fields.removeById("text2117886457")

  return app.save(collection)
})
