ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
SHELL := /bin/sh
.DEFAULT_GOAL := build
BUILD_OS := $(shell uname -s)
ifeq ($(BUILD_OS),OpenBSD)
NATIVE_JOBS ?= 2
else
NATIVE_JOBS ?= 6
endif
ARGS ?=
LIBTORRENT_SOURCE := $(ROOT)/backends/libtorrent/vendor/libtorrent
LIBTORRENT_COMMIT := 6da363d2994f17c0b3c0450d124cf73a31a73847
NPM_READY := $(ROOT)/dev/node_modules/.feedtorrent-ready
SOURCE_READY := $(ROOT)/.tools/libtorrent-source.ready
NATIVE_READY := $(ROOT)/.tools/native/.ready
WEB_READY := $(ROOT)/web/dist/.ready
WEB_SOURCES := $(wildcard $(ROOT)/web/*.ts) $(ROOT)/web/theme.js $(ROOT)/web/app.css $(ROOT)/web/index.html $(ROOT)/web/tsconfig.json $(wildcard $(ROOT)/web/vendor/*)

.PHONY: test-native test-ui check-native check-wasm verify-source build deps native-deps web native licenses run test check test-safari test-deps clean
build: licenses

deps: $(NPM_READY) native-deps
$(NPM_READY): $(ROOT)/dev/package.json $(ROOT)/dev/package-lock.json
	cd "$(ROOT)/dev" && npm ci --ignore-scripts
	touch "$@"

$(SOURCE_READY): $(ROOT)/dev/build.mk $(ROOT)/.gitmodules
	mkdir -p "$(ROOT)/.tools"
	@if [ ! -f "$(LIBTORRENT_SOURCE)/.git" ]; then git -C "$(ROOT)" submodule update --init backends/libtorrent/vendor/libtorrent; fi
	@test "$$(git -C "$(LIBTORRENT_SOURCE)" rev-parse HEAD)" = "$(LIBTORRENT_COMMIT)" || { echo 'Unexpected libtorrent revision'; exit 1; }
	git -C "$(LIBTORRENT_SOURCE)" diff --exit-code HEAD
	git -C "$(LIBTORRENT_SOURCE)" submodule update --init deps/try_signal
	touch "$@"

verify-source: $(SOURCE_READY)
	@test "$$(git -C "$(LIBTORRENT_SOURCE)" rev-parse HEAD)" = "$(LIBTORRENT_COMMIT)" || { echo 'Unexpected libtorrent revision'; exit 1; }
	git -C "$(LIBTORRENT_SOURCE)" diff --exit-code HEAD

native-deps: verify-source $(NATIVE_READY)
$(NATIVE_READY): $(SOURCE_READY) $(ROOT)/Makefile $(ROOT)/dev/build.mk $(ROOT)/dev/scripts/native-deps.sh $(ROOT)/dev/cmake/openbsd.cmake
	cd "$(ROOT)" && NATIVE_JOBS=$(NATIVE_JOBS) sh dev/scripts/native-deps.sh
	touch "$@"

web: $(WEB_READY)
$(WEB_READY): $(WEB_SOURCES) $(NPM_READY) $(ROOT)/dev/build.mk
	mkdir -p "$(ROOT)/web/dist"
	cd "$(ROOT)" && node dev/node_modules/typescript/bin/tsc -p web/tsconfig.json --outDir web/dist
	cp "$(ROOT)/web/index.html" "$(ROOT)/web/dist/index.html"
	cp "$(ROOT)/web/app.css" "$(ROOT)/web/dist/app.css"
	cp "$(ROOT)/web/theme.js" "$(ROOT)/web/dist/theme.js"
	cp "$(ROOT)/web/vendor/basecoat-vega-1.0.2.min.css" "$(ROOT)/web/dist/basecoat.css"
	cp "$(ROOT)/web/vendor/lucide-0.468.0.min.js" "$(ROOT)/web/dist/lucide.js"
	cp "$(ROOT)/web/vendor/basecoat-runtime-1.0.2.min.js" "$(ROOT)/web/dist/basecoat-runtime.js"
	cp "$(ROOT)/web/vendor/basecoat-tabs-1.0.2.min.js" "$(ROOT)/web/dist/basecoat-tabs.js"
	cp "$(ROOT)/web/vendor/basecoat-sidebar-1.0.2.min.js" "$(ROOT)/web/dist/basecoat-sidebar.js"
	cp "$(ROOT)/web/vendor/basecoat-dropdown-menu-1.0.2.min.js" "$(ROOT)/web/dist/basecoat-dropdown-menu.js"
	touch "$@"

native: web native-deps
	cd "$(ROOT)" && cargo build --locked --release
licenses: native
	cd "$(ROOT)" && node dev/scripts/licenses.mjs

# Build recipes run in ROOT; the server itself keeps Make's working directory.
run: build
	"$(ROOT)/target/release/feedtorrent" $(ARGS)

test-deps: $(NPM_READY)
	cd "$(ROOT)" && NATIVE_JOBS=$(NATIVE_JOBS) sh dev/scripts/test-deps.sh

ifeq ($(BUILD_OS),OpenBSD)
test: test-native
else
test: test-native check-wasm test-ui
endif

test-native: build test-deps
	cd "$(ROOT)" && node dev/tests/make-entry.mjs
	cd "$(ROOT)" && cargo test --locked --workspace
	cd "$(ROOT)" && cargo build --locked --release -p feedtorrent-libtorrent --example bep44-peer
	# Shared isolated DHT harness covers BEP 44, BEP 46 and BEP 49.
	cd "$(ROOT)" && node dev/tests/bep44.mjs
	cd "$(ROOT)" && cargo build --locked --release -p feedtorrent-pubsub-udp --example bep50-peer
	cd "$(ROOT)" && node dev/tests/bep50.mjs
	cd "$(ROOT)" && node dev/tests/network.mjs
	cd "$(ROOT)" && node dev/tests/tls.mjs
	cd "$(ROOT)" && node dev/tests/edge-cases.mjs
	cd "$(ROOT)" && node dev/tests/open-cwd.mjs
	cd "$(ROOT)" && node dev/tests/posts.mjs
	cd "$(ROOT)" && node dev/tests/publishing.mjs
	cd "$(ROOT)" && node dev/tests/key-vault.mjs
	cd "$(ROOT)" && node dev/tests/retention.mjs
	cd "$(ROOT)" && node dev/tests/organization.mjs
	@if [ "$$(uname -s)" = OpenBSD ]; then cd "$(ROOT)" && node dev/tests/desktop.mjs; fi
test-ui: build test-deps
	cd "$(ROOT)" && node dev/node_modules/playwright/cli.js test --config dev/playwright.config.ts

ifeq ($(BUILD_OS),OpenBSD)
check: check-native
else
check: check-native check-wasm
endif
check-native: web native-deps
	cd "$(ROOT)" && cargo fmt --all -- --check
	cd "$(ROOT)" && cargo clippy --locked --workspace --all-targets -- -D warnings
	cd "$(ROOT)" && node dev/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit
check-wasm:
	cd "$(ROOT)" && cargo check --locked --offline -p feedtorrent-bep -p feedtorrent-posts --target wasm32-unknown-unknown
	cd "$(ROOT)" && node dev/tests/bep-consumer.mjs
	cd "$(ROOT)" && node dev/tests/posts-consumer.mjs

test-safari: build test-deps
	cd "$(ROOT)" && node dev/tests/safari.mjs

clean:
	rm -rf -- "$(ROOT)/target" "$(ROOT)/web/dist"
