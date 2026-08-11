import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { basename, dirname } from "@std/path";
import { CapacityCoordinator } from "../src/storage/capacity-coordinator.ts";
import { stableJson } from "../src/domain/hashing.ts";

Deno.test("capacity request selectors are bounded, path-safe, and collision-resistant", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-capacity-selector-" });
  try {
    const capacity = new CapacityCoordinator(directory);
    const leftId = "../outside/../../request";
    const rightId = "..\\outside\\request";
    const left = await capacity.requestClaimPath(leftId);
    const right = await capacity.requestClaimPath(rightId);
    assertEquals(dirname(left), `${directory}/.resumable/capacity-claims`);
    assertEquals(dirname(right), dirname(left));
    assert(/^[a-z]+-[0-9a-f]{64}\.json$/.test(basename(left)));
    assert(/^[a-z]+-[0-9a-f]{64}\.json$/.test(basename(right)));
    assertNotEquals(left, right);

    const reservation = await capacity.reserve("request", leftId);
    await assertRejects(
      () => capacity.reserve("request", leftId),
      Error,
      "already exists",
    );
    await reservation.release();
    await assertRejects(() => Deno.stat(`${directory}/outside`), Deno.errors.NotFound);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("malformed claim plus orphan run directory is counted conservatively", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mcp-modelica-capacity-malformed-" });
  try {
    for (let index = 0; index < 18; index++) {
      await Deno.mkdir(`${directory}/run_${crypto.randomUUID()}`);
    }
    const capacity = new CapacityCoordinator(directory);
    const requestId = "malformed-pair";
    await capacity.reserve("request", requestId);
    const runId = `run_${crypto.randomUUID()}`;
    await capacity.updateRequestClaim(
      requestId,
      stableJson({
        schemaVersion: "2.1",
        kind: "simulation-request-claim",
        request_id: requestId,
        request_sha256: "1".repeat(64),
        manifest_sha256: "2".repeat(64),
        state: "promoting",
        slot_reserved: true,
        run_id: runId,
        unknown: "must prevent deduplication",
      }),
    );
    await Deno.mkdir(`${directory}/${runId}`);
    await assertRejects(
      () => capacity.reserve("request", "must-be-blocked"),
      Error,
      "limit 20",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
