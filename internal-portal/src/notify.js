'use strict';

/**
 * Notification Mock — giả lập kênh cảnh báo Telegram / Email nội bộ.
 *
 * Nghiệp vụ Helpdesk: ticket mức High/Critical phải được thông báo ngay cho
 * trực IT. Vì lab chưa có bot thật, module này:
 *   1. Log đẹp ra console (chạy `docker compose logs -f` là thấy).
 *   2. Lưu vết vào <dataDir>/notifications.log (bằng chứng kiểm toán).
 *   3. Giữ 50 thông báo gần nhất trong bộ nhớ → GET /api/notifications.
 *   4. Nếu cấu hình IT_WEBHOOK_URL (Slack/Teams/Mattermost), thử POST thật
 *      nhưng KHÔNG để lỗi mạng làm hỏng request tạo ticket.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const ALERT_PRIORITIES = new Set(['High', 'Critical']);
const HISTORY_LIMIT = 50;
const WEBHOOK_TIMEOUT_MS = 3000;

function timestamp() {
  // Cùng định dạng "yyyy-mm-dd hh:mm" với API/UI (giờ địa phương server)
  // để đối chiếu log cảnh báo với thời gian mở ticket được dễ dàng.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function createNotifier(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const webhookUrl = options.webhookUrl || process.env.IT_WEBHOOK_URL || null;
  const logFile = path.join(dataDir, 'notifications.log');
  const history = [];

  const notifier = {
    webhookUrl,
    logFile,
    lastDelivery: null,

    shouldAlert(ticket) {
      return Boolean(ticket && ALERT_PRIORITIES.has(ticket.priority));
    },

    buildMessage(ticket) {
      return (
        `[ALERT][IT-HELPDESK] #${ticket.id} ${ticket.priority.toUpperCase()} • ` +
        `${ticket.title || 'Untitled'} • ${ticket.requester || 'Unknown'} (${ticket.dept || 'N/A'}) ` +
        `• ${ticket.category || 'General'} • ${timestamp()}`
      );
    },

    async alert(ticket) {
      if (!this.shouldAlert(ticket)) {
        return { alerted: false, reason: 'priority-below-threshold' };
      }

      const message = this.buildMessage(ticket);
      const entry = {
        at: timestamp(),
        ticketId: ticket.id,
        priority: ticket.priority,
        title: ticket.title || null,
        channels: ['telegram-bot://it-helpdesk-alert', 'smtp://it-alerts@bmc.local'],
        message,
      };

      console.log(`[notify:telegram] ${message}`);
      console.log(`[notify:email]    subject=${message.slice(0, 72)}... to=it-team@bmc.local`);

      history.unshift(entry);
      if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;

      // 3) Lưu vết kiểm toán ra đĩa — failures chỉ cảnh báo, không ném.
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.appendFile(logFile, `${message}\n`, 'utf8');
      } catch (err) {
        console.warn(`[notify] không ghi được notifications.log: ${err.message}`);
      }

      // 4) Webhook thật (tuỳ chọn) — mock vẫn PASS nếu không cấu hình.
      let delivered = null;
      let deliveryError = null;
      if (webhookUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
        try {
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message }),
            signal: controller.signal,
          });
          delivered = res.ok;
          if (!res.ok) deliveryError = `HTTP ${res.status}`;
        } catch (err) {
          delivered = false;
          deliveryError = err.name === 'AbortError' ? `timeout>${WEBHOOK_TIMEOUT_MS}ms` : err.message;
        } finally {
          clearTimeout(timer);
        }
      }

      this.lastDelivery = { at: entry.at, ok: delivered, error: deliveryError };
      return { alerted: true, delivered, deliveryError, channels: entry.channels };
    },

    history(limit = HISTORY_LIMIT) {
      return { count: history.length, items: history.slice(0, limit) };
    },
  };

  return notifier;
}

module.exports = { createNotifier, ALERT_PRIORITIES, HISTORY_LIMIT };
