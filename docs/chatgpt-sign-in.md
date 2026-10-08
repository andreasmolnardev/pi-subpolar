# Sign in with ChatGPT

## Normal OpenAI sign-in, not Codex login

The Subpolar Agent now uses Pi **1.0.2**'s native **Sign in with ChatGPT** on the normal `openai` provider. This shares a user-authorized access token with the OpenAI Responses API at `https://api.openai.com/v1/responses`. A normal OpenAI API key remains an alternative on that same provider.

The previous guide incorrectly presented Pi 0.84.4's existing `openai-codex` OAuth as this new login. These are separate implementations:

| Choice | Pi provider | Inference service | Login |
| --- | --- | --- | --- |
| Sign in with ChatGPT | `openai` | OpenAI Responses API | Native browser authorization / full redirect-URL fallback |
| OpenAI API key | `openai` | OpenAI Responses API | Native secret API-key prompt; normal API billing |
| Codex subscription | `openai-codex` | Native Codex Responses service | Separate native browser or device-code login |

## Connect a normal OpenAI account

1. Open **Settings → Providers → Providers** and select **Sign in with ChatGPT**.
2. Optionally label the account (for example, Personal or Work). The dialog also offers **OpenAI API key** if you prefer API-key authentication.
3. Select **Continue**, open the authorization page, and finish OpenAI's sign-in/consent flow.
4. Pi's callback listener runs on the **bridge server**, at `http://127.0.0.1:1455/auth/callback`. If your browser cannot reach it, copy and submit the **full final redirect URL**, including `code`, `state`, and the issued `client_id`. Do not submit just an authorization code. A browser localhost connection failure does not prevent copying its final URL.
5. After connection, choose a model belonging to the saved **OpenAI** account in the model picker or Default Models settings. Account-qualified selections have the form `openai~<account-instance>/model-id`.

**This normal OpenAI flow does not offer device-code login.** For the separate Codex provider, use its provider card's **Add another account**, select its subscription method, and follow Pi's browser/device-code prompts. Codex credentials are not interchangeable with normal OpenAI token-sharing credentials.

Only one native callback listener can hold port 1455 at a time. Finish or cancel an existing browser login before starting another, including a Codex CLI login using the same port. Remote/container deployments still need a free callback port on the bridge; the manual-URL fallback does not remove the server listener requirement.

## Installation identity and credential storage

The bridge supplies native `LoginOptions.getDeviceId` through Pi's `SettingsManager.getOrCreateDeviceId()`. One settings manager is reused by the login controller, avoiding different IDs for overlapping first logins. Pi creates a UUID once and saves it in **global Pi settings**, not project settings. Keep the bridge's Pi settings directory persistent and writable across restarts/container replacement. Project `deviceId` values are deliberately ignored. This installation identifier is sent to OpenAI as `ext_agent_host_id`; it is not an OAuth credential or a user/account identifier.

Account credentials remain encrypted server-side in owner-scoped PocketBase storage. The bridge requires its existing `SUBPOLAR_PROVIDER_SECRET_KEY` configuration. New-account login runtimes use isolated in-memory credential stores until the account sink persists credentials; they do not write tokens into the shared runtime or a Pi auth file. Existing-account runtimes load and rotate only that owner's credentials, including the issued client ID and granted scopes. Login status, events, and catalog responses do not return access/refresh tokens.

Use **Add another account** to create another instance, **Reconnect** to renew a saved account, and **Disconnect** to remove it. Normal OpenAI API-key and ChatGPT accounts can coexist without sharing credentials.

## Inference and limits

The account adapter retains account-qualified model/transcript identity while invoking the original native provider with `provider: "openai"`. This matters: Pi detects the direct ChatGPT token path using native provider identity, the standard OpenAI base URL, and a non-`sk-` token. Its native Responses adapter omits unsupported `temperature`, `max_output_tokens`, `prompt_cache_retention`, and `prompt_cache_options` fields for that path. API-key requests retain their normal supported options. The Subpolar Agent does not reimplement OAuth or these special request rules.

Signing in sends authorization information and the installation ID to OpenAI; inference sends the conversation to OpenAI. Eligibility, consent, models, workspace policies, rate limits, and shared ChatGPT usage allowances are controlled by OpenAI. Sign-in does **not** promise unlimited access, universally free API usage, or access to every catalog model. Catalog presence is not proof that an account can execute a model.

Automated tests cover mocked native token exchange/refresh, invalid token responses, inference requests, owner isolation, persistent installation IDs, and the provider UI. **No real account, live consent flow, or live model inference was tested.** See [provider progress](progress-providers.md) for exact model-settings coverage and remaining work.
