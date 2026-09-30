#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/manga-downloader-test.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
mkdir "$test_dir/bin"

cat > "$test_dir/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_CALLS"
printf 'cwd=%s\n' "$(pwd)" >> "$DOCKER_CALLS"
case "$*" in
  'compose up -d')
    if [ "${FAIL_UP:-0}" = 1 ]; then
      printf 'compose startup failed\n' >&2
      exit 1
    fi
    ;;
  'compose port frontend 80')
    if [ "${FAIL_PORT:-0}" = 1 ]; then
      exit 1
    fi
    if [ "${EMPTY_PORT:-0}" = 1 ]; then
      exit 0
    fi
    printf '0.0.0.0:%s\n' "${PUBLISHED_PORT:-8080}"
    ;;
  'compose down') ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$test_dir/bin/docker"
export PATH="$test_dir/bin:$PATH" DOCKER_CALLS="$test_dir/calls"

assert_contains() {
  if ! grep -Fq "$2" "$1"; then
    printf 'Expected %s to contain %s\n' "$1" "$2" >&2
    exit 1
  fi
}

assert_not_contains() {
  if grep -Fq "$2" "$1"; then
    printf 'Expected %s not to contain %s\n' "$1" "$2" >&2
    exit 1
  fi
}

: > "$DOCKER_CALLS"
(cd "$test_dir" && PUBLISHED_PORT=9090 sh "$repo_dir/scripts/start.sh") > "$test_dir/output"
assert_contains "$test_dir/output" 'http://localhost:9090'
assert_contains "$DOCKER_CALLS" 'compose up -d'
assert_contains "$DOCKER_CALLS" 'compose port frontend 80'
assert_contains "$DOCKER_CALLS" "cwd=$repo_dir"

: > "$DOCKER_CALLS"
if FAIL_UP=1 sh "$repo_dir/scripts/start.sh" > "$test_dir/output" 2> "$test_dir/error"; then
  printf 'Expected failed Compose startup to return an error\n' >&2
  exit 1
fi
assert_not_contains "$test_dir/output" 'http://'
assert_not_contains "$DOCKER_CALLS" 'compose port frontend 80'

if FAIL_PORT=1 sh "$repo_dir/scripts/start.sh" > "$test_dir/output" 2> "$test_dir/error"; then
  printf 'Expected missing published port to return an error\n' >&2
  exit 1
fi
assert_not_contains "$test_dir/output" 'http://'

if EMPTY_PORT=1 sh "$repo_dir/scripts/start.sh" > "$test_dir/output" 2> "$test_dir/error"; then
  printf 'Expected an empty published port to return an error\n' >&2
  exit 1
fi
assert_not_contains "$test_dir/output" 'http://'

: > "$DOCKER_CALLS"
(cd "$test_dir" && sh "$repo_dir/scripts/stop.sh")
assert_contains "$DOCKER_CALLS" 'compose down'
assert_contains "$DOCKER_CALLS" "cwd=$repo_dir"

printf 'docker script tests passed\n'
