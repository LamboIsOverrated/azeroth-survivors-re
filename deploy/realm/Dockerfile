FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS wallet
WORKDIR /app/deploy/realm
COPY package.json package-lock.json ./
RUN npm ci
COPY economy ./economy
COPY market ./market
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates python3 libsqlite3-0 libssl3 gosu smpq=1.6-2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG MMO_BUNDLE_URL
ARG MMO_BUNDLE_SHA256
RUN test "$(dpkg --print-architecture)" = amd64 \
    && test -n "$MMO_BUNDLE_URL" && test -n "$MMO_BUNDLE_SHA256" \
    && curl --fail --location --retry 3 "$MMO_BUNDLE_URL" -o /tmp/mmo.tar.gz \
    && printf '%s  %s\n' "$MMO_BUNDLE_SHA256" /tmp/mmo.tar.gz | sha256sum --check --strict \
    && tar -xzf /tmp/mmo.tar.gz -C /app && rm /tmp/mmo.tar.gz \
    && node -e "const fs=require('node:fs'),z=require('node:zlib'),p='/app/www/wenilla_bg.wasm';fs.writeFileSync(p,z.brotliDecompressSync(fs.readFileSync(p+'.br')));"
COPY --from=wallet /app/deploy/realm ./deploy/realm
COPY web ./deploy/realm/web
COPY core/repair_client.py core/adt_repair.py ./deploy/realm/core/
ENV NODE_ENV=production PORT=8080 REALM_BIND=127.0.0.1:8090 REALM_WWW=/app/www \
    REALM_STATE_DIR=/state CLIENT_SOURCE_DATA=/state/client/Data CLIENT_DATA=/state/client/DerivedData REALM_REMOTE_CONFIG=1 WENILLA_DEV_QUERY_CREDS=0
EXPOSE 8080
ENTRYPOINT ["sh", "/app/deploy/realm/web/entrypoint.sh"]
