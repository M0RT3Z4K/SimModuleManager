# Call recording, audio processing, and transcription

## What is implemented

The backend owns one long-lived `GET http://DEVICE_IP:8080/` stream per active device. A database lease prevents two backend processes from intentionally owning the same device. HTTP 409, timeouts, disconnects, reconnect backoff/jitter, and current receiver state are visible in the Calls UI. Network chunks are reassembled across odd-byte boundaries and only complete signed 16-bit little-endian samples are stored.

Audio is written incrementally to a private storage directory. While idle, only the configured pre-roll (two seconds by default) remains in memory. An authenticated call lifecycle event starts and ends each independent file; stream presence, silence, VAD, and TCP data are never treated as call boundaries. A network loss during a call marks the recording incomplete and records a missing segment without ending the call.

After finalization the original WAV is immediately playable. A durable database job runs a selectable raw/mild/strong ffmpeg profile and real resampling, then a second job calls an OpenAI-compatible Audio Transcriptions endpoint. Original audio is retained when either job fails. Stale jobs are recovered after restart. A provider timeout may have charged the provider before the retry; exactly-once billing is not promised.

## Run and migrate

Requirements: Node.js, ffmpeg, and a writable SQLite/storage directory.

```sh
cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run db:generate
npm start
```

The HTTP server, receiver manager, durable job worker, health checker, and retention task run in the same process by default and do not depend on an open browser. Multiple backend processes may run against shared database/storage infrastructure, but SQLite is suitable only for a single host. For production multi-host operation, migrate the Prisma datasource to a server database and use shared durable object storage.

`TRANSCRIPTION_API_KEY` is read only from the server environment. It is not stored in the database, logged, or returned by the API. In production, `ADMIN_API_TOKEN` or `API_TOKENS_JSON` and `DEVICE_REGISTRATION_TOKEN` are required. `API_TOKENS_JSON` supports per-device viewer scopes. Audio and transcript endpoints enforce the same scope.

## Firmware contract (version 1)

No firmware source exists in this repository. The current ICCID-only registration remains accepted as a legacy device, but it is intentionally shown as **call lifecycle not ready**. It cannot safely create call recordings because its endless stream does not identify call boundaries.

New firmware registers with:

```http
POST /api/devices/register
Authorization: Bearer DEVICE_REGISTRATION_TOKEN
Content-Type: application/json

{
  "device_id": "esp32-board-serial-001",
  "device_token": "per-device-random-secret",
  "call_events_version": 1,
  "iccid": "8998...",
  "ip": "192.168.1.40",
  "phone": "+98...",
  "audio": { "format": "pcm_s16le", "channels": 1, "sample_rate": 8000 }
}
```

`device_id` is tied to the board, not the SIM. On a later registration with a different ICCID, the current SIM association changes while existing calls retain ICCID/phone snapshots. Firmware must store the per-device token securely. Rotation requires an authorized registration with `rotate_device_key: true`.

Call events are retried until a 2xx response:

```http
POST /api/device-events/esp32-board-serial-001/events
Authorization: Bearer PER_DEVICE_TOKEN
Content-Type: application/json

{
  "boot_id": "random-on-every-boot",
  "event_id": "unique-within-boot",
  "sequence": 42,
  "call_id": "stable-for-this-call (omitted only for idle state)",
  "type": "ringing | answered | active | ended | state",
  "reason": "remote_hangup | local_hangup | rejected | network_lost | modem_error | unknown",
  "caller_number": "+98912...",
  "sample_counter": "184467",
  "monotonic_ms": "938422",
  "state": "ringing | active | ended | idle"
}
```

The unique keys `(device_id, boot_id, event_id)` and `(device_id, boot_id, sequence)` make retries idempotent and reject sequence reuse. The device must emit `ringing`, then modem-confirmed `answered`/`active`, then `ended`; sending `ATA` alone is not confirmation. After reconnect or panel restart it sends a `state` event with the current call ID/state. A late or duplicate event never creates a second call.

For exact audio/event alignment the stream response adds:

```http
X-Audio-Session-Id: unique-stream-session
X-Audio-Start-Sample: 183900
Content-Type: application/octet-stream
```

`X-Audio-Start-Sample` is the device monotonic sample counter of the first byte in this HTTP response and uses the same counter as events. Without this mapping, the panel records with server-observed event time plus pre-roll and labels the boundary accordingly. The stream stays open during idle and after calls.

The firmware must report the actual ADC sample clock. The panel does not infer it from instantaneous TCP delivery. A manual override is available and is visibly marked “experimental calibration”; 8000 and 43904 are not global defaults. Correct input-rate interpretation precedes filtered resampling to the output rate.

### SIM800L parser requirement

The firmware must use one shared AT line parser/dispatcher for command responses and unsolicited result codes. `RING`, caller ID, `NO CARRIER`, `BUSY`, and modem call-state responses must be dispatched even while another AT command is pending. Confirm active state using a modem call-state query/URC supported by the deployed SIM800 firmware; do not discard unrelated URCs from a command's response buffer.

## Audio profiles

- `raw`: declared-rate PCM converted to a standard WAV and resampled only when required.
- `mild` (default): audio is first normalized to a stable 16 kHz processing rate, then a 120–3600 Hz speech band, conservative adaptive spectral/non-local-means reduction, a light 2 kHz presence lift, capped speech normalization, true-peak-safe loudness normalization, and real output resampling are applied.
- `strong`: adapts to the captured level. Quiet captures get the two-stage reduction; hot captures use lighter spectral reduction without NLM so consonants are not replaced by metallic/musical artifacts. Both paths repair short analog clicks, preserve the telephone speech band, lift speech presence, and apply capped loudness normalization.

The firmware defaults the SIM800 analog speaker output to `AT+CLVL=50` (override with `MODEM_SPEAKER_LEVEL`). It also applies a fourth-order anti-alias low-pass filter before clock-based decimation; this prevents out-of-band ADC/modem noise from folding into the speech band. Raising the useful signal before the ESP32 ADC improves SNR, but backend gain cannot recover clipped or aliased detail. Short call-state clicks are handled separately by the strong backend profile.

The original file is never overwritten. All-zero or near-zero recordings are marked `no_signal` and are not sent for transcription. No text, confidence, speaker identity, summary, or translation is invented. The modem loudspeaker output is not claimed to contain both parties and is not claimed to support diarization.

## Provider behavior

The adapter normalizes the configured base URL so both `https://host` and `https://host/v1` target exactly one `/v1/audio/transcriptions` path. It sends a real multipart WAV plus `model`; `language` and `response_format` are sent only when their capability flags are enabled. A provider supporting Chat Completions but not Audio Transcriptions fails with its HTTP error.

Files over the configured limit are split in order with a short overlap; exact repeated word prefixes are removed while merging. HTTP 429, 5xx, request timeout, and selected transient errors receive bounded exponential retries. Authentication/configuration errors do not retry indefinitely.

## Remaining hardware dependency

The panel/backend, mock device, mock provider, migration, and automated software tests are included. Hardware behavior is **not verified** because this repository contains neither firmware nor an attached ESP32/SIM800L. Until firmware implements the contract above, the legacy device can have a healthy audio receiver but cannot safely mark answered/ended calls. A successful simulator/mock run must not be reported as a successful real-module or paid-provider test.

## SIM contacts

`GET /api/simcards/:iccid/contacts` is an authenticated panel endpoint. The browser calls only this endpoint; the backend resolves the SIM's current `Device` and requests `GET http://DEVICE_IP/contacts` with a 15-second timeout and a 2 MiB response limit. Only a JSON object containing a validated `contacts` array is accepted.

After a valid response, contacts for that ICCID are atomically replaced in the local cache. Contacts belonging to another ICCID are never deleted or returned. Connection errors, timeouts, non-2xx responses, malformed JSON, and invalid contact records return an explicit 502/504 response. If that SIM has a previous successful cache, it is returned separately as `cached_contacts` with `stale: true`; a failed device response never overwrites good cached data.
