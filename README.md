# Subpolar
Turning Pi into a general-purpose agent

## Core Principles
- Isolation: Stateless where possible
- Modularity: Pi's extensibility at its core
- Transparency
- Portability: Run anywhere you need it to

## WebUI

`@webui` is a local browser UI connected to Pi through `pi --mode rpc`. Read
`WEBUI_FEATURES.md` for feature scope and `@webui/README.md` for startup and
endpoint details.

Start bridge and Vite together:

```sh
./start-webui.sh
```

Open `http://localhost:5173`.
