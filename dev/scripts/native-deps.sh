#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source="$root/backends/libtorrent/vendor/libtorrent"
case "${1:-}" in ''|--verify-source) ;; *) echo 'Unexpected native-deps argument' >&2; exit 1;; esac
if [ ! -e "$source/.git" ]; then git -C "$root" submodule update --init backends/libtorrent/vendor/libtorrent; fi
test "$(git -C "$source" rev-parse HEAD)" = 6da363d2994f17c0b3c0450d124cf73a31a73847 || { echo 'Unexpected libtorrent revision' >&2; exit 1; }
git -C "$source" diff --exit-code HEAD
if [ ! -e "$source/deps/try_signal/.git" ]; then git -C "$source" submodule update --init deps/try_signal; fi
rtc="$source/deps/libdatachannel"
if [ ! -e "$rtc/.git" ]; then git -C "$source" submodule update --init deps/libdatachannel; fi
for dependency in libjuice plog usrsctp; do
  if [ ! -e "$rtc/deps/$dependency/.git" ]; then git -C "$rtc" submodule update --init "deps/$dependency"; fi
done
for dependency in deps/libdatachannel deps/libdatachannel/deps/libjuice deps/libdatachannel/deps/plog deps/libdatachannel/deps/usrsctp; do
  case "$dependency" in deps/libdatachannel) expected=$(git -C "$source" rev-parse HEAD:deps/libdatachannel);; *) expected=$(git -C "$rtc" rev-parse "HEAD:deps/$(basename "$dependency")");; esac
  test "$(git -C "$source/$dependency" rev-parse HEAD)" = "$expected" || { echo "Unexpected source revision: $dependency" >&2; exit 1; }
  git -C "$source/$dependency" diff --exit-code HEAD
done
[ "${1:-}" != --verify-source ] || exit 0
jobs=${NATIVE_JOBS:-6}
if [ "$(uname -s)" = OpenBSD ]; then jobs=${NATIVE_JOBS:-2}; fi
set -- cmake -S "$root/backends/libtorrent/vendor/libtorrent" \
  -B "$root/.tools/libtorrent-build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_STANDARD=17 -DCMAKE_INSTALL_PREFIX="$root/.tools/native" \
  -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -Dwebtorrent=ON \
  -Di2p=OFF -Dbuild_tests=OFF -Dbuild_examples=OFF -Dbuild_tools=OFF \
  -Dpython-bindings=OFF
# Every distributable carries OpenSSL, including OpenBSD. LibreSSL rejects
# modern DTLS supported_versions offers; never fall back to the base library.
set -- "$@" -DOPENSSL_USE_STATIC_LIBS=TRUE
if [ "$(uname -s)" = OpenBSD ]; then
  tls_root=${OPENSSL_ROOT_DIR:-/usr/local}
  tls_include="$tls_root/include/eopenssl35"
  tls_lib="$tls_root/lib/eopenssl35"
  if [ ! -d "$tls_include" ]; then
    tls_include="$tls_root/include"
    tls_lib="$tls_root/lib"
  fi
  for input in "$tls_include/openssl/opensslv.h" "$tls_lib/libssl.a" "$tls_lib/libcrypto.a"; do
    if [ ! -s "$input" ]; then
      echo "Missing OpenSSL build input: $input (install openssl%3.5 or set OPENSSL_ROOT_DIR)" >&2
      exit 1
    fi
  done
  if grep -q LIBRESSL_VERSION_NUMBER "$tls_include/openssl/opensslv.h"; then
    echo 'FeedTorrent requires OpenSSL for DTLS; LibreSSL is not supported.' >&2
    exit 1
  fi
  printf '#include <openssl/opensslv.h>\n#if !defined(OPENSSL_VERSION_MAJOR) || OPENSSL_VERSION_MAJOR < 3\n#error OpenSSL 3 or newer is required\n#endif\n' |
    cc -E -x c -I "$tls_include" - >/dev/null
  set -- "$@" "-DOPENSSL_INCLUDE_DIR=$tls_include" \
    "-DOPENSSL_SSL_LIBRARY=$tls_lib/libssl.a" "-DOPENSSL_CRYPTO_LIBRARY=$tls_lib/libcrypto.a"
fi
# Honor explicit paths everywhere; Homebrew discovery is specific to macOS.
if [ "$(uname -s)" = Darwin ]; then
  : "${OPENSSL_ROOT_DIR:=$(brew --prefix openssl@3)}"
  : "${BOOST_ROOT:=$(brew --prefix boost)}"
  set -- "$@" "-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-15.0}"
fi
if [ -n "${OPENSSL_ROOT_DIR:-}" ]; then set -- "$@" "-DOPENSSL_ROOT_DIR=$OPENSSL_ROOT_DIR"; fi
if [ -n "${BOOST_ROOT:-}" ]; then set -- "$@" "-DBoost_ROOT=$BOOST_ROOT"; fi
set -- "$@" "-DCMAKE_PROJECT_libtorrent_INCLUDE=$root/dev/cmake/native.cmake"
"$@"
cmake --build "$root/.tools/libtorrent-build" -j "$jobs"
cmake --install "$root/.tools/libtorrent-build"
