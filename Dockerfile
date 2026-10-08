# TxWhy, self-hosted: the website and API (repair, explain, MCP, error pages) in one image.
#   docker build -t txwhy .
#   docker run -p 3000:3000 -e SOLANA_RPC_URL=https://your-rpc txwhy
# Only SOLANA_RPC_URL is required. See README "Self-host" for the optional variables (worker, Redis, Telegram, x402).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]
