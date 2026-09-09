-- Prisma maps SQLite INTEGER to a 32-bit JavaScript Int for this field.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RecordingPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "pre_roll_ms" INTEGER NOT NULL DEFAULT 2000,
    "max_call_bytes" INTEGER NOT NULL DEFAULT 536870912,
    "retention_days" INTEGER NOT NULL DEFAULT 30,
    "max_storage_bytes" INTEGER NOT NULL DEFAULT 2000000000,
    "delete_transcript" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_RecordingPolicy" ("delete_transcript", "id", "max_call_bytes", "max_storage_bytes", "pre_roll_ms", "retention_days", "updated_at")
SELECT "delete_transcript", "id", "max_call_bytes", MIN("max_storage_bytes", 2000000000), "pre_roll_ms", "retention_days", "updated_at" FROM "RecordingPolicy";
DROP TABLE "RecordingPolicy";
ALTER TABLE "new_RecordingPolicy" RENAME TO "RecordingPolicy";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
