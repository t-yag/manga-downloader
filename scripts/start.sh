#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
docker compose up -d

port_output=$(docker compose port frontend 80)
published_port=$(printf '%s\n' "$port_output" | sed -n '1s/.*://p')
case "$published_port" in
  ''|*[!0-9]*)
    printf 'Web UI の公開ポートを取得できませんでした。\n' >&2
    exit 1
    ;;
esac

printf 'Web UI: http://localhost:%s\n' "$published_port"
