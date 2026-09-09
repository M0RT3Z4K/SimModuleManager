CREATE TABLE "Contact" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "simcardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Contact_simcardId_fkey" FOREIGN KEY ("simcardId") REFERENCES "Simcard" ("iccid") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Contact_simcardId_name_idx" ON "Contact"("simcardId", "name");
