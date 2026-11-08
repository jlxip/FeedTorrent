#!/bin/sh
set -eu
export PATH="$HOME/.cargo/bin:$PATH"
export NATIVE_JOBS=${NATIVE_JOBS:-2}
if [ "$(uname -s)" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=15.0
fi
make build test-deps
if [ "$(uname -s)" != OpenBSD ]; then
  node dev/node_modules/playwright/cli.js install --with-deps chrome firefox webkit
fi
make check test
node dev/ci/package.mjs
