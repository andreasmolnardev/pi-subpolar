# Voice backend seam

The bridge owns the authenticated `/api/stt/transcribe` and `/api/tts/synthesize`
routes. `STTBackend` and `TTSBackend` are intentionally dependency-free ports.
`Callback*Backend` adapts an installed local library; `ProcessSTTBackend` and
`ProcessTTSBackend` adapt explicitly configured local executables. The bridge
uses `SUBPOLAR_VOICE_STT_EXECUTABLE` and `SUBPOLAR_VOICE_TTS_EXECUTABLE` when
set. Without a callback or executable, the local backend reports unavailable;
it never claims a provider is installed. Browser Web Speech remains a client
adapter and cloud providers are optional implementations of the same ports.

Voice is disabled by default. Every voice request, including status and internal
or gateway requests, requires a durable session context identified by the
`sessionId` query parameter or `x-session-id` header. The bridge checks the
session owner, stored agent, and gateway `call` permission/scope; a caller
`userId` is not an identity source. The route layer bounds request bytes and
audio/text sizes, enforces timeout and cancellation, and propagates stream
cancellation to the backend iterator. Backend credentials must be represented
by a protected `apiKeyRef`; raw keys are removed before preferences are
persisted or returned.
