-- Preserve existing modules as explicit legacy devices. Their input sample rate
-- intentionally remains NULL until firmware declares it or an operator performs
-- a per-device experimental calibration.
INSERT OR IGNORE INTO "Device" (
    "id", "label", "ip_address", "active", "firmware_events_supported",
    "audio_format", "audio_channels", "input_rate_source",
    "experimental_calibration", "output_sample_rate", "audio_profile",
    "receiver_status", "created_at", "updated_at"
)
SELECT
    'legacy-' || "iccid", 'Legacy ' || "iccid", "ip_address", true, false,
    'pcm_s16le', 1, 'firmware', false, 16000, 'mild',
    'configuration_required', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Simcard"
WHERE "deviceId" IS NULL;

UPDATE "Simcard"
SET "deviceId" = 'legacy-' || "iccid"
WHERE "deviceId" IS NULL;
