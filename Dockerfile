FROM node:22-alpine
LABEL org.opencontainers.image.title="Immich Person Manager" \
      org.opencontainers.image.description="Review and manage Immich people and face assignments" \
      org.opencontainers.image.source="https://github.com/shurli/immich-person-manager"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY --chown=node:node server.mjs cluster-math.mjs ./
COPY --chown=node:node public ./public
ENV NODE_ENV=production PORT=3003
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3003) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.mjs"]
