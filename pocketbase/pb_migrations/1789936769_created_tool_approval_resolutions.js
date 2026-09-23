/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "[a-z0-9]{15}",
        "help": "",
        "hidden": false,
        "id": "text3208210256",
        "max": 15,
        "min": 15,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text4268093440",
        "max": 0,
        "min": 0,
        "name": "approval_id",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text2809058197",
        "max": 0,
        "min": 0,
        "name": "user_id",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "help": "",
        "hidden": false,
        "id": "select2744374011",
        "maxSelect": 1,
        "name": "state",
        "presentable": false,
        "required": true,
        "system": false,
        "type": "select",
        "values": [
          "approved",
          "rejected",
          "expired"
        ]
      },
      {
        "help": "",
        "hidden": false,
        "id": "number2096107013",
        "max": null,
        "min": null,
        "name": "claimed_at",
        "onlyInt": false,
        "presentable": false,
        "required": true,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number3537997662",
        "max": null,
        "min": null,
        "name": "claim_expires_at",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "select2682141117",
        "maxSelect": 1,
        "name": "claim_state",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "select",
        "values": [
          "active",
          "interrupted"
        ]
      },
      {
        "help": "",
        "hidden": false,
        "id": "number479264616",
        "max": null,
        "min": null,
        "name": "interrupted_at",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      }
    ],
    "id": "pbc_2596550271",
    "indexes": [
      "CREATE UNIQUE INDEX idx_tool_approval_resolution_approval ON tool_approval_resolutions (approval_id)"
    ],
    "listRule": null,
    "name": "tool_approval_resolutions",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2596550271");

  return app.delete(collection);
})
