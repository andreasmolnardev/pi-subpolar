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
        "id": "text2117886457",
        "max": 0,
        "min": 0,
        "name": "owner_id",
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
        "id": "text416975325",
        "max": 0,
        "min": 0,
        "name": "inbox_id",
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
        "id": "text2585298908",
        "max": 0,
        "min": 0,
        "name": "subscription_id",
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
        "id": "text2906636301",
        "max": 0,
        "min": 0,
        "name": "delivery_key",
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
          "pending",
          "delivered",
          "failed"
        ]
      },
      {
        "help": "",
        "hidden": false,
        "id": "number418120294",
        "max": null,
        "min": null,
        "name": "attempt",
        "onlyInt": false,
        "presentable": false,
        "required": true,
        "system": false,
        "type": "number"
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text3553252396",
        "max": 0,
        "min": 0,
        "name": "lease_id",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number2720876809",
        "max": null,
        "min": null,
        "name": "lease_expires_at",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number3681079236",
        "max": null,
        "min": null,
        "name": "next_attempt_at",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number2374717165",
        "max": null,
        "min": null,
        "name": "last_attempt_at",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "select2846427312",
        "maxSelect": 1,
        "name": "failure_class",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "select",
        "values": [
          "retryable",
          "permanent"
        ]
      },
      {
        "autogeneratePattern": "",
        "help": "",
        "hidden": false,
        "id": "text737763667",
        "max": 0,
        "min": 0,
        "name": "error_message",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number2341372968",
        "max": null,
        "min": null,
        "name": "created_at",
        "onlyInt": false,
        "presentable": false,
        "required": true,
        "system": false,
        "type": "number"
      },
      {
        "help": "",
        "hidden": false,
        "id": "number1130519967",
        "max": null,
        "min": null,
        "name": "updated_at",
        "onlyInt": false,
        "presentable": false,
        "required": true,
        "system": false,
        "type": "number"
      }
    ],
    "id": "pbc_3309262634",
    "indexes": [
      "CREATE UNIQUE INDEX idx_notification_deliveries_key ON notification_deliveries (delivery_key)",
      "CREATE INDEX idx_notification_deliveries_inbox ON notification_deliveries (owner_id, inbox_id, created_at)",
      "CREATE INDEX idx_notification_deliveries_due ON notification_deliveries (state, next_attempt_at, lease_expires_at)"
    ],
    "listRule": null,
    "name": "notification_deliveries",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_3309262634");

  return app.delete(collection);
})
