# =============================================================================
#  BMC IT PORTAL — IT Asset & Helpdesk Management Portal
#  Multi-stage build: chỉ lấy production dependencies, chạy non-root, có healthcheck.
#
#  Build : docker build -f internal-portal/Dockerfile -t it-portal .
#  Run   : docker run -d --name it-portal -p 3000:3000 -v "$PWD/internal-portal/data:/app/data" it-portal
# =============================================================================

# ---------- Stage 1: cài dependencies (tận dụng layer cache) ----------
FROM node:20-alpine AS deps
WORKDIR /app/internal-portal
COPY internal-portal/package.json internal-portal/package-lock.json ./
# `npm ci` = install đúng theo khoá lock → build tái lập được (reproducible)
RUN npm ci --no-audit --no-fund

# ---------- Stage 2: test (docker build --target test .) ----------
FROM node:20-alpine AS test
WORKDIR /app
ENV DATA_DIR=/tmp/portal-test-data
COPY --from=deps /app/internal-portal/node_modules /app/internal-portal/node_modules
COPY internal-portal/package.json internal-portal/package-lock.json /app/internal-portal/
COPY internal-portal/server.js /app/internal-portal/server.js
COPY internal-portal/src /app/internal-portal/src
COPY internal-portal/public /app/internal-portal/public
COPY internal-portal/test /app/internal-portal/test
COPY internal-portal/test-api.sh /app/internal-portal/test-api.sh
COPY internal-portal/Dockerfile /app/internal-portal/Dockerfile
COPY internal-portal/docker-compose.yml /app/internal-portal/docker-compose.yml
COPY scripts /app/scripts
COPY docs /app/docs
COPY scenarios /app/scenarios
WORKDIR /app/internal-portal
RUN npm test

# ---------- Stage 3: runtime tối giản ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TZ=Asia/Ho_Chi_Minh
WORKDIR /app/internal-portal

COPY --from=deps /app/internal-portal/node_modules ./node_modules
COPY internal-portal/package.json ./
COPY internal-portal/server.js ./
COPY internal-portal/src ./src
COPY internal-portal/public ./public
COPY docs /app/docs
COPY scenarios /app/scenarios

# User không đặc quyền (node có sẵn trong image) + thư mục dữ liệu ghi được
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

# Healthcheck gọi thẳng /api/health — Docker/mark dùng để tái khởi động khi treo
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
