/** Pure identity-bound evidence URIs; MCP resource publication is an adapter. */
const KIT_SOURCE_URI_PREFIX = "casys://modelica/kits/";

export function kitSourceUri(modelId: string, version: string): string {
  return `${KIT_SOURCE_URI_PREFIX}${encodeURIComponent(modelId)}/${
    encodeURIComponent(version)
  }/model.mo`;
}

export function kitParameterSchemaUri(modelId: string, version: string): string {
  return `${KIT_SOURCE_URI_PREFIX}${encodeURIComponent(modelId)}/${
    encodeURIComponent(version)
  }/parameter-schema.json`;
}

export function kitScenarioUri(modelId: string, version: string, scenarioId: string): string {
  return `${KIT_SOURCE_URI_PREFIX}${encodeURIComponent(modelId)}/${
    encodeURIComponent(version)
  }/scenarios/${encodeURIComponent(scenarioId)}.json`;
}

export function requestArtifactUri(requestId: string, suffix = "request.json"): string {
  return `casys://modelica/requests/${encodeURIComponent(requestId)}/${suffix}`;
}
