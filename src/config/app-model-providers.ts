import { ModelProviderRegistry } from "@picoflow/ezgraph";

const DEFAULT_GLM_BASE_URL = "https://api.z.ai/api/paas/v4";

/** Application-owned adapters for providers not built into LangChain/EZGraph. */
export const AppModelProviders = ModelProviderRegistry.create().register("glm", {
  initialize({ model, options }) {
    const apiKey = process.env.GLM_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "GLM_API_KEY is required to initialize the GLM provider.",
      );
    }
    const baseURL = process.env.GLM_BASE_URL?.trim() || DEFAULT_GLM_BASE_URL;
    return {
      model,
      options: {
        modelProvider: "openai",
        ...options,
        apiKey,
        configuration: { baseURL },
      },
      // Credentials are deliberately excluded from the in-memory model cache key.
      cacheKey: JSON.stringify({ provider: "glm", model, baseURL, options }),
    };
  },
});
