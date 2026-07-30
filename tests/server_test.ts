import { assertEquals, assertThrows } from "@std/assert";
import { parseCli } from "../server.ts";

Deno.test("CLI accepts an explicit stdio transport for Docker MCP clients", () => {
  assertEquals(parseCli(["--stdio"]), {
    http: false,
    port: 3016,
    hostname: "127.0.0.1",
  });
  assertEquals(parseCli(["--http", "--port=3017", "--hostname", "0.0.0.0"]), {
    http: true,
    port: 3017,
    hostname: "0.0.0.0",
  });
  assertThrows(
    () => parseCli(["--http", "--stdio"]),
    TypeError,
    "Choose either --http or --stdio",
  );
});
