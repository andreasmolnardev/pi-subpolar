# PocketBase

`pi-subpolar` expects a PocketBase server at `POCKETBASE_URL` and authenticates to it
with the configured superuser credentials. This directory is reserved for PocketBase
data and migration assets; the Bun bridge creates or extends the required application
collections on startup so it can connect to an existing Subpolar PocketBase instance.

For local development, install PocketBase separately and run:

```sh
pocketbase serve --http=127.0.0.1:8090
```

Create the first PocketBase superuser through the PocketBase admin UI, then set
`POCKETBASE_EMAIL` and `POCKETBASE_PASSWORD` in the repository `.env` file. Do not
commit `pb_data` or any credentials.
