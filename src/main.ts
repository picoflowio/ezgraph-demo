import "dotenv/config";
import "reflect-metadata";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Agent, setGlobalDispatcher } from "undici";
import { AppModule } from "./app.module.js";

// Long LLM calls can exceed fetch's 300s default.
const llmHttpTimeoutMs = Number(process.env.LLM_HTTP_TIMEOUT_MS ?? 1_200_000);
setGlobalDispatcher(
  new Agent({
    headersTimeout: llmHttpTimeoutMs,
    bodyTimeout: llmHttpTimeoutMs,
  }),
);

export async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableCors({
    origin: "*",
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: "Content-Type, Accept, Authorization, SESSION_ID",
    exposedHeaders: "SESSION_ID",
  });

  const swagger = new DocumentBuilder()
    .setTitle("EZGraph demo")
    .setDescription("NestJS consumer application for ezgraph")
    .setVersion("0.1.0")
    .build();
  SwaggerModule.setup("api", app, SwaggerModule.createDocument(app, swagger));

  const port = Number(process.env.PORT ?? 8000);
  await app.listen(port, "0.0.0.0");
  return app;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  void bootstrap();
}
