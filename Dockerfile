# ---- build: install all deps, build the client bundle ----
FROM node:20-slim AS build
# Toolchain so better-sqlite3 can compile from source if its prebuilt binary can't be fetched.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATABASE_FILE=/data/ajaia.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY server/src ./server/src
RUN mkdir -p /data
EXPOSE 3001
HEALTHCHECK CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]
