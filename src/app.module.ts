import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { GraphEngine, ModelProvider } from "ezgraph";
import { AiController } from "./controllers/ai-controller.js";
import { AiLanggraphController } from "./controllers/ai-langgraph-controller.js";
import { HealthController } from "./controllers/health-controller.js";
import { DemoGraph } from "./graphs/demo-graph/demo-graph.js";
import { ExpenseGraph } from "./graphs/expense-graph/expense-graph.js";
import { HotelGraph } from "./graphs/hotel-graph/hotel-graph.js";
import { InvoiceGraph } from "./graphs/invoice-graph/invoice-graph.js";
import { QuoteGraph } from "./graphs/quote-graph/quote-graph.js";
import { SupportGraph } from "./graphs/support-graph/support-graph.js";
import { HotelLanggraph } from "./graphs/hotel-langgraph/hotel-langgraph.js";
import { QuoteLanggraph } from "./graphs/quote-langgraph/quote-langgraph.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AiController, AiLanggraphController, HealthController],
  providers: [
    {
      provide: GraphEngine,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        GraphEngine.create({
          graphs: [
            DemoGraph,
            ExpenseGraph,
            HotelGraph,
            InvoiceGraph,
            QuoteGraph,
            SupportGraph,
          ],
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
      provide: HotelLanggraph,
      useFactory: () => HotelLanggraph.createFromEnvironment(),
    },
    {
      provide: QuoteLanggraph,
      useFactory: () => QuoteLanggraph.createFromEnvironment(),
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(GraphEngine) private readonly graphEngine: GraphEngine,
    @Inject(HotelLanggraph) private readonly hotelLanggraph: HotelLanggraph,
    @Inject(QuoteLanggraph) private readonly quoteLanggraph: QuoteLanggraph,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.graphEngine.close(),
      this.hotelLanggraph.close(),
      this.quoteLanggraph.close(),
    ]);
  }
}
