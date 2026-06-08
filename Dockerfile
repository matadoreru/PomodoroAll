# ── Build stage: compile Tailwind CSS ─────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tailwind.config.js postcss.config.js ./
COPY client/ ./client/

RUN npm run build:css

# ── Production stage ───────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=builder /app/client/public/ ./client/public/

# Railway injects PORT at runtime; fallback to 3001 for local Docker runs
ENV PORT=3001
EXPOSE ${PORT}
CMD ["node", "server/server.js"]
