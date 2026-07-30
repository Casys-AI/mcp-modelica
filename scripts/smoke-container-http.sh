#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke-container-http.sh <image> [expected-version]}"
expected_version="${2:-}"
container_id="$(docker run --detach --rm --publish 127.0.0.1:3016:3016 "$image")"

cleanup() {
  docker logs "$container_id" >&2 || true
  docker stop "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..20}; do
  if health="$(curl --fail --silent --show-error http://127.0.0.1:3016/health)"; then
    if [[ -z "$expected_version" || "$health" == *"\"version\":\"$expected_version\""* ]]; then
      printf '%s\n' "$health"
      exit 0
    fi
    echo "mcp-modelica health reported an unexpected version: $health" >&2
  fi
  sleep 1
done

echo "mcp-modelica did not serve /health within 20 seconds" >&2
exit 1
