#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/project/scripts" "$work/project/src-tauri" "$work/home"
export HOME="$work/home"
export PATH="$work/bin:$PATH"
export BUILD_TEST_LOG="$work/log"

for script in flatpak-build.sh flatpak-runtime-test.sh musl-build.sh musl-runtime-test.sh \
  musl-gui-test.sh musl-launcher.sh check-window-class.sh; do
  sh -n "$root/scripts/$script"
done
sh -n "$root/install.sh"
python3 - "$root/scripts/test-mpris.py" "$root/scripts/check-webkit-paths.py" "$root/scripts/wave-webkit.py" <<'PY'
import ast
import pathlib
import sys
for path in sys.argv[1:]:
    ast.parse(pathlib.Path(path).read_text(encoding="utf-8"), filename=path)
PY

cat > "$work/bin/xprop" <<'MOCK'
#!/bin/sh
set -eu
test "$*" = '-id 123 WM_CLASS'
printf '%s\n' "$WINDOW_PROPERTY"
MOCK
chmod +x "$work/bin/xprop"
export WINDOW_PROPERTY='WM_CLASS(STRING) = "com.wave.app", "Com.wave.app"'
sh "$root/scripts/check-window-class.sh" 123 Com.wave.app
if sh "$root/scripts/check-window-class.sh" 123 com.wave.app > "$work/window.log" 2>&1; then
  printf 'A window instance was accepted as its class\n' >&2
  exit 1
fi
grep -Fq 'does not match com.wave.app' "$work/window.log"
WINDOW_PROPERTY='WM_CLASS:  not found.'; export WINDOW_PROPERTY
if sh "$root/scripts/check-window-class.sh" 123 '' > "$work/window.log" 2>&1; then
  printf 'A missing window class was accepted\n' >&2
  exit 1
fi

cp "$root/scripts/musl-build.sh" "$work/project/scripts/"
printf '{"app":"phone"}\n' > "$work/project/src-tauri/tauri.phone.conf.json"
cat > "$work/bin/apk" <<'MOCK'
#!/bin/sh
printf 'apk %s\n' "$*" >> "$BUILD_TEST_LOG"
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$BUILD_TEST_LOG"
printf '%s\n' 'printf "rustup %s\n" "$*" >> "$BUILD_TEST_LOG"'
MOCK
cat > "$work/bin/npm" <<'MOCK'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$BUILD_TEST_LOG"
MOCK
cat > "$work/bin/node" <<'MOCK'
#!/bin/sh
printf 'node %s\n' "$*" >> "$BUILD_TEST_LOG"
MOCK
cat > "$work/bin/cargo" <<'MOCK'
#!/bin/sh
printf 'cargo %s\n' "$*" >> "$BUILD_TEST_LOG"
printf 'rustflags %s\n' "$CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS" >> "$BUILD_TEST_LOG"
printf 'config %s\n' "$TAURI_CONFIG" >> "$BUILD_TEST_LOG"
exit "${BUILD_TEST_CARGO_STATUS:-0}"
MOCK
cat > "$work/bin/ldd" <<'MOCK'
#!/bin/sh
printf 'ldd %s\n' "$*" >> "$BUILD_TEST_LOG"
MOCK
chmod +x "$work/bin/"*
cd "$work/project"
sh scripts/musl-build.sh
grep -Fq 'apk add --no-cache build-base curl nodejs npm pkgconf' "$BUILD_TEST_LOG"
grep -Fxq 'rustup -y --profile minimal --no-modify-path' "$BUILD_TEST_LOG"
grep -Fxq 'npm ci' "$BUILD_TEST_LOG"
grep -Fxq 'node scripts/release.mjs musl' "$BUILD_TEST_LOG"
grep -Fxq 'cargo test --manifest-path src-tauri/Cargo.toml --release --target aarch64-unknown-linux-musl --lib' "$BUILD_TEST_LOG"
grep -Fxq 'rustflags -C target-feature=-crt-static' "$BUILD_TEST_LOG"
grep -Fxq 'config {"app":"phone"}' "$BUILD_TEST_LOG"
grep -Fxq 'ldd src-tauri/target/aarch64-unknown-linux-musl/release/wave' "$BUILD_TEST_LOG"

: > "$BUILD_TEST_LOG"
if BUILD_TEST_CARGO_STATUS=17 sh scripts/musl-build.sh; then
  printf 'A failed musl test unexpectedly succeeded\n' >&2
  exit 1
fi
if grep -Fq 'ldd ' "$BUILD_TEST_LOG"; then
  printf 'The musl build continued after the tests failed\n' >&2
  exit 1
fi
