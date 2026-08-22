import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  Inject,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import {
  ApiEndResponseDto,
  ApiRunBodyDto,
  ApiRunResponseDto,
} from "./api-types.js";
import { GraphEngine } from "ezgraph";

const SESSION_ID = "SESSION_ID";

@ApiTags("ai")
@Controller("ai")
export class AiController {
  constructor(@Inject(GraphEngine) private readonly graphEngine: GraphEngine) {}

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
    const result = await this.graphEngine.run({
      graphName: body?.graphName,
      ...(body?.message !== undefined ? { userMessage: body.message } : {}),
      ...(body?.config !== undefined ? { config: body.config } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (result.session) reply.header(SESSION_ID, result.session);
    if (result.contentType) reply.type(result.contentType);
    return reply.status(result.status).send(result.body);
  }

  @Get("graphs")
  @ApiResponse({
    status: 200,
    schema: { type: "array", items: { type: "string" } },
  })
  getGraphs() {
    return this.graphEngine.getGraphs();
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
    const result = await this.graphEngine.deleteSession(sessionId);
    return reply.status(result.status).send(result.body);
  }
}
