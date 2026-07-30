# ---- build stage ----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install with the lockfile-independent path so the image builds from a clean
# checkout, then compile TypeScript to dist/.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only runtime deps are copied forward.
RUN npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    SYNOLOGY_MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000

# tini reaps zombies and forwards signals so shutdown is clean.
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run unprivileged; the node image already ships a "node" user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http'+'://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
