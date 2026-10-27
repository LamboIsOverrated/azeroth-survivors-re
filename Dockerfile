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
ARG ENGINE_BUNDLE_URL=https://github.com/LamboIsOverrated/azeroth-survivors-re/releases/download/engine-0f16c58/engine-runtime.tar.gz
ARG ENGINE_BUNDLE_SHA256=b163ee2492938ff08be9c57fca36d2c9a5940735521222bfd274a8596097d5e5
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl --fail --location --retry 3 "$ENGINE_BUNDLE_URL" -o /tmp/engine.tar.gz \
    && printf '%s  %s\n' "$ENGINE_BUNDLE_SHA256" /tmp/engine.tar.gz | sha256sum --check --strict \
    && tar -xzf /tmp/engine.tar.gz -C /app && rm /tmp/engine.tar.gz
# The release stores the engine's existing Brotli representation once, rather than three
# copies of the same module. Restore the raw fallback for clients without Brotli support.
RUN node -e "const fs=require('node:fs'),z=require('node:zlib'),p='/app/web/dist/wenilla_bg.wasm';fs.writeFileSync(p,z.brotliDecompressSync(fs.readFileSync(p+'.br')));"
ENV NODE_ENV=production PORT=8080 WOW_DATA_DIR=/game-data
COPY --from=wallet /wallet ./deploy
COPY scripts/fetch-data.sh ./scripts/fetch-data.sh
COPY LICENSE-MIT LICENSE-APACHE ./
RUN mkdir -p /game-data
EXPOSE 8080
CMD ["node", "deploy/runtime.mjs"]
