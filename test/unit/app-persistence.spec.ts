import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Container, CosmosClient, Databases } from "@azure/cosmos";
import type { ConfigService } from "@nestjs/config";
import { MongoClient, type Db } from "mongodb";
import { GraphEngine } from "@picoflow/ezgraph";
import { AppModule } from "../../src/app.module.js";

type PersistenceProvider = {
  provide: unknown;
  useFactory: (config: ConfigService) => Promise<GraphEngine>;
};
const providers = Reflect.getMetadata("providers", AppModule) as PersistenceProvider[];
const provider = providers.find((entry) => entry.provide === GraphEngine)!;
function config(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(key + " is required.");
      return value;
    },
  } as ConfigService;
}

describe("inline application persistence", () => {
  it("validates connection URLs explicitly in the application callbacks", async () => {
    await assert.rejects(provider.useFactory(config({
      SESSION_STORE: "mongodb", MONGODB_NAME: "test", MONGODB_COLLECTION: "sessions",
    })), /MONGODB_URL/);
    await assert.rejects(provider.useFactory(config({ SESSION_STORE: "cosmos" })), /COSMODB_URL/);
  });
  it("registers injectable persistence without running unused database factories", async () => {
    assert(provider);
    const engine = await provider.useFactory(config({ SESSION_STORE: "memory" }));
    await engine.close();
  });

  it("closes its Mongo client on shutdown and failed initialization", async () => {
    let closes = 0;
    let failIndex = false;
    const indexCalls: unknown[] = [];
    const connect = mock.method(MongoClient.prototype, "connect", async function(this: MongoClient) { return this; });
    const database = mock.method(MongoClient.prototype, "db", () => ({
      collection: () => ({
        createIndex: async (...args: unknown[]) => {
          indexCalls.push(args);
          if (failIndex) throw new Error("index failed");
          return "id_1";
        },
      }),
    }) as unknown as Db);
    const close = mock.method(MongoClient.prototype, "close", async () => { closes += 1; });
    try {
      const settings = config({
        SESSION_STORE: "mongodb", MONGODB_URL: "mongodb://localhost:27017",
        MONGODB_NAME: "test", MONGODB_COLLECTION: "sessions",
      });
      await (await provider.useFactory(settings)).close();
      assert.deepEqual(indexCalls[0], [{ id: 1 }, { unique: true }]);
      assert.equal(closes, 1);
      failIndex = true;
      await assert.rejects(provider.useFactory(settings), /index failed/);
      assert.equal(closes, 2);
    } finally {
      connect.mock.restore();
      database.mock.restore();
      close.mock.restore();
    }
  });

  it("accepts Cosmos key, service-principal, and default authentication inline", async () => {
    let closes = 0;
    const originalDispose = CosmosClient.prototype.dispose;
    const dispose = mock.method(CosmosClient.prototype, "dispose", function(this: CosmosClient) {
      closes += 1;
      originalDispose.call(this);
    });
    const provision = mock.method(Databases.prototype, "createIfNotExists", async () => {
      throw new Error("provisioning must be disabled");
    });
    const read = mock.method(Container.prototype, "read", async () => ({
      resource: { partitionKey: { paths: ["/id"] } },
    }));
    try {
      const common = {
        SESSION_STORE: "cosmos", COSMO_ENDPOINT: "https://example.documents.azure.com",
        COSMOS_CREATE_IF_NOT_EXISTS: "false",
      };
      for (const credentials of [
        { COSMODB_KEY: "test-key" },
        {
          AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
          COSMO_DB_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
          COSMO_DB_CLIENT_SECRET: "test-secret",
        },
        {},
      ]) {
        await (await provider.useFactory(config({ ...common, ...credentials }))).close();
      }
      assert.equal(closes, 3);
      assert.equal(provision.mock.callCount(), 0);
      await assert.rejects(provider.useFactory(config({
        ...common, COSMO_DB_CLIENT_ID: "incomplete",
      })), /service principal requires/);
    } finally {
      dispose.mock.restore();
      provision.mock.restore();
      read.mock.restore();
    }
  });
});
