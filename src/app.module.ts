import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CosmosClient } from "@azure/cosmos";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { MongoClient } from "mongodb";
import {
  DecisionProvider,
  GraphEngine,
  ModelProvider,
} from "@picoflow/ezgraph";
import { AiController } from "./controllers/ai-controller.js";
import { AiLanggraphController } from "./controllers/ai-langgraph-controller.js";
import { HealthController } from "./controllers/health-controller.js";
import { ExpenseGraph } from "./graphs/expense-graph/expense-graph.js";
import { DecisionHotelGraph } from "./graphs/decision-hotel-graph/decision-hotel-graph.js";
import { QuoteGraph } from "./graphs/quote-graph/quote-graph.js";
import { QuoteLanggraph, type LazyQuoteLanggraph } from "./graphs/quote-langgraph/quote-langgraph.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AiController, AiLanggraphController, HealthController],
  providers: [
    {
      provide: GraphEngine,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        GraphEngine.create({
          configManager: config,
          sessionClients: {
            // Customize MongoDB / DocumentDB credentials, TLS, and connection options here.
            mongodb: () => {
              const url = config.getOrThrow<string>("MONGODB_URL");
              const tlsCAFile = config.get<string>("MONGODB_TLS_CA_FILE");
              return new MongoClient(url, tlsCAFile ? { tlsCAFile } : {});
            },
            cosmos: () => {
              const endpoint = config.get<string>("COSMO_ENDPOINT")
                || config.get<string>("COSMOS_ENDPOINT") || config.get<string>("COSMODB_URL");
              if (!endpoint) throw new Error("COSMODB_URL, COSMO_ENDPOINT, or COSMOS_ENDPOINT is required.");
              const key = config.get<string>("COSMODB_KEY") || config.get<string>("COSMOS_KEY");
              if (key) return new CosmosClient({ endpoint, key });
              const tenantId = config.get<string>("AZURE_TENANT_ID");
              const clientId = config.get<string>("COSMO_DB_CLIENT_ID");
              const clientSecret = config.get<string>("COSMO_DB_CLIENT_SECRET");
              if (clientId || clientSecret) {
                if (!tenantId || !clientId || !clientSecret) {
                  throw new Error("Cosmos service principal requires AZURE_TENANT_ID, COSMO_DB_CLIENT_ID, and COSMO_DB_CLIENT_SECRET.");
                }
                return new CosmosClient({
                  endpoint,
                  aadCredentials: new ClientSecretCredential(tenantId, clientId, clientSecret),
                });
              }
              return new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
            },
          },
          graphs: [DecisionHotelGraph, ExpenseGraph, QuoteGraph],
          decisionProviders: DecisionProvider.create({
            typesafe: { apiKey: config.get<string>("TYPESAFE_API_KEY") },
          }),
          // Register built-in providers explicitly; only specify what the app uses.
          providers: [
            ...ModelProvider.createBuiltinAdapters({
              openai: { apiKey: config.get<string>("OPENAI_API_KEY") },
              google: { apiKey: config.get<string>("GEMINI_API_KEY") },
              anthropic: {
                apiKey: config.get<string>("ANTHROPIC_API_KEY"),
              },
              // moonshot: { apiKey: config.get<string>("MOONSHOT_API_KEY") },
              // zai: { apiKey: config.get<string>("ZAI_API_KEY") },
              // deepseek: { apiKey: config.get<string>("DEEPSEEK_API_KEY") },
              // openrouter: { apiKey: config.get<string>("OPENROUTER_API_KEY") },
              // ollama: { baseUrl: config.get<string>("OLLAMA_BASE_URL") },
            }),
            // NVIDIA uses an OpenAI-compatible endpoint, but remains an
            // application-owned integration rather than an EZGraph built-in.
            ModelProvider.createCustomAdapter({
              provider: "nvidia",
              runtimeProvider: "openai",
              config: {
                apiKey: config.get<string>("NVIDIA_API_KEY"),
                configuration: {
                  baseURL: "https://integrate.api.nvidia.com/v1",
                },
              },
            }),
          ],
        }),
    },
    {
      provide: QuoteLanggraph,
      useFactory: () => QuoteLanggraph.createLazyFromEnvironment(),
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(GraphEngine) private readonly graphEngine: GraphEngine,
    @Inject(QuoteLanggraph) private readonly quoteLanggraph: QuoteLanggraph | LazyQuoteLanggraph,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.graphEngine.close(),
      this.quoteLanggraph.close(),
    ]);
  }
}
