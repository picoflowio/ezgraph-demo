import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { langChainModelInitialization } from "ezgraph";
import { AppModelCatalog } from "../../src/config/app-model-catalog.js";

describe("application model catalog", () => {
  it("resolves an application-registered provider", () => {
    const previousApiKey = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = "test-glm-key";
    const config = AppModelCatalog.model("glm:glm-5.1", {
      retries: 3,
      temperature: 0.2,
    });

    try {
      assert.equal(config.model, "glm:glm-5.1");
      assert.deepEqual(langChainModelInitialization(config), {
        model: "glm-5.1",
        options: {
          modelProvider: "openai",
          maxRetries: 3,
          temperature: 0.2,
          apiKey: "test-glm-key",
          configuration: { baseURL: "https://api.z.ai/api/paas/v4" },
        },
        cacheKey:
          '{"provider":"glm","model":"glm-5.1","baseURL":"https://api.z.ai/api/paas/v4","options":{"maxRetries":3,"temperature":0.2}}',
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = previousApiKey;
    }
  });

  it("rejects invalid parameters before provider initialization", () => {
    assert.throws(
      () =>
        AppModelCatalog.model("glm:glm-5.1", {
          retries: 3,
          temperature: "hot",
        }),
      /expected number/i,
    );
  });

  it("requires provider credentials only when the provider is initialized", () => {
    const previousApiKey = process.env.GLM_API_KEY;
    delete process.env.GLM_API_KEY;
    try {
      const config = AppModelCatalog.model("glm:glm-5.1", { retries: 3 });
      assert.throws(
        () => langChainModelInitialization(config),
        /GLM_API_KEY is required/,
      );
    } finally {
      if (previousApiKey !== undefined) process.env.GLM_API_KEY = previousApiKey;
    }
  });
});
