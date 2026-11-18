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
  # The addon shares Node's process: match its TLS library to avoid interposing
  # incompatible LibreSSL/OpenSSL symbols when the binding starts DTLS.
  node_libraries=$(ldd "$(command -v node)")
  node_ssl=$(printf '%s\n' "$node_libraries" | awk '$NF ~ /\/libssl\.so\./ { print $NF; exit }')
  node_crypto=$(printf '%s\n' "$node_libraries" | awk '$NF ~ /\/libcrypto\.so\./ { print $NF; exit }')
  node_tls_name=$(basename "$(dirname "$node_ssl")")
  node_tls_include="$node_prefix/include/$node_tls_name"
  test -f "$node_ssl" && test -f "$node_crypto" && test -f "$node_tls_include/openssl/ssl.h"
  addon_inputs=$(cksum dev/scripts/test-deps.sh dev/openbsd-node-datachannel/CMakeLists.txt dev/cmake/openbsd-webrtc.cmake dev/cmake/openbsd-ice.h dev/cmake/openbsd-dtls.h)
  addon_stamp=.tools/node-datachannel/.feedtorrent-inputs
  if [ ! -f dev/node_modules/node-datachannel/build/Release/node_datachannel.node ] || [ "$(cat "$addon_stamp" 2>/dev/null || true)" != "$addon_inputs" ]; then
    npm --prefix "$root/.tools/test-addon" install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund node-addon-api@7.1.1
    cmake -S dev/openbsd-node-datachannel -B .tools/node-datachannel -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      "-DNODE_DATACHANNEL_SOURCE=$root/dev/node_modules/node-datachannel" \
      "-DNODE_ADDON_API=$root/.tools/test-addon/node_modules/node-addon-api" \
      "-DNODE_INCLUDE_DIR=$node_prefix/include/node" \
      "-DOPENSSL_INCLUDE_DIR=$node_tls_include" \
      "-DOPENSSL_SSL_LIBRARY=$node_ssl" "-DOPENSSL_CRYPTO_LIBRARY=$node_crypto"
    cmake --build .tools/node-datachannel -j "${NATIVE_JOBS:-2}"
    mkdir -p dev/node_modules/node-datachannel/build/Release
    cp .tools/node-datachannel/upstream/node_datachannel.node dev/node_modules/node-datachannel/build/Release/
    printf '%s\n' "$addon_inputs" > "$addon_stamp"
  fi
elif [ ! -f dev/node_modules/node-datachannel/build/Release/node_datachannel.node ]; then
  # GitHub release downloads can time out transiently. Retry preparation only;
  # an exhausted download still fails the build, and tests are never retried.
  attempt=1
  while :; do
    if (cd dev/node_modules/node-datachannel && ../.bin/prebuild-install -r napi --verbose); then
      break
    else
      status=$?
    fi
    if [ "$attempt" -ge 3 ]; then
      echo 'node-datachannel prebuild download failed after 3 attempts.' >&2
      exit "$status"
    fi
    echo "Retrying node-datachannel prebuild download ($attempt/3 failed)..." >&2
    sleep 5
    attempt=$((attempt + 1))
  done
fi
