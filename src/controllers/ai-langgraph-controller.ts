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
import { HotelLanggraph } from "../graphs/hotel-langgraph/hotel-langgraph.js";

const SESSION_ID = "SESSION_ID";

/** HTTP boundary for the direct-LangGraph comparison graph only. */
@ApiTags("ai-langgraph")
@Controller("ai-langgraph")
export class AiLanggraphController {
  constructor(
    @Inject(HotelLanggraph)
    private readonly hotelLanggraph: HotelLanggraph,
  ) {}

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
    if (body?.graphName !== this.hotelLanggraph.name) {
      return reply.status(HttpStatus.BAD_REQUEST).send({
        success: false,
        completed: false,
        message: `GraphClass '${body?.graphName ?? ""}' not registered.`,
      });
    }
    const result = await this.hotelLanggraph.run({
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
    return [this.hotelLanggraph.name];
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
    const result = await this.hotelLanggraph.deleteSession(sessionId);
    return reply.status(result.status).send(result.body);
  }
}
