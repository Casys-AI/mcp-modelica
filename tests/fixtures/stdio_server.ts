/** Real stdio Modelica server with a deterministic runner; never invokes OMC. */
import { createModelicaServer } from "../../server.ts";
import { createModelicaService } from "../../src/domain/service.ts";
import { FakeRunner } from "../test-helpers.ts";

const [runsDirectory] = Deno.args;
if (!runsDirectory) throw new Error("usage: stdio_server <runs-directory>");

const service = await createModelicaService({
  runsDirectory,
  runner: new FakeRunner(),
});
const { server } = await createModelicaServer({ service });
await server.start();
