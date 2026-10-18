-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'feishu';

-- DropIndex
DROP INDEX "groups_channel_external_id_key";

-- DropIndex
DROP INDEX "session_items_user_id_operation_id_idx";

-- DropIndex
DROP INDEX "session_items_user_id_seq_key";

-- DropIndex
DROP INDEX "users_channel_external_id_key";

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "channel_scope" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "channel_route" JSONB;

-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "thread_id" TEXT;

-- AlterTable
ALTER TABLE "session_items" ADD COLUMN     "scope_key" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "channel_scope" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "groups_channel_external_id_channel_scope_key" ON "groups"("channel", "external_id", "channel_scope");

-- CreateIndex
CREATE INDEX "session_items_user_id_scope_key_operation_id_idx" ON "session_items"("user_id", "scope_key", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_items_user_id_scope_key_seq_key" ON "session_items"("user_id", "scope_key", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "users_channel_external_id_channel_scope_key" ON "users"("channel", "external_id", "channel_scope");
