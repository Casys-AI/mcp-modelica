/** Load both shipped kits from a caller-supplied module base URL and print identities. */
const baseUrl = Deno.args[0];
if (baseUrl === undefined || baseUrl.trim().length === 0) {
  console.error("usage: load_published_kits.ts <module-base-url>");
  Deno.exit(2);
}

const { loadCoffeeMachineKit } = await import(
  new URL("/src/kits/coffee-machine.ts", `${baseUrl}/`).href
);
const { loadLinearThermalRampKit } = await import(
  new URL("/src/kits/linear-thermal-ramp.ts", `${baseUrl}/`).href
);
const { sha256 } = await import(new URL("/src/domain/hashing.ts", `${baseUrl}/`).href);

const coffee = await loadCoffeeMachineKit();
const ramp = await loadLinearThermalRampKit();
const scenario = coffee.scenarios[0];
const rampScenario = ramp.scenarios[0];
if (scenario.source === undefined || coffee.parameterSchemaSource === undefined) {
  throw new Error("CoffeeMachine kit is missing server-owned scenario or schema bytes.");
}
if (rampScenario.source === undefined) {
  throw new Error("LinearThermalRamp kit is missing server-owned scenario bytes.");
}

console.log(JSON.stringify({
  coffee: {
    id: coffee.id,
    modelSourceUrl: coffee.modelSourceUrl?.href,
    scenarioSourceUrl: scenario.sourceUrl?.href,
    parameterSchemaSourceUrl: coffee.parameterSchemaSourceUrl?.href,
    model: await sha256(coffee.modelSource),
    scenario: await sha256(scenario.source),
    schema: await sha256(coffee.parameterSchemaSource),
    modelBytes: new TextEncoder().encode(coffee.modelSource).byteLength,
  },
  ramp: {
    id: ramp.id,
    modelSourceUrl: ramp.modelSourceUrl?.href,
    scenarioSourceUrl: rampScenario.sourceUrl?.href,
    model: await sha256(ramp.modelSource),
    scenario: await sha256(rampScenario.source),
    modelBytes: new TextEncoder().encode(ramp.modelSource).byteLength,
  },
}));
