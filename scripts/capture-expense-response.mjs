// One-off: runs ExpenseGraph live and saves the extracted JSON to
// test/expense-graph/captured-response.json for reference.
//   node --import tsx scripts/capture-expense-response.mjs
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module.js";

const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
  logger: false,
});
await app.listen(0, "127.0.0.1");
const { port } = app.getHttpServer().address();

const response = await fetch(`http://127.0.0.1:${port}/ai/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    graphName: "ExpenseGraph",
    config: { fileName: "data/GrandSequoia.pdf" },
  }),
});
const body = await response.json();
if (response.status !== 200) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}
writeFileSync(
  new URL("../test/expense-graph/captured-response.json", import.meta.url),
  `${JSON.stringify(body, null, 4)}\n`,
);
console.log(JSON.stringify(body, null, 2));
await app.close();
