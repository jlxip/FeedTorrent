#!/bin/sh
set -eu
export PATH="$HOME/.cargo/bin:$PATH"
export NATIVE_JOBS=${NATIVE_JOBS:-2}
host=$(uname -s)
if [ "$host" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=15.0
fi
make build test-deps
case "$host" in
  Darwin)
    node dev/node_modules/playwright/cli.js install --with-deps chrome webkit
    make check-native test-native
    make test-ui UI_ARGS='--project=webkit'
    make test-ui UI_ARGS='publication-live.spec.ts news.spec.ts --project=chrome'
    ;;
  Linux)
    make check-native test-native host-wasm
    ;;
  OpenBSD)
    make check-native test-native
    ;;
  *)
    echo "Unsupported CI host: $host" >&2
    exit 1
    ;;
esac
node dev/ci/package.mjs
