# EZGraph Model Catalog

## Status

Implemented on 2026-08-06.

## Decision

EZGraph uses a hybrid model catalog:

- built-in model IDs and parameters are checked by TypeScript and again at
  runtime;
- application-added model IDs and parameters are declared in JSON and checked
  at application startup and configuration construction;
- arbitrary unvalidated model objects are not accepted.

The two paths have different constructors so a `string` escape hatch cannot
silently disable checking for known model names.

```ts
const builtIn = ModelCatalog.model("openai:gpt-5.4", {
  retries: 3,
  reasoningEffort: "medium",
});

const catalog = ModelCatalog.create(modelCatalogJson);
const addedLater = catalog.model("openai:future-reasoning-model", {
  retries: 3,
  reasoningEffort: "medium",
});
```

Both values implement `GraphLlmConfig`. They have the same public data shape—
`model` and `params`—but contain an internal brand proving which validation path
created them.

## Built-in contract

`ModelCatalog.model(model, params)` is generic over the built-in catalog. TypeScript
selects the parameter type from the literal model ID. For example, a reasoning
model accepts `reasoningEffort` but rejects `temperature`; a Google chat model
accepts `temperature`, `thinkingBudget`, and Google safety settings.

EZGraph validates the resulting value against the built-in runtime profile as
well. This protects JavaScript callers, deserialized input, and unsafe casts.

Adding a statically known model requires an EZGraph release because TypeScript
types cannot be changed by JSON loaded at runtime. Applications that require
compile-time checking for their own checked-in catalog can add a future codegen
step; runtime catalogs deliberately do not pretend to provide that guarantee.

## Runtime catalog JSON

The authoritative JSON Schema is distributed as
`ezgraph/model-catalog.schema.json`. A complete example lives at
[`config/model-catalog.example.json`](../config/model-catalog.example.json).
The running demo's smaller catalog is
[`src/config/model-catalog.json`](../src/config/model-catalog.json); it declares
the application-registered `glm` provider and `glm:glm-5.1` model used by
`FavoritesNode`.

## Application-registered providers

JSON can describe provider parameters, but it cannot contain executable model
construction or credentials. A provider absent from EZGraph and LangChain must
therefore be registered in application code and supplied to catalog creation:

```ts
const providers = ModelProviderRegistry.create().register("glm", {
  initialize({ model, options }) {
    return {
      model,
      options: {
        modelProvider: "openai",
        ...options,
        apiKey: requiredEnv("GLM_API_KEY"),
        configuration: { baseURL: "https://api.z.ai/api/paas/v4" },
      },
      cacheKey: JSON.stringify({ provider: "glm", model, options }),
    };
  },
});

const catalog = ModelCatalog.create(modelCatalogJson, { providers });
```

Catalog startup rejects a custom profile whose provider has no registered
adapter. Built-in providers cannot be replaced. Provider adapters return a
secret-free cache key so credentials do not enter cache identifiers; catalog
parameters remain the only values persisted as model metadata.

```json
{
  "$schema": "ezgraph/model-catalog.schema.json",
  "version": 1,
  "profiles": {
    "openai.future-reasoning": {
      "provider": "openai",
      "family": "reasoning",
      "paramsSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["retries"],
        "properties": {
          "retries": { "type": "integer", "minimum": 0 },
          "reasoningEffort": {
            "enum": ["minimal", "low", "medium", "high"]
          },
          "forceToolCalls": { "type": "boolean" }
        }
      },
      "parameterMappings": {
        "retries": "maxRetries",
        "reasoningEffort": "reasoningEffort",
        "forceToolCalls": null
      }
    }
  },
  "models": {
    "openai:future-reasoning-model": {
      "profile": "openai.future-reasoning"
    }
  }
}
```

Each document contains:

- `version`: catalog format version, currently `1`;
- `profiles`: reusable provider/family parameter contracts;
- `paramsSchema`: JSON Schema for the complete `params` object;
- `parameterMappings`: dot-separated LangChain initialization paths, or
  `null` for EZGraph-only policy such as `forceToolCalls`;
- `models`: provider-prefixed public model IDs referencing profiles;
- `providerModel`: optional provider-native ID when the public ID is a stable
  deployment alias.

Catalog construction rejects malformed JSON Schema, unknown profiles, mappings
for undeclared parameters, provider-prefix mismatches, and attempts to replace
built-in entries. `catalog.model()` rejects unknown model IDs and invalid
parameters before a provider is initialized.

JSON validation cannot establish that a provider actually supports a declared
parameter. A factually incorrect extension can therefore still fail when
LangChain or the provider initializes or invokes the model. Broad capabilities
such as tool calling and structured output remain checked against LangChain's
public model profile.

## Overrides

A graph owns one complete configuration:

```ts
llmConfig: ModelCatalog.model("google:gemini-3.1-flash-lite", {
  retries: 3,
  temperature: 0.2,
})
```

A node either supplies another complete model value or patches only parameters:

```ts
return ModelCatalog.model("google:gemini-3.5-flash", {
  retries: 3,
  temperature: 0.2,
});

return { params: { temperature: 0.5 } };
return { params: { temperature: null } }; // remove inherited value
```

Changing a model is full replacement. This removes the earlier possibility of
combining a new provider/family/model with parameters inherited from an
incompatible model.

## Resulting ownership

The catalog now owns model identity, provider, compatibility family, parameter
schema, and LangChain parameter mappings. The graph/node API owns model
selection and override policy. LangChain owns provider construction and public
runtime capability profiles. Session persistence continues to record only the
provider-prefixed model ID, resolved family, and safe validated parameters.
