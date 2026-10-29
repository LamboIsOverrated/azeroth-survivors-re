#!/bin/sh
set -eu
mkdir -p /state/client
chown node:node /state /state/client
exec gosu node node /app/deploy/realm/web/runtime.mjs
