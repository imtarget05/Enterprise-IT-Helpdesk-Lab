/**
 * Live infrastructure guard for Node.js test runner.
 * Skips live tests if LIVE_TESTS!=1 or if endpoint is unreachable.
 */
import http from 'node:http';

export const isLiveEnabled = () => {
  const val = (process.env.LIVE_TESTS || '').toLowerCase();
  return val === '1' || val === 'true' || val === 'yes';
};

export const checkHttpReachable = (url, timeoutMs = 1500) => {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname,
          method: 'HEAD',
          timeout: timeoutMs,
        },
        (res) => {
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
};
