export type ModelicaToolCategory = "catalog" | "simulation";

export type ModelicaToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ModelicaTool {
  name: string;
  description: string;
  category: ModelicaToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: {
    ui: {
      resourceUri: string;
    };
  };
  handler: ModelicaToolHandler;
}
