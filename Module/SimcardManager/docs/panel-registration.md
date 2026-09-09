# Board registration

Set `PANEL_BASE_URL` and `DEVICE_REGISTRATION_TOKEN` in
`include/panel_config.local.h` before building/uploading. This local file is
ignored by Git; `include/panel_config.local.h.example` is the shareable template.
The registration credential must match the backend environment. Missing
credentials disable registration instead of silently making an anonymous request.

The board posts to `/api/devices/register` with JSON and
`Authorization: Bearer <registration credential>`:

```json
{
  "device_id": "esp32-<factory-mac>",
  "device_token": "<persistent-random-256-bit-secret>",
  "iccid": "<current-sim-iccid>",
  "ip": "<current-local-ip>",
  "phone": "<SIM-provided-number-or-empty>"
}
```

The MAC-derived board ID survives SIM swaps. A random per-device credential is
generated after Wi-Fi initialization and saved in the `panel-auth` NVS namespace.
It is not logged or exposed through `/health`. NVS persistence is not encryption;
this build does not configure flash encryption. Erasing NVS loses the credential:
do not silently overwrite a panel credential or send `rotate_device_key: true`.
Use a separately authorized rotation procedure if the stored credential is lost.

Registration is successful only after HTTP 2xx. Failures retry with delay from
30 seconds up to five minutes; reconnects, changed IPs and SIM initialization
trigger registration as needed. `/health` exposes `device_id` and
`panel_registered` without exposing secrets.

## Deliberately unadvertised capabilities

This change implements registration, **not firmware contract version 1**.
`call_events_version` is omitted from registration so the documented legacy
fallback remains "call lifecycle not ready". `/health` reports version zero.
Do not set version 1 until the shared AT parser, modem-confirmed active/end
events, authenticated retry queue, boot/call/event IDs and state recovery exist.
The endlessly open audio stream cannot establish call boundaries.

`audio` is omitted while `VERIFIED_AUDIO_SAMPLE_RATE` is zero. The configured
8000 Hz differs from observed TCP sample delivery, and the latter is not a
verified ADC clock. Use the panel's experimental per-device override for current
hardware. Once the ADC clock has been verified, configure its rate locally;
registration then includes:

```json
"audio": { "format": "pcm_s16le", "channels": 1, "sample_rate": 8000 }
```

8000 above illustrates the JSON shape only. Configuring this value declares
metadata; it does not change the ADC clock or perform resampling.

Actual registration acceptance needs the real backend credential and a hardware
run. A successful firmware build does not verify backend acceptance.
