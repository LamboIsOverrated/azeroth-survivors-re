#!/usr/bin/env bash
# Stage only the verified CI image's code/runtime bundle, never assets or secrets.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${1:?Pass the already verified local image tag}"
output="${2:?Pass a new scratch artifact directory}"
: "${GITHUB_SHA:?The exact CI source commit is required}"
mkdir -p "$output"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
docker run --rm --network none --entrypoint python3 \
  --env "BUNDLE_SOURCE_COMMIT=$GITHUB_SHA" --env "BUNDLE_IMAGE_ID=$image_id" \
  --mount "type=bind,src=$here/tools/export-image.py,dst=/export-image.py,readonly" \
  "$image" /export-image.py > "$output/realm-core-bridge.tar.gz"
tar -xOzf "$output/realm-core-bridge.tar.gz" manifest.json > "$output/manifest.json"
(cd "$output" && sha256sum realm-core-bridge.tar.gz manifest.json > SHA256SUMS)
