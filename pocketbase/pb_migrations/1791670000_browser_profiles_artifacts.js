/// <reference path="../pb_data/types.d.ts" />
migrate(
  (app) => {
    const profiles = new Collection({
      name: 'browser_profiles',
      type: 'base',
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: 'owner_id', type: 'text', required: true },
        { name: 'name', type: 'text', required: true, max: 100 },
        { name: 'created_at', type: 'number', required: true },
        { name: 'updated_at', type: 'number', required: true },
      ],
      indexes: [
        'CREATE INDEX idx_browser_profiles_owner ON browser_profiles (owner_id)',
      ],
    })
    app.save(profiles)
    const screenshots = new Collection({
      name: 'browser_screenshots',
      type: 'base',
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        ...[
          'owner_id',
          'browser_session_id',
          'session_id',
          'project_id',
          'task_id',
          'tool_call_id',
          'operation',
          'tab_id',
          'status',
        ].map((name) => ({ name, type: 'text' })),
        { name: 'created_at', type: 'number' },
        { name: 'expires_at', type: 'number' },
        {
          name: 'image',
          type: 'file',
          maxSelect: 1,
          maxSize: 8388608,
          protected: true,
          mimeTypes: ['image/png', 'image/jpeg'],
        },
      ],
      indexes: [
        'CREATE INDEX idx_browser_screenshots_owner ON browser_screenshots (owner_id, created_at)',
      ],
    })
    app.save(screenshots)
    const downloads = new Collection({
      name: 'browser_downloads',
      type: 'base',
      fields: [
        ...['owner_id', 'browser_session_id', 'tool_call_id'].map((name) => ({
          name,
          type: 'text',
        })),
        { name: 'created_at', type: 'number' },
        { name: 'expires_at', type: 'number' },
        {
          name: 'file',
          type: 'file',
          maxSelect: 1,
          maxSize: 16777216,
          protected: true,
        },
      ],
    })
    app.save(downloads)
    const sessions = app.findCollectionByNameOrId('browser_sessions')
    sessions.fields.add(new TextField({ name: 'profile_id' }))
    app.save(sessions)
    const agents = app.findCollectionByNameOrId('agents')
    agents.fields.add(new JSONField({ name: 'browser' }))
    app.save(agents)
  },
  (app) => {
    for (const name of [
      'browser_downloads',
      'browser_screenshots',
      'browser_profiles',
    ])
      app.delete(app.findCollectionByNameOrId(name))
    const sessions = app.findCollectionByNameOrId('browser_sessions')
    sessions.fields.removeByName('profile_id')
    app.save(sessions)
    const agents = app.findCollectionByNameOrId('agents')
    agents.fields.removeByName('browser')
    app.save(agents)
  },
)
