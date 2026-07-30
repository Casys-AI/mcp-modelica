import { assert, assertMatch } from "@std/assert";

Deno.test("Docker release inputs are immutable and verified", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../Dockerfile", import.meta.url));

  assertMatch(
    dockerfile,
    /^FROM openmodelica\/openmodelica@sha256:[a-f0-9]{64} AS runtime$/m,
  );
  assertMatch(
    dockerfile,
    /COPY --from=denoland\/deno@sha256:[a-f0-9]{64} \/deno \/usr\/local\/bin\/deno/,
  );
  assertMatch(dockerfile, /^ARG MSL_TARBALL_SHA256=[a-f0-9]{64}$/m);
  assert(
    dockerfile.includes("sha256sum -c -"),
    "The downloaded MSL archive must be verified before extraction.",
  );
});
