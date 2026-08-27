import { readFileSync } from "node:fs";
import { ModelCatalog } from "@picoflow/ezgraph";
import { AppModelProviders } from "./app-model-providers.js";

/** Application model extensions, validated once when the application starts. */
export const AppModelCatalog = ModelCatalog.create(
  {
    $schema: "../../node_modules/@picoflow/ezgraph/model-catalog.schema.json",
    version: 1,
    profiles: {
      "glm.chat": {
        provider: "glm",
        family: "chat",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["retries"],
          properties: {
            retries: { type: "integer", minimum: 0 },
            temperature: { type: "number" },
            maxOutputTokens: { type: "integer", minimum: 1 },
            forceToolCalls: { type: "boolean" },
          },
        },
        parameterMappings: {
          retries: "maxRetries",
          temperature: "temperature",
          maxOutputTokens: "maxTokens",
          forceToolCalls: null,
        },
      },
    },
    models: {
      "glm:glm-5.1": {
        profile: "glm.chat",
      },
    },
  },
  {
    providers: AppModelProviders,
  },
);
