import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import {
  ApiEndResponseDto,
  ApiRunBodyDto,
  ApiRunResponseDto,
} from "./api-types.js";
import { QuoteLanggraph } from "../graphs/quote-langgraph/quote-langgraph.js";

const SESSION_ID = "SESSION_ID";

type PureLanggraph = QuoteLanggraph;

/** HTTP boundary for the direct-LangGraph comparison graphs only. */
@ApiTags("ai-langgraph")
@Controller("ai-langgraph")
export class AiLanggraphController {
  private readonly graphs: readonly PureLanggraph[];

  constructor(@Inject(QuoteLanggraph) quoteLanggraph: QuoteLanggraph) {
    this.graphs = [quoteLanggraph];
  }

  @Post("run")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: SESSION_ID, required: false })
  @ApiBody({ type: ApiRunBodyDto })
  @ApiResponse({ status: 200, type: ApiRunResponseDto })
  @ApiResponse({ status: 400, type: ApiRunResponseDto })
  async run(
    @Res() reply: FastifyReply,
    @Body() body: ApiRunBodyDto,
    @Headers(SESSION_ID) sessionId?: string,
  ) {
    const graph = this.graphs.find(
      (candidate) => candidate.name === body?.graphName,
    );
    if (!graph) {
      return reply.status(HttpStatus.BAD_REQUEST).send({
        success: false,
        completed: false,
        message: `GraphClass '${body?.graphName ?? ""}' not registered.`,
      });
    }
    const result = await graph.run({
      ...(body?.message !== undefined ? { userMessage: body.message } : {}),
      ...(body?.config !== undefined ? { config: body.config } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (result.session) reply.header(SESSION_ID, result.session);
    return reply.status(result.status).send(result.body);
  }

  @Get("graphs")
  @ApiResponse({
    status: 200,
    schema: { type: "array", items: { type: "string" } },
  })
  getGraphs() {
    return this.graphs.map((graph) => graph.name);
  }

  @Post("end")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: SESSION_ID, required: true })
  @ApiResponse({ status: 200, type: ApiEndResponseDto })
  @ApiResponse({ status: 400, type: ApiEndResponseDto })
  async deleteSession(
    @Res() reply: FastifyReply,
    @Headers(SESSION_ID) sessionId?: string,
  ) {
    // Sessions are keyed by id alone, so the owning graph is resolved by
    // lookup before deleting.
    const owner = sessionId
      ? await this.findSessionOwner(sessionId)
      : undefined;
    const result = await (owner ?? this.graphs[0]!).deleteSession(sessionId);
    return reply.status(result.status).send(result.body);
  }

  private async findSessionOwner(
    sessionId: string,
  ): Promise<PureLanggraph | undefined> {
    for (const graph of this.graphs) {
      try {
        if (await graph.hasSession(sessionId)) return graph;
      } catch {
        // An invalid id or foreign session document is reported by
        // deleteSession, which produces the response for this request.
        return undefined;
      }
    }
    return undefined;
  }
}
