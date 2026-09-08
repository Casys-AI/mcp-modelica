import { ValidationError } from "./errors.ts";
import type { EngineIdentity, ModelicaKit } from "./types.ts";

/**
 * Exact server-owned OMC/MSL pair accepted for currently shipped kits.
 *
 * This is not a semver range. The versions are the qualified container/runtime
 * identity already documented and image-qualified:
 *
 * - `docs/provider-and-runtime.md`: OpenModelica 1.27.0, Modelica Standard Library 4.1.0
 * - `Dockerfile`: MSL 4.1.0 pin (`MSL_COMMIT` / archive SHA) on the OpenModelica runtime image
 * - `docs/development-and-release.md`: local pin OpenModelica 1.27.0 and MSL 4.1.0
 */
export const QUALIFIED_KIT_RUNTIME = {
  name: "OpenModelica",
  version: "1.27.0",
  msl_version: "4.1.0",
} as const satisfies EngineIdentity;

export const RUNTIME_INCOMPATIBLE_CODE = "runtime_incompatible";
export const COMPATIBILITY_POLICY_UNAVAILABLE_CODE = "compatibility-policy-unavailable";

/**
 * Exact currently shipped kit identities. Unknown id/version has no policy and
 * must not inherit this pair.
 */
const SHIPPED_KIT_RUNTIME_POLICY: Readonly<Record<string, EngineIdentity>> = {
  "coffee-machine-v1@0.1.0": QUALIFIED_KIT_RUNTIME,
  "linear-thermal-ramp-v1@0.1.0": QUALIFIED_KIT_RUNTIME,
};

function shippedKitKey(kit: Pick<ModelicaKit, "id" | "version">): string {
  return `${kit.id}@${kit.version}`;
}

/** Server-owned exact policy for one currently shipped kit identity. */
export function runtimeCompatibilityPolicy(
  kit: Pick<ModelicaKit, "id" | "version">,
): EngineIdentity {
  const expected = SHIPPED_KIT_RUNTIME_POLICY[shippedKitKey(kit)];
  if (expected === undefined) {
    throw new ValidationError(
      `No server-owned runtime compatibility policy exists for kit '${kit.id}@${kit.version}'.`,
      {
        code: COMPATIBILITY_POLICY_UNAVAILABLE_CODE,
        field: "model_id",
        context: {
          kit_id: kit.id,
          kit_version: kit.version,
        },
        recovery:
          "Use a currently shipped qualified kit identity. Unknown or future kits are not implicitly qualified.",
      },
    );
  }
  return { ...expected };
}

/** Default registry admission: every shipped kit has a policy, and no extra identities are qualified. */
export function assertShippedKitRuntimePolicies(
  kits: readonly Pick<ModelicaKit, "id" | "version">[],
): void {
  const remaining = new Set(Object.keys(SHIPPED_KIT_RUNTIME_POLICY));
  for (const kit of kits) {
    runtimeCompatibilityPolicy(kit);
    remaining.delete(shippedKitKey(kit));
  }
  if (remaining.size > 0) {
    throw new ValidationError(
      `Server-owned runtime compatibility policy qualifies unregistered kit identities: ${
        [...remaining].sort().join(", ")
      }.`,
      {
        code: COMPATIBILITY_POLICY_UNAVAILABLE_CODE,
        field: "model_id",
        recovery:
          "Keep the shipped kit map exact. Do not invent qualification for identities that are not loaded.",
      },
    );
  }
}

export function assertRuntimeCompatible(
  kit: Pick<ModelicaKit, "id" | "version">,
  engine: EngineIdentity,
): void {
  const expected = runtimeCompatibilityPolicy(kit);
  if (
    engine.name === expected.name &&
    engine.version === expected.version &&
    engine.msl_version === expected.msl_version
  ) {
    return;
  }
  throw new ValidationError(
    `Native OpenModelica/MSL runtime is incompatible with qualified kit '${kit.id}@${kit.version}'.`,
    {
      code: RUNTIME_INCOMPATIBLE_CODE,
      field: "engine",
      context: {
        kit_id: kit.id,
        kit_version: kit.version,
        engine_name: engine.name,
        engine_version: engine.version,
        engine_msl_version: engine.msl_version,
        expected_engine_name: expected.name,
        expected_engine_version: expected.version,
        expected_msl_version: expected.msl_version,
      },
      recovery:
        "Run this provider with the qualified OpenModelica 1.27.0 and Modelica Standard Library 4.1.0 runtime from the published container (docs/provider-and-runtime.md, Dockerfile). Native host drift is not accepted. Retry the same operation after the runtime matches.",
    },
  );
}
