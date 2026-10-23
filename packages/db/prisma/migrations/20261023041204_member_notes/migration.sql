-- CreateEnum
CREATE TYPE "MemberNoteKind" AS ENUM ('offer', 'need', 'context', 'resolved');

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "memory_consolidated_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "member_notes" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "MemberNoteKind" NOT NULL,
    "text" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "superseded_at" TIMESTAMPTZ,

    CONSTRAINT "member_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_notes_group_id_user_id_idx" ON "member_notes"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "member_notes_expires_at_idx" ON "member_notes"("expires_at");

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_notes" ADD CONSTRAINT "member_notes_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
