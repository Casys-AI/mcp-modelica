#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke-container-http.sh <image>}"
container_id="$(docker run --detach --rm --publish 127.0.0.1:3016:3016 "$image")"

cleanup() {
  docker logs "$container_id" >&2 || true
  docker stop "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:3016/health; then
    exit 0
  fi
  sleep 1
done

echo "mcp-modelica did not serve /health within 20 seconds" >&2
exit 1
