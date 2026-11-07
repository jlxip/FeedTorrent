#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
if [ "$(uname -s)" = OpenBSD ]; then
  # npm ships source for these bindings, but no OpenBSD prebuilt binaries.
  node_prefix=${NODE_PREFIX:-$(node -p 'require("node:path").dirname(require("node:path").dirname(process.execPath))')}
  if ! node -e 'require("./dev/node_modules/utp-native")' >/dev/null 2>&1; then
    node_gyp=$(node -p 'require.resolve("node-gyp/bin/node-gyp.js", { paths: [require("node:path").dirname(require("node:fs").realpathSync(process.argv[1]))] })' "$(command -v npm)")
    (cd dev/node_modules/utp-native && node "$node_gyp" configure --nodedir="$node_prefix" -- -f ninja && ninja -C build/Release -j "${NATIVE_JOBS:-2}")
  fi
  if [ ! -f dev/node_modules/node-datachannel/build/Release/node_datachannel.node ]; then
    npm --prefix "$root/.tools/test-addon" install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund node-addon-api@7.1.1
    cmake -S dev/openbsd-node-datachannel -B .tools/node-datachannel -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      "-DNODE_DATACHANNEL_SOURCE=$root/dev/node_modules/node-datachannel" \
      "-DNODE_ADDON_API=$root/.tools/test-addon/node_modules/node-addon-api" \
      "-DNODE_INCLUDE_DIR=$node_prefix/include/node"
    cmake --build .tools/node-datachannel -j "${NATIVE_JOBS:-2}"
    mkdir -p dev/node_modules/node-datachannel/build/Release
    cp .tools/node-datachannel/upstream/node_datachannel.node dev/node_modules/node-datachannel/build/Release/
  fi
elif [ ! -f dev/node_modules/node-datachannel/build/Release/node_datachannel.node ]; then
  (cd dev/node_modules/node-datachannel && ../.bin/prebuild-install -r napi)
fi
