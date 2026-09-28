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

    async alert(ticket, contract = {}) {
      if (!this.shouldAlert(ticket)) {
        return { alerted: false, reason: 'priority-below-threshold' };
      }
      const callerSignal = contract && contract.signal;
      if (callerSignal && callerSignal.aborted) {
        return { alerted: false, reason: 'notifier-aborted', delivered: false, deliveryError: 'aborted-before-alert' };
      }
      // The caller's abort listener is registered BEFORE the first await, so an
      // abort that lands while the notification log is being written still
      // reaches the webhook fetch below instead of being missed. A signal that
      // was already aborted at registration time will not fire the listener
      // again, so `aborted` is re-checked after the log I/O as well.
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(callerSignal && callerSignal.reason);
      if (callerSignal) callerSignal.addEventListener('abort', abortFromCaller, { once: true });

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

      let timer;
      try {
        // 3) Lưu vết kiểm toán ra đĩa — failures chỉ cảnh báo, không ném.
        try {
          await fs.mkdir(dataDir, { recursive: true });
          await fs.appendFile(logFile, `${message}\n`, 'utf8');
        } catch (err) {
          console.warn(`[notify] không ghi được notifications.log: ${err.message}`);
        }

        // The log write above is awaited, so the caller may have given up during
        // it. Re-check before spending a real network request.
        if (callerSignal && callerSignal.aborted) {
          this.lastDelivery = { at: entry.at, ok: null, error: 'aborted-before-webhook' };
          return { alerted: false, reason: 'notifier-aborted', delivered: false, deliveryError: 'aborted-before-webhook', channels: entry.channels };
        }

        // 4) Webhook thật (tuỳ chọn) — mock vẫn PASS nếu không cấu hình.
        let delivered = null;
        let deliveryError = null;
        if (webhookUrl) {
          const deadline = Number(contract && contract.deadline);
          const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : WEBHOOK_TIMEOUT_MS;
          if (remaining === 0) controller.abort(new Error('notifier-deadline'));
          else timer = setTimeout(() => controller.abort(new Error('notifier-timeout')), Math.min(WEBHOOK_TIMEOUT_MS, remaining));
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
            deliveryError = callerSignal && callerSignal.aborted
              ? 'notifier-aborted'
              : (err.name === 'AbortError' ? `timeout>${Math.min(WEBHOOK_TIMEOUT_MS, remaining)}ms` : err.message);
          }
        }

        this.lastDelivery = { at: entry.at, ok: delivered, error: deliveryError };
        if (callerSignal && callerSignal.aborted) {
          return { alerted: false, reason: 'notifier-aborted', delivered, deliveryError, channels: entry.channels };
        }
        return { alerted: true, delivered, deliveryError, channels: entry.channels };
      } finally {
        if (timer) clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', abortFromCaller);
      }
    },

    history(limit = HISTORY_LIMIT) {
      return { count: history.length, items: history.slice(0, limit) };
    },
  };

  return notifier;
}

module.exports = { createNotifier, ALERT_PRIORITIES, HISTORY_LIMIT };
