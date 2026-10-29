#!/usr/bin/env bash
# Reproduce pinned upstream source inputs; see PROVENANCE.md for license/source obligations.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/upstreams.env"
checkout="$(mktemp -d)"
git clone https://github.com/Arnesen/wenilla-realm.git "$checkout/companion"
git -C "$checkout/companion" checkout --detach "$COMPANION_COMMIT"
docker build -f "$checkout/companion/docker/mangos.Dockerfile" \
  --build-arg "MANGOS_CLASSIC_COMMIT=$MANGOS_CLASSIC_COMMIT" \
  --build-arg "CLASSIC_DB_COMMIT=$CLASSIC_DB_COMMIT" \
  --build-arg "PLAYERBOTS_COMMIT=$PLAYERBOTS_COMMIT" \
  -t wenilla-core-source:pinned "$checkout/companion"
printf 'Pinned source checkout retained at %s\n' "$checkout/companion"
