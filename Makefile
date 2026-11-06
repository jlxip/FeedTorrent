# Portable entry point. The build recipes use GNU Make (gmake on OpenBSD).
.PHONY: all build deps native-deps web native licenses run test test-native test-ui check check-native check-wasm test-safari test-deps verify-source clean forward
all build deps native-deps web native licenses run test test-native test-ui check check-native check-wasm test-safari test-deps verify-source clean: forward
forward:
	+@set -e; \
	for file in $(MAKEFILE_LIST); do :; done; \
	if command -v gmake >/dev/null 2>&1; then builder=gmake; else builder=make; fi; \
	if ! "$$builder" --version 2>/dev/null | head -n 1 | grep -q 'GNU Make'; then \
	  echo 'GNU Make is required (install gmake on OpenBSD).' >&2; exit 1; \
	fi; \
	goals='$(MAKECMDGOALS)'; [ -n "$$goals" ] || goals='$(.TARGETS)'; \
	set --; for goal in $$goals; do [ "$$goal" != all ] || goal=build; set -- "$$@" "$$goal"; done; \
	[ "$$#" != 0 ] || set -- build; \
	exec "$$builder" -f "$$(dirname "$$file")/dev/build.mk" "$$@"
