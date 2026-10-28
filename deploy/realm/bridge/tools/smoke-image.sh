#!/usr/bin/env bash
# Read-only CI acceptance of an already built local image. No push, SQL or assets.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${1:?Pass the local TEST bridge image tag}"
header_sha="$(sha256sum "$here/core/WorldBridge.h" | cut -d ' ' -f1)"
patch_sha="$(sha256sum "$here/core/world-bridge.patch" | cut -d ' ' -f1)"
docker run --rm --network none --entrypoint python3 \
  --env "EXPECTED_BRIDGE_HEADER_SHA256=$header_sha" --env "EXPECTED_BRIDGE_PATCH_SHA256=$patch_sha" \
  --mount "type=bind,src=$here/tools/verify-image.py,dst=/verify-image.py,readonly" \
  "$image" /verify-image.py
docker run --rm --network none --entrypoint python3 "$image" /opt/railway-core/smoke_runtime.py
