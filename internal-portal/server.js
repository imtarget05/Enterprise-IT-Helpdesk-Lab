'use strict';

/**
 * BMC IT PORTAL — entrypoint (bootstrap mỏng).
 * Toàn bộ logic nằm trong src/app.js (application factory) để test có thể
 * boot nhiều instance trên ephemeral port với dataDir tạm.
 */

const path = require('node:path');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

(async () => {
  try {
    const { app, store, dataDir } = await createApp({
      dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    });

    const server = app.listen(PORT, HOST, () => {
      const counts = store.summary();
      console.log('============================================================');
      console.log('[BMC IT PORTAL] IT Asset & Helpdesk Management Portal v2.0.0');
      console.log(`  URL      : http://localhost:${PORT}`);
      console.log(`  Storage  : JSON file → ${path.join(dataDir, 'db.json')}${store.seeded ? ' (khởi tạo từ dữ liệu mẫu)' : ' (nạp lại dữ liệu đã lưu)'}`);
      console.log(`  Records  : ${counts.assets} assets • ${counts.tickets} tickets • ${counts.licenses} licenses`);
      console.log(`  Webhook  : ${process.env.IT_WEBHOOK_URL ? process.env.IT_WEBHOOK_URL : 'mock (console + data/notifications.log)'}`);
      console.log(`  Health   : curl http://localhost:${PORT}/api/health`);
      console.log('============================================================');
    });

    // Graceful shutdown: flush thao tác ghi đĩa trước khi thoát (Docker SIGTERM).
    const shutdown = async (signal) => {
      console.log(`\n[${signal}] đang tắt server...`);
      await store.flush().catch(() => {});
      server.close(() => {
        console.log('[shutdown] Đã đóng kết nối — dữ liệu an toàn trên đĩa.');
        process.exit(0);
      });
      setTimeout(() => {
        console.warn('[shutdown] Quá thời gian chờ, buộc thoát.');
        process.exit(1);
      }, 5000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection:', reason));
  } catch (err) {
    console.error('[FATAL] Không thể khởi động server:', err);
    process.exit(1);
  }
})();
