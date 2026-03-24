# Stage 1: build
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Stage 2: runtime
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
