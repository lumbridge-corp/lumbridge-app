#!/usr/bin/env bash
# What CI runs (.github/workflows/ci.yml), and what to run before a pull request: scripts/ci.sh
# Builds the tests and runs them, on Linux (headless: the render tests use the software Vulkan driver). Not here: the bun
# tests of `just test` (scripts/*.test.ts; CI has no bun) and cargo fmt (not enforced yet).
# Needs vendor/ghostty (git submodule update --init) and Zig 0.16 (ZIG or PATH). A throwaway home and LUMBRIDGE_APP_HOME:
# no real ~/.config/lumbridge-app, no window, no real Lumbridge Core.
set -euo pipefail
cd "$(dirname "$0")/.."
# A throwaway home: nothing here may read or write a real config, state or socket. cargo, rustup and zig keep their own
# directories, so the build is offline from the caches that are already there.
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/zig}"
T=$(mktemp -d "${TMPDIR:-/tmp}/lci.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/config" "$T/data" "$T/state" "$T/cache" "$T/run"
chmod 700 "$T/run"
export HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/run"
unset TMUX TMUX_PANE
for v in $(env | grep -oE '^(LBC_|LUMBRIDGE_)[A-Za-z0-9_]*' | grep -vxE 'LUMBRIDGE_CI_TOOLS|LBC_TEST_WATCHDOG_S' || true); do unset "$v"; done
export LUMBRIDGE_APP_HOME="$T/app"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-1}" CARGO_PROFILE_TEST_DEBUG="${CARGO_PROFILE_TEST_DEBUG:-1}" CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
rustc --version; "${ZIG:-zig}" version
cargo test --locked --no-run
cargo test --locked -- --test-threads "${RUST_TEST_THREADS:-4}"
