FROM node:24-bookworm-slim AS wallet
WORKDIR /wallet
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci
COPY deploy ./
RUN npm run build && npm prune --omit=dev

FROM rust:1.98.1-bookworm AS game
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl xz-utils clang cmake pkg-config python3 brotli libasound2-dev libudev-dev \
    libwayland-dev libxkbcommon-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY . .
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_DEBUG=0
RUN scripts/web-setup.sh
RUN scripts/web-build.sh
RUN cargo build --locked --release -p wenilla-host

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 WOW_DATA_DIR=/game-data
COPY --from=game /source/web/dist ./web/dist
COPY --from=game /source/target/release/wenilla-host ./bin/wenilla-host
COPY --from=wallet /wallet ./deploy
COPY scripts/fetch-data.sh ./scripts/fetch-data.sh
RUN mkdir -p /game-data
EXPOSE 3000
CMD ["node", "deploy/runtime.mjs"]
