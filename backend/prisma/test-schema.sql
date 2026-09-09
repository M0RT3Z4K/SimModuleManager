-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT,
    "ip_address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "device_key_hash" TEXT,
    "firmware_events_supported" BOOLEAN NOT NULL DEFAULT false,
    "audio_format" TEXT NOT NULL DEFAULT 'pcm_s16le',
    "audio_channels" INTEGER NOT NULL DEFAULT 1,
    "input_sample_rate" INTEGER,
    "input_rate_source" TEXT NOT NULL DEFAULT 'firmware',
    "experimental_calibration" BOOLEAN NOT NULL DEFAULT false,
    "output_sample_rate" INTEGER NOT NULL DEFAULT 16000,
    "audio_profile" TEXT NOT NULL DEFAULT 'mild',
    "receiver_status" TEXT NOT NULL DEFAULT 'stopped',
    "receiver_error" TEXT,
    "receiver_connected_at" DATETIME,
    "receiver_last_audio_at" DATETIME,
    "receiver_lease_owner" TEXT,
    "receiver_lease_until" DATETIME,
    "stream_session_id" TEXT,
    "health_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "Simcard" (
    "iccid" TEXT NOT NULL PRIMARY KEY,
    "phone_number" TEXT,
    "ip_address" TEXT,
    "last_seen" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "deviceId" TEXT,
    CONSTRAINT "Simcard_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sms" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simcardId" TEXT NOT NULL,
    "sender_number" TEXT,
    "message_text" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "direction" TEXT NOT NULL,
    CONSTRAINT "Sms_simcardId_fkey" FOREIGN KEY ("simcardId") REFERENCES "Simcard" ("iccid") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simcardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contact_simcardId_fkey" FOREIGN KEY ("simcardId") REFERENCES "Simcard" ("iccid") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "boot_id" TEXT NOT NULL,
    "external_call_id" TEXT NOT NULL,
    "caller_number" TEXT,
    "sim_iccid_snapshot" TEXT,
    "sim_phone_snapshot" TEXT,
    "ringing_at" DATETIME,
    "answered_at" DATETIME,
    "ended_at" DATETIME,
    "duration_ms" INTEGER,
    "audio_duration_ms" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'ringing',
    "end_reason" TEXT,
    "boundary_mode" TEXT NOT NULL DEFAULT 'event_received',
    "recording_status" TEXT NOT NULL DEFAULT 'waiting',
    "processing_status" TEXT NOT NULL DEFAULT 'waiting',
    "transcription_status" TEXT NOT NULL DEFAULT 'waiting',
    "original_path" TEXT,
    "processed_path" TEXT,
    "audio_format" TEXT NOT NULL DEFAULT 'pcm_s16le',
    "input_sample_rate" INTEGER,
    "output_sample_rate" INTEGER,
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "audio_bytes" INTEGER NOT NULL DEFAULT 0,
    "audio_profile" TEXT,
    "quality_json" TEXT,
    "transcript" TEXT,
    "transcript_language" TEXT,
    "transcript_provider" TEXT,
    "transcript_model" TEXT,
    "processing_version" TEXT,
    "recording_error" TEXT,
    "processing_error" TEXT,
    "transcription_error" TEXT,
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "transcription_attempts" INTEGER NOT NULL DEFAULT 0,
    "recording_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "missing_segments_json" TEXT,
    "answered_sample_counter" TEXT,
    "ended_sample_counter" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Call_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "callId" TEXT,
    "boot_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "external_call_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "caller_number" TEXT,
    "sample_counter" TEXT,
    "device_monotonic_ms" TEXT,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_json" TEXT,
    CONSTRAINT "CallEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CallEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "run_after" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ProcessingJob_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "base_url" TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    "model" TEXT NOT NULL DEFAULT 'whisper-1',
    "language" TEXT DEFAULT 'fa',
    "response_format" TEXT DEFAULT 'json',
    "supports_language" BOOLEAN NOT NULL DEFAULT true,
    "supports_response_format" BOOLEAN NOT NULL DEFAULT true,
    "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "max_file_bytes" INTEGER NOT NULL DEFAULT 25000000,
    "chunk_overlap_ms" INTEGER NOT NULL DEFAULT 750,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecordingPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "pre_roll_ms" INTEGER NOT NULL DEFAULT 2000,
    "max_call_bytes" INTEGER NOT NULL DEFAULT 536870912,
    "retention_days" INTEGER NOT NULL DEFAULT 30,
    "max_storage_bytes" INTEGER NOT NULL DEFAULT 2000000000,
    "delete_transcript" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Simcard_deviceId_key" ON "Simcard"("deviceId");

-- CreateIndex
CREATE INDEX "Contact_simcardId_name_idx" ON "Contact"("simcardId", "name");

-- CreateIndex
CREATE INDEX "Call_deviceId_created_at_idx" ON "Call"("deviceId", "created_at");

-- CreateIndex
CREATE INDEX "Call_state_created_at_idx" ON "Call"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Call_deviceId_boot_id_external_call_id_key" ON "Call"("deviceId", "boot_id", "external_call_id");

-- CreateIndex
CREATE INDEX "CallEvent_external_call_id_idx" ON "CallEvent"("external_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "CallEvent_deviceId_boot_id_event_id_key" ON "CallEvent"("deviceId", "boot_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "CallEvent_deviceId_boot_id_sequence_key" ON "CallEvent"("deviceId", "boot_id", "sequence");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_run_after_idx" ON "ProcessingJob"("status", "run_after");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_callId_type_version_key" ON "ProcessingJob"("callId", "type", "version");
