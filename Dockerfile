FROM node:24-bookworm-slim AS wallet
WORKDIR /wallet
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci
COPY deploy ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Rust is unchanged between wallet/economy releases. Reuse the verified Linux amd64 build
# from source commit 0f16c582f2dd5333df1d922f67c52c15a8428989; Dockerfile.engine rebuilds it.
ARG ENGINE_BUNDLE_URL=https://github.com/LamboIsOverrated/azeroth-survivors-re/releases/download/engine-0f16c58/engine-release.tar.gz
ARG ENGINE_BUNDLE_SHA256=f428fc74fd582ac0dbfe12b9e6406900a6463a8d13481473843910f447e3edec
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl --fail --location --retry 3 "$ENGINE_BUNDLE_URL" -o /tmp/engine.tar.gz \
    && printf '%s  %s\n' "$ENGINE_BUNDLE_SHA256" /tmp/engine.tar.gz | sha256sum --check --strict \
    && tar -xzf /tmp/engine.tar.gz -C /app && rm /tmp/engine.tar.gz
ENV NODE_ENV=production PORT=8080 WOW_DATA_DIR=/game-data
COPY --from=wallet /wallet ./deploy
COPY scripts/fetch-data.sh ./scripts/fetch-data.sh
COPY LICENSE-MIT LICENSE-APACHE ./
RUN mkdir -p /game-data
EXPOSE 8080
CMD ["node", "deploy/runtime.mjs"]
