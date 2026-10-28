#!/usr/bin/env bash
# Source-only CI verification. Never deploys, starts a realm, or connects to MariaDB.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source_tree="${1:?Pass a clean exact-pinned recursive CMaNGOS checkout}"
build_tree="${2:?Pass a separate scratch build directory}"
node "$here/tools/apply-patch.mjs" "$source_tree" --apply
cmake -S "$source_tree" -B "$build_tree" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_GAME_SERVER=ON -DBUILD_LOGIN_SERVER=ON \
  -DBUILD_EXTRACTORS=OFF -DBUILD_PLAYERBOTS=OFF -DBUILD_AHBOT=OFF -DPCH=OFF
cmake --build "$build_tree" --target mangosd realmd --parallel "${BUILD_JOBS:-2}"
printf 'Full pinned core compilation passed; MariaDB fault/login acceptance is still required.\n'
