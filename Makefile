SHELL = /bin/sh
NPM_READY = dev/node_modules/.feedtorrent-ready
NATIVE_READY = .tools/native/.ready
WEB_READY = web/dist/.ready
WEB_SOURCES = web/. web/vendor web/*.ts web/theme.js web/app.css web/index.html web/tsconfig.json web/vendor/*
CHECK_ROOT = test -f Makefile && test -f Cargo.toml && grep -q '^name = "feedtorrent"$$' app/Cargo.toml && test -f web/tsconfig.json || { echo 'Run make from the FeedTorrent repository root.' >&2; exit 1; }
WASM_CHECK = cargo check --locked --offline -p feedtorrent-bep -p feedtorrent-posts --target wasm32-unknown-unknown && node dev/tests/bep-consumer.mjs && node dev/tests/posts-consumer.mjs
UI_TEST = node dev/scripts/ui.mjs
UI_ARGS =
UNIT_ARGS = --workspace
ALL_NATIVE_SUITES = bep44 bep50 network tls edge-cases open-cwd posts publishing key-vault retention organization storage creation images http-ports

NATIVE_SUITES = $(ALL_NATIVE_SUITES)

all: build

.PHONY: all root build deps native-deps web native licenses run test test-native test-unit test-integration test-build test-platform test-ui test-ports check check-native check-rust check-web check-wasm test-safari test-deps verify-source clean host-wasm host-ui
# Gate shared preparation too, so parallel check/test goals cannot start work
# before the fixed-port requirement has been checked. Focused suites stay usable.
HTTP_PORT_GOALS = $(filter test test-native,$(MAKECMDGOALS))
ifneq ($(filter http-ports,$(NATIVE_SUITES)),)
HTTP_PORT_GOALS += $(filter test-integration,$(MAKECMDGOALS))
endif
ifneq ($(strip $(HTTP_PORT_GOALS)),)
root $(NPM_READY) $(NATIVE_READY) web native-deps: | test-ports
endif
test-ports:
	@$(CHECK_ROOT)
	@node dev/scripts/test-ports.mjs
root:
	@$(CHECK_ROOT)

deps: $(NPM_READY) native-deps
$(NPM_READY): dev/package.json dev/package-lock.json
	@$(CHECK_ROOT)
	cd dev && npm ci --ignore-scripts
	touch "$@"

verify-source: root
	sh dev/scripts/native-deps.sh --verify-source
native-deps: $(NATIVE_READY)
	sh dev/scripts/native-deps.sh --verify-source
$(NATIVE_READY): dev/scripts/native-deps.sh dev/cmake/openbsd.cmake .gitmodules
	@$(CHECK_ROOT)
	NATIVE_JOBS="$(NATIVE_JOBS)" sh dev/scripts/native-deps.sh
	touch "$@"

web: $(WEB_READY)
$(WEB_READY): $(WEB_SOURCES) $(NPM_READY) dev/scripts/web.sh
	@$(CHECK_ROOT)
	sh dev/scripts/web.sh

native: web native-deps
	cargo build --locked --release
licenses: native
	node dev/scripts/licenses.mjs
build: licenses
run: build
	./target/release/feedtorrent $(ARGS)

test-deps: $(NPM_READY)
	@$(CHECK_ROOT)
	NATIVE_JOBS="$(NATIVE_JOBS)" sh dev/scripts/test-deps.sh

test: test-native host-wasm host-ui
test-native: test-unit test-integration test-build test-platform
test-unit: web native-deps
	node dev/scripts/unit.mjs $(UNIT_ARGS)
test-build: $(NPM_READY) root
	node dev/tests/make-entry.mjs
	python3 dev/tests/validation-env.py
	node --test dev/tests/package.test.mjs dev/tests/release.test.mjs dev/tests/pre-commit.test.mjs dev/tests/test-deps.test.mjs dev/tests/disk-image.test.mjs dev/tests/test-ports.test.mjs
test-integration: build test-deps
	@test -n "$(NATIVE_SUITES)" || { echo 'No native suites selected.' >&2; exit 2; }
	@set -e; for suite in $(NATIVE_SUITES); do case " $(ALL_NATIVE_SUITES) " in *" $$suite "*) ;; *) echo "Unknown native suite: $$suite" >&2; exit 2;; esac; done
	cargo build --locked --release -p feedtorrent-libtorrent -p feedtorrent-pubsub-udp --examples
	@set -e; for suite in $(NATIVE_SUITES); do node "dev/tests/$$suite.mjs"; done
test-platform: build test-deps
	@if [ "$$(uname -s)" = OpenBSD ]; then node dev/tests/desktop.mjs; fi
test-ui: build test-deps
	$(UI_TEST) $(UI_ARGS)

check: check-native host-wasm
check-native: check-rust check-web
check-rust: web native-deps
	cargo fmt --all -- --check
	sh dev/scripts/clippy.sh
check-web: $(NPM_READY) root
	node dev/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit

check-wasm: root
	$(WASM_CHECK)
# Default suites follow the host's capabilities; explicit targets remain available.
host-wasm: root
	@if [ "$$(uname -s)" != OpenBSD ]; then $(WASM_CHECK); fi
host-ui: build test-deps
	@if [ "$$(uname -s)" != OpenBSD ]; then $(UI_TEST) $(UI_ARGS); fi

test-safari: build test-deps
	node dev/tests/safari.mjs
clean: root
	rm -rf -- target web/dist
