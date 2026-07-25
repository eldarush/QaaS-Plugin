ARG SOURCE_DATE_EPOCH=0

FROM node:24.14.0-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS build

ARG SOURCE_DATE_EPOCH

WORKDIR /app

COPY --chown=1000:1000 package.json site.config.json ./
COPY --chown=1000:1000 scripts ./scripts
COPY --chown=1000:1000 src ./src

RUN chown 1000:1000 /app

USER 1000:1000

RUN node scripts/build.mjs

FROM node:24.14.0-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114

ARG SOURCE_DATE_EPOCH

LABEL org.opencontainers.image.title="qaas-plugin-docs" \
      org.opencontainers.image.version="0.4.0" \
      org.opencontainers.image.source="https://github.com/TheSmokeTeam/QaaS-Plugin"

WORKDIR /app

COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/site.config.json ./site.config.json
COPY --from=build --chown=1000:1000 /app/src/index.template.html ./src/index.template.html
COPY --from=build --chown=1000:1000 /app/src/catalog.mjs ./src/catalog.mjs
COPY --from=build --chown=1000:1000 /app/scripts ./scripts

USER 1000:1000

ENV HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "scripts/server.mjs"]
