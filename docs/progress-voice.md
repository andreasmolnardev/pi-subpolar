# Feature 3 — local STT/TTS progress

## Scope and validation status

Implemented within `@subpolar-agent/server/voice/**`, `@subpolar-agent/src/api/{stt,tts,voice}.ts`, and voice tests. The dedicated `@subpolar-agent/server/voice/routes.ts` was changed with explicit permission. No general server routes, auth files, root README, dependencies, or cloud providers were changed. No `src/components/voice/**` directory exists.

**Real speech recognition/synthesis has not been tested.** No live bridge/PocketBase deployment or installed speech engine was contacted, no model was downloaded, and no real recordings were processed. Tests use disconnected backends, mocked HTTP responses, and short-lived Node executables emitting synthetic bytes/JSON. Executable discovery is not a model-health check.

## Concrete fixes

- Process discovery checks for an executable regular file, including PATH lookup, rather than claiming any nonempty command is available. Missing executable details do not expose paths.
- STT/TTS child handling captures close/error events before reading output, handles stdin errors, removes request abort listeners, and maps failures to typed, sanitized errors. STT JSON must contain a string `final` or `text`; malformed/empty output is rejected.
- Process adapters bound stdin inputs, stdout bytes, and execution time. Cancellation/deadline sends SIGTERM, then SIGKILL after a one-second grace period if the direct child has not closed. Pre-aborted operations do not spawn.
- STT executable wrappers receive MIME/language metadata in environment variables while retaining the raw-byte stdin protocol.
- Route cleanup is separate from abort. **An unconfigured TTS backend now returns `503 UNAVAILABLE`, not the erroneous `408 TIMEOUT`.** Ordinary malformed requests/backend errors are no longer mislabeled as timeout. All regressions are normal tests; no expected-failure marker remains.
- The dedicated route races upload reads, parsing, backend promises, and iterator reads against a genuine deadline/caller abort. A noncooperative callback no longer holds the HTTP operation open indefinitely. Upload readers are canceled on failure.
- TTS preflights the first iterator result so lazy process startup failures return a JSON error before HTTP 200 audio headers. Streaming uses pull-based backpressure, bounds response bytes, sanitizes stream errors, and signals cancellation/returns the iterator without waiting forever for an uncooperative callback.
- Client STT/TTS requests include cookies, preserve backend HTTP/error codes, reject oversized inputs, handle pre-abort, and keep cancellation/deadline active through body consumption. Response buffering is bounded. Malformed STT success payloads and malformed session URL encoding are handled safely.
- The existing streaming-upload test now supplies Node's required `duplex: 'half'` instead of failing before it reaches the voice handler.

## Actual deployment wiring and prerequisites

The bridge constructs `localVoiceBackends()` once at startup from these variables; restart it after changing them:

| Variable | Meaning |
| --- | --- |
| `SUBPOLAR_VOICE_STT_EXECUTABLE` | One local executable/wrapper path; no shell command or argument string |
| `SUBPOLAR_VOICE_TTS_EXECUTABLE` | One local executable/wrapper path; no shell command or argument string |
| `SUBPOLAR_VOICE_STT_MODELS` | Optional comma-separated discovery labels |
| `SUBPOLAR_VOICE_TTS_MODELS` | Optional comma-separated discovery labels |
| `SUBPOLAR_VOICE_TTS_VOICES` | Optional comma-separated discovery labels |

Install your chosen **offline** speech engine, model files, audio decoder, and protocol-compatible wrappers separately. This repository does not install an engine/model or ship a working engine-specific wrapper. A native Whisper/Piper CLI is not automatically compatible with the protocols below. Model/voice labels only advertise administrator-configured capabilities; they neither download nor verify models. STT's request port currently accepts language but no model selector.

The bridge needs working PocketBase application collections and a durable owned session with an enabled stored agent (or the current master fallback). Configure `POCKETBASE_URL` (default `http://127.0.0.1:8090`), `POCKETBASE_EMAIL`, and `POCKETBASE_PASSWORD` for the existing PocketBase admin connection. Use the existing application setup for collections/user/session creation; this work does not change authentication/bootstrap. Enable the local provider in UI preferences for voice controls; preferences alone do not install or prove backend availability. The route itself does not use the preference's enabled flag as an authorization check.

### Executable protocols

**STT:** raw recording bytes on stdin until EOF. The wrapper decodes the actual recording format; do not assume WAV when browsers send WebM/Opus, Ogg, or MP4. `SUBPOLAR_VOICE_AUDIO_MIME_TYPE` contains the supplied MIME type (potentially codec parameters), and `SUBPOLAR_VOICE_AUDIO_LANGUAGE` contains the optional language or an empty string. These values are caller input, not trustworthy format validation or shell fragments. Write only UTF-8 JSON to stdout, e.g. `{"final":"recognized text","partial":"optional preview"}`; `{"text":"recognized text"}` is also accepted. This is one final HTTP JSON response, not live partial transcription streaming. Exit zero on success.

**TTS:** one UTF-8 JSON object on stdin until EOF, containing `text` and optional `voice`, `model`, `speed`. Write only **MP3 audio** bytes to stdout and exit zero on success: the current dedicated route returns `Content-Type: audio/mpeg`. An engine producing WAV/PCM needs wrapper-side conversion (e.g. a local encoder); output MIME negotiation is not implemented. Diagnostics belong on stderr, which the adapter discards. Never print logs to stdout.

Wrappers run with the bridge's account/environment, without a shell, and must own/clean up any subprocesses they create. Use trusted executables, provision model files ahead of time, and explicitly disable engine downloads/remote calls for an offline deployment. The adapter does not sandbox executable network access or engine-internal memory/CPU usage.

### Startup commands

From the repository root, with Node dependencies installed and Bun available:

```sh
npm --prefix @subpolar-agent install
bun --env-file=.env @subpolar-agent/bridge.ts
```

Alternatively `./start-subpolar-agent.sh` launches both bridge and Vite, loads a root `.env` if present, and waits for bridge health. The bridge binds `127.0.0.1`; its default port is `4173` (`SUBPOLAR_AGENT_PORT` overrides it). Run persistent startup commands yourself; they were not run during this task.

Example `.env` deployment template (replace paths, labels, and credentials with your actual local installation; these are **not** tested or preinstalled paths):

```dotenv
POCKETBASE_URL=http://127.0.0.1:8090
POCKETBASE_EMAIL=REPLACE_WITH_ADMIN_EMAIL
POCKETBASE_PASSWORD=REPLACE_WITH_ADMIN_PASSWORD
SUBPOLAR_VOICE_STT_EXECUTABLE=/opt/subpolar/voice/local-stt
SUBPOLAR_VOICE_TTS_EXECUTABLE=/opt/subpolar/voice/local-tts
SUBPOLAR_VOICE_STT_MODELS=installed-local-stt-model
SUBPOLAR_VOICE_TTS_MODELS=installed-local-tts-model
SUBPOLAR_VOICE_TTS_VOICES=installed-local-voice
```

Keep credentials private and do not commit `.env`. Executable variables must name actual executable files, not `/path/engine --model file` strings. Argument/model selection belongs in wrappers. Configured callbacks remain available through the library adapter ports but are not installed through an environment variable.

### Authenticated live checks — not run

Every voice operation, including discovery, requires a real durable `sessionId` query parameter or `x-session-id` header. The bridge derives identity from the normal cookie, gateway credential, or internal credential; caller `userId` is not ownership evidence. Gateway access requires `call` permission and matching owner/project/agent/session scope. The browser client derives `x-session-id` from the active `/sessions/:id` URL; requests outside a session do not bypass this requirement.

The following templates use an existing gateway credential. Replace `subpolar_gw_REPLACE_WITH_VALID_TOKEN`, `REPLACE_WITH_OWNED_SESSION_ID`, and `recording.wav` with real authorized values/files. Avoid exposing tokens in shared shell history; the application UI with its existing cookie is another option. Use same-origin UI/proxy configuration rather than assuming arbitrary cross-origin voice headers are accepted.

```sh
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' http://127.0.0.1:4173/api/stt/status
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' http://127.0.0.1:4173/api/stt/models
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' http://127.0.0.1:4173/api/tts/status
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' http://127.0.0.1:4173/api/tts/models
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' http://127.0.0.1:4173/api/tts/voices
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' --form 'audio=@recording.wav;type=audio/wav' --form 'language=en' http://127.0.0.1:4173/api/stt/transcribe
curl --fail-with-body --max-time 35 --header 'Authorization: Bearer subpolar_gw_REPLACE_WITH_VALID_TOKEN' --header 'x-session-id: REPLACE_WITH_OWNED_SESSION_ID' --header 'Content-Type: application/json' --data '{"text":"Local voice smoke test"}' --output local-voice-smoke.mp3 http://127.0.0.1:4173/api/tts/synthesize
```

With no backend configured, authorized discovery returns `available: false`; model/voice discovery additionally returns empty lists, `cached: false`, and `state: "unconfigured"`. STT/TTS operations return sanitized `503 UNAVAILABLE`. A successful executable-file check reports `available: true`, but only a successful real operation proves usable model/decoder/encoder deployment. Verify HTTP status and actual MP3 decoding/playback before treating the output file as audio; a failure after headers cannot change HTTP 200 to a JSON error.

## Data and time limits

| Boundary | Limit |
| --- | --- |
| STT recording bytes | 10 MiB = 10,485,760 bytes |
| Complete multipart request | 10 MiB + 64 KiB = 10,551,296 bytes, including boundaries/fields |
| TTS text | 32,000 UTF-16 code units after trimming, not graphemes |
| Complete TTS JSON request | 129,024 bytes (`32_000 * 4 + 1024`); escaped JSON/metadata count too |
| Local process STT stdout | 256 KiB = 262,144 bytes of UTF-8 JSON |
| TTS process/route/client audio output | 32 MiB = 33,554,432 bytes |
| Client STT JSON/error-response buffering | 256 KiB = 262,144 bytes |
| Voice route deadline | 30 seconds across body parsing/backend work/streaming, starting after authorization |
| Local child execution deadline | 30 seconds per process, independently of the route deadline |
| Client STT / TTS deadline | 60 seconds / 30 seconds, including response-body consumption |
| Direct child termination grace | SIGTERM, then SIGKILL after 1 second if not closed |

Exactly-at-limit byte counts are allowed; multipart overhead still counts against the complete-body limit. Limits are fixed constants, not environment settings. The voice deadline does not bound the outer PocketBase authorization/bootstrap work. HTTP errors are `413 SIZE_LIMIT`, `503 UNAVAILABLE`, `408 TIMEOUT`, `499 CANCELED`, or a sanitized `400` for malformed/invalid input/output. After audio headers, failures error the stream instead of returning a new HTTP status. Clients must handle body-read failure and not play partial error output.

## Reproducible validation

Run from `@subpolar-agent` (tested with Node `v22.23.2`; Bun `1.3.14` was present but no live Bun voice server was run):

```sh
./node_modules/.bin/vitest run --config server/voice/vitest.config.ts --reporter=dot
./node_modules/.bin/vitest run src/api/stt.test.ts src/api/tts.test.ts src/api/voice.test.ts server/tests/voice.test.ts --reporter=dot
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --noUnusedLocals --noUnusedParameters --target ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --types node server/voice/contracts.ts server/voice/adapters.ts server/voice/routes.ts server/voice/adapters.spec.ts server/voice/routes.spec.ts server/voice/vitest.config.ts
```

Results: isolated server voice suite **44 passed**; client/existing voice suite **44 passed**; focused server voice typecheck **passed**. The isolated `.spec.ts` suite/config avoids the browser-only shared setup and does not alter the parent Vitest configuration. Coverage includes discovery, authorization-before-backend, absent/broken executables, JSON/error contracts, input/output limits, real deadline vs cancellation, stalled uploads/iterators, listener cleanup, backpressure, and SIGKILL escalation for a synthetic child ignoring SIGTERM.

Broader typechecks were attempted, not fixed: `tsc --noEmit -p tsconfig.bridge.json` reported errors outside these owned voice files (31 errors at that run); `tsc --noEmit -p tsconfig.app.json --pretty false` reported `src/components/navigation/DesktopSidebar.tsx:372` (`{}` not assignable to `string`). The initial frontend check timed out at 60 seconds before the longer retry completed. Parent work owns those findings.

## Remaining work / constraints

- Install and validate real offline STT/TTS engines, model files, format-compatible wrappers, and actual recordings/MP3 playback on the target deployment. Recognition quality, language behavior, voice quality, warm-start latency, and browser microphone/playback are unverified.
- Real cookie/gateway/PocketBase ownership integration was inspected, not tested against a configured deployment. Unit tests exercise the injected authorization gate, not a live identity/session database.
- Process discovery verifies file/execution permissions, not engine startup/model readiness. Status payloads currently contain `{available, kind, name, detail?}`, not the legacy client `enabled/configured/cache` fields; do not treat those legacy fields or enabled local preferences as readiness evidence.
- Callback libraries must cooperate with abort and release their own resources. HTTP cancellation is bounded, but JavaScript cannot forcibly terminate a callback promise/iterator. STT callback output is not server-byte-bounded like process stdout; client response buffering is bounded.
- Termination targets the direct child, not an arbitrary descendant process tree. Wrappers spawning decoders/encoders must clean up descendants or exec their engine. Per-user concurrency quotas and engine-internal resource sandboxing are not added.
- TTS remains MP3-only at the route boundary; MIME negotiation and live STT partial streaming are not implemented. Browser Web Speech is not used as proof of offline local support.
