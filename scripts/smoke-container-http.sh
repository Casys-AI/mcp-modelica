#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke-container-http.sh <image> [expected-version] [expected-deno-version]}"
expected_version="${2:-}"
expected_deno_version="${3:-}"
container_id="$(docker run --detach --rm --publish 127.0.0.1:3016:3016 "$image")"

cleanup() {
  docker logs "$container_id" >&2 || true
  docker stop "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=false
for _ in {1..20}; do
  if health="$(curl --fail --silent --show-error http://127.0.0.1:3016/health)"; then
    if [[ -z "$expected_version" || "$health" == *"\"version\":\"$expected_version\""* ]]; then
      printf '%s\n' "$health"
      ready=true
      break
    fi
    echo "mcp-modelica health reported an unexpected version: $health" >&2
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "mcp-modelica did not serve /health within 20 seconds" >&2
  exit 1
fi

if [[ -n "$expected_deno_version" ]]; then
  discovery="$(curl --fail --silent --show-error \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'MCP-Protocol-Version: 2026-07-28' \
    --header 'Mcp-Method: server/discover' \
    --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
    http://127.0.0.1:3016/mcp)"
  initialized="$(curl --fail --silent --show-error \
    --request POST \
    --header 'Content-Type: application/json' \
    --header 'MCP-Protocol-Version: 2026-07-28' \
    --header 'Mcp-Method: initialize' \
    --data '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"modelica-container-http-smoke","version":"1.0.0"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
    http://127.0.0.1:3016/mcp)"
  node -e '
    const [expectedVersion, expectedDenoVersion, discovery, initialized] = process.argv.slice(1);
    for (const [method, body] of [["server/discover", discovery], ["initialize", initialized]]) {
      const result = JSON.parse(body).result;
      if (expectedVersion && result?.serverInfo?.version !== expectedVersion) {
        throw new Error(`${method} reported ${result?.serverInfo?.version}, expected ${expectedVersion}`);
      }
      const expectedInstruction = `Runtime identity: Deno ${expectedDenoVersion}.`;
      if (typeof result?.instructions !== "string" || !result.instructions.includes(expectedInstruction)) {
        throw new Error(`${method} did not report ${expectedInstruction}`);
      }
    }
  ' "$expected_version" "$expected_deno_version" "$discovery" "$initialized"
fi
