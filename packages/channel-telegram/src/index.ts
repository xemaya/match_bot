/** Telegram Update -> InboundMessage；OutboundMessage -> sendMessage。群配置读取。 */
export { toInboundMessage } from './inbound.js';
export { createTelegramSender, TelegramSendError } from './sender.js';
export {
  approvalKeyboard,
  stampApprovalCardText,
  parseApprovalCallback,
  renderApprovalCard,
  type ApprovalCard,
  type Decision,
} from './ops-card.js';
export * from './connection.js';
