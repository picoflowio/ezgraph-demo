import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  GraphLlm,
  modelExecution,
  type GraphLlmConfig,
  type LlmGateway,
  type LlmGatewayTool,
  type LlmGatewayToolCall,
  type ModelResult,
  type SessionDocument,
} from "ezgraph";
import { SupportGraph } from "../../src/graphs/support-graph/support-graph.js";
import type { SupportGraphStateType } from "../../src/graphs/support-graph/support-graph.state.js";

process.env.SUPPORT_GRAPH_CURRENT_DATE ??= "2027-07-15T00:00:00.000Z";

type ReturnPlan = {
  match: RegExp;
  lineIds: string[];
  reason: string;
};

describe("SupportGraph", () => {
  it("holds a refund above agent authority until the customer confirms it", async () => {
    const graph = new SupportGraph(
      new SupportScriptedGateway({
        returns: [{ match: /too (big|large)/i, lineIds: ["L1"], reason: "too_large" }],
      }),
    );

    let state = await invoke(graph, undefined, "I need help with an order");
    assert.equal(state.currentNode, "TriageNode");
    assert.equal(state.nodes.TriageNode?.order, undefined);

    state = await invoke(
      graph,
      state,
      "Order NW-100412, the email is dana.whitfield@example.com",
    );
    assert.equal(state.currentNode, "TriageNode");
    assert.equal(state.nodes.TriageNode?.order?.orderId, "NW-100412");

    state = await invoke(graph, state, "I want to return the rain jacket");
    assert.equal(state.currentNode, "ReturnsNode");

    state = await invoke(graph, state, "it is too big");
    // $289 exceeds the $250 agent approval limit, so the graph must stop at
    // the confirmation gate instead of committing the refund.
    assert.equal(state.nodes.AdjudicateNode?.decision, "review");
    assert.equal(state.currentNode, "ApprovalNode");
    assert.equal(state.nodes.ApprovalNode?.pending?.quote.netRefund, 289);
    assert.equal(state.nodes.TriageNode?.refunds, undefined);
    assert.equal(state.completed, false);

    state = await invoke(graph, state, "yes, go ahead");
    assert.equal(state.currentNode, "TriageNode");
    assert.equal(state.nodes.ApprovalNode?.pending, undefined);
    const refunds = state.nodes.TriageNode?.refunds ?? [];
    assert.equal(refunds.length, 1);
    assert.match(refunds[0]?.rma ?? "", /^RMA-\d{6}$/);
    assert.equal(refunds[0]?.netRefund, 289);
    assert.equal(refunds[0]?.authority, "customer_confirmed");
    assert.equal(refunds[0]?.refundTarget, "Visa ending 4021");
    assert.deepEqual(state.nodes.ReturnsNode?.returnedLineIds, ["L1"]);

    state = await invoke(graph, state, "that's everything, thanks");
    assert.equal(state.completed, true);
    assert.equal(state.currentNode, "end");
    assert.match(state.response, /RMA-\d{6}/);
    assert.match(state.response, /\$289\.00/);
  });

  it("commits a refund inside agent authority without a confirmation gate", async () => {
    const graph = new SupportGraph(
      new SupportScriptedGateway({
        returns: [
          {
            match: /base layer/i,
            lineIds: ["L2"],
            reason: "no_longer_needed",
          },
        ],
      }),
    );

    let state = await invoke(graph, undefined, "Order NW-100412, ZIP 97214");
    assert.equal(state.nodes.TriageNode?.order?.orderId, "NW-100412");

    state = await invoke(graph, state, "I want to return something");
    assert.equal(state.currentNode, "ReturnsNode");

    state = await invoke(graph, state, "the base layers, I no longer need them");
    // 2 x $68 is inside the limit and carries no deduction, so the refund is
    // committed in the same turn and the hub reports it.
    assert.equal(state.nodes.AdjudicateNode?.decision, "auto");
    assert.equal(state.currentNode, "TriageNode");
    const refunds = state.nodes.TriageNode?.refunds ?? [];
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0]?.netRefund, 136);
    assert.equal(refunds[0]?.authority, "agent");
    assert.deepEqual(state.nodes.ReturnsNode?.returnedLineIds, ["L2"]);
  });

  it("denies an out-of-window return and routes back with the policy reasons", async () => {
    const graph = new SupportGraph(
      new SupportScriptedGateway({
        returns: [{ match: /parka/i, lineIds: ["L1"], reason: "no_longer_needed" }],
      }),
    );

    let state = await invoke(
      graph,
      undefined,
      "Order NW-100236, priya.raghunathan@example.com",
    );
    assert.equal(state.nodes.TriageNode?.order?.orderId, "NW-100236");

    state = await invoke(graph, state, "I want to return an item");
    assert.equal(state.currentNode, "ReturnsNode");

    state = await invoke(graph, state, "the parka");
    assert.equal(state.nodes.AdjudicateNode?.decision, "deny");
    assert.equal(state.currentNode, "ReturnsNode");
    assert.equal(state.nodes.TriageNode?.refunds, undefined);
    const denial = state.nodes.ReturnsNode?.lastDenial ?? [];
    assert.equal(denial.length, 1);
    assert.match(denial[0] ?? "", /60-day apparel return window/);
  });

  it("opens a schema-validated escalation ticket for a duplicate charge", async () => {
    const graph = new SupportGraph(new SupportScriptedGateway({ returns: [] }));

    let state = await invoke(
      graph,
      undefined,
      "Order NW-100517, marcus.oyelaran@example.com",
    );
    assert.equal(state.nodes.TriageNode?.order?.orderId, "NW-100517");

    state = await invoke(graph, state, "I was charged twice for this order");
    assert.equal(state.currentNode, "TriageNode");
    const tickets = state.nodes.TriageNode?.tickets ?? [];
    assert.equal(tickets.length, 1);
    assert.match(tickets[0]?.ticketId ?? "", /^ESC-\d{5}$/);
    assert.equal(tickets[0]?.category, "duplicate_charge");
    // The ledger owns the amount, not the model's draft.
    assert.equal(tickets[0]?.amountInDispute, 858);
    assert.deepEqual(state.nodes.BillingNode?.dispute?.chargeIds, [
      "CH-88422",
      "CH-88423",
    ]);

    state = await invoke(graph, state, "that's all for now");
    assert.equal(state.completed, true);
    assert.equal(state.currentNode, "end");
    assert.match(state.response, /ESC-\d{5}/);
  });
});

describe("SupportGraph session policy", () => {
  it("keeps a fresh approval gate exactly where it was left", async () => {
    const graph = new SupportGraph(new SupportScriptedGateway({ returns: [] }));
    const restored = await graph.restoreSessionDoc(
      heldApprovalSession(60_000),
    );

    assert.ok(restored);
    assert.equal(restored.graph.currentNode, "ApprovalNode");
    assert.equal(restored.graph.nodes?.ApprovalNode?.pending?.quote.netRefund, 289);
  });

  it("releases an approval gate held past its hold window", async () => {
    const graph = new SupportGraph(new SupportScriptedGateway({ returns: [] }));
    const restored = await graph.restoreSessionDoc(
      heldApprovalSession(15 * 60_000),
    );

    assert.ok(restored);
    // The irreversible action is dropped, not committed, and the customer
    // resumes at the hub instead of mid-approval.
    assert.equal(restored.graph.currentNode, "TriageNode");
    assert.equal(restored.graph.nodes?.ApprovalNode?.pending, undefined);
    assert.deepEqual(restored.graph.histories["support-approval"], []);
    assert.equal(restored.graph.nodes?.TriageNode?.order?.orderId, "NW-100412");
  });

  it("drops a session idle past the support working window", async () => {
    const graph = new SupportGraph(new SupportScriptedGateway({ returns: [] }));
    const restored = await graph.restoreSessionDoc(
      heldApprovalSession(45 * 60_000),
    );

    assert.equal(restored, null);
  });
});

function heldApprovalSession(
  idleMs: number,
): SessionDocument<SupportGraphStateType> {
  const modifiedAt = new Date(Date.now() - idleMs).toISOString();
  return {
    version: 14,
    id: "support-policy-session",
    status: "in_progress",
    tokens: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      tool_input_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
    },
    errors: [],
    warnings: [],
    expireAfter: 60 * 60_000,
    createdAt: modifiedAt,
    modifiedAt,
    graph: {
      id: "SupportGraph",
      schemaVersion: 1,
      currentNode: "ApprovalNode",
      config: {},
      histories: { "support-approval": [], "support-triage": [] },
      nodes: {
        TriageNode: {
          order: {
            orderId: "NW-100412",
            customerName: "Dana Whitfield",
            email: "dana.whitfield@example.com",
            placedAt: "2027-06-28",
            deliveredAt: "2027-07-03",
            shippingStatus: "delivered",
            carrier: "UPS",
            tracking: "1Z999AA10123456784",
            paymentMethod: "Visa ending 4021",
            lineItems: [],
          },
        },
        ApprovalNode: {
          pending: {
            request: {
              orderId: "NW-100412",
              lineIds: ["L1"],
              reason: "too_large",
            },
            quote: {
              lines: [
                {
                  lineId: "L1",
                  name: "Timberline 3L Rain Jacket",
                  quantity: 1,
                  amount: 289,
                },
              ],
              itemsSubtotal: 289,
              restockingFee: 0,
              shippingRefund: 0,
              netRefund: 289,
              refundTarget: "Visa ending 4021",
            },
            reasons: ["The net refund of 289.00 exceeds the 250 agent approval limit."],
          },
        },
      },
      model: GraphLlm.modelMetadata(SupportGraph.getGraphDefinition().llmConfig),
    },
  };
}

async function invoke(
  graph: SupportGraph,
  state: SupportGraphStateType | undefined,
  input: string,
): Promise<SupportGraphStateType> {
  return graph.graph.invoke({
    ...graph.prepareInput(state, new HumanMessage(input)),
    inputConsumed: false,
    response: "",
  });
}

class SupportScriptedGateway implements LlmGateway {
  constructor(private readonly plan: { returns: ReturnPlan[] }) {}

  async structured<T extends Record<string, unknown>>(
    _schema: unknown,
    _systemPrompt: string,
    _input: string,
    _name: string,
    config?: GraphLlmConfig,
  ): Promise<ModelResult<T>> {
    return result(
      {
        category: "duplicate_charge",
        summary:
          "Order NW-100517 posted CH-88422 and CH-88423 for 429.00 on consecutive days.",
        customerImpact: "high",
        requestedRemedy: "Reverse charge CH-88423 to the Mastercard ending 7788.",
        // Deliberately wrong: the graph must overwrite this from the ledger.
        amountInDispute: 429,
      } as unknown as T,
      config ?? SupportGraph.getGraphDefinition().llmConfig,
    );
  }

  async generate(): Promise<ModelResult<string>> {
    throw new Error("Support test does not use simple generation.");
  }

  async respond(): Promise<ModelResult<string>> {
    throw new Error("Support test does not use response generation.");
  }

  async toolCall(): Promise<ModelResult<LlmGatewayToolCall | undefined>> {
    throw new Error("Support test does not use standalone tool calls.");
  }

  async agent(
    _systemPrompt: string,
    history: readonly BaseMessage[],
    tools: readonly LlmGatewayTool[],
    config?: GraphLlmConfig,
  ): Promise<ModelResult<AIMessage>> {
    const active = config ?? SupportGraph.getGraphDefinition().llmConfig;
    const input = latestHumanText(history);
    const names = new Set(tools.map(({ name }) => name));

    if (names.has("verify_order")) return this.triage(history, input, active);
    if (names.has("request_return")) return this.returns(input, active);
    if (names.has("confirm_refund")) return this.approval(input, active);
    if (names.has("open_dispute")) return this.billing(input, active);
    throw new Error(`Unexpected support stage for input '${input}'.`);
  }

  private triage(
    history: readonly BaseMessage[],
    input: string,
    config: GraphLlmConfig,
  ): ModelResult<AIMessage> {
    const orderId = /NW-\d{6}/i.exec(input)?.[0];
    if (orderId && !hasToolMessage(history, "verify_order")) {
      const secret =
        /[\w.+-]+@[\w-]+\.[\w.]+/.exec(input)?.[0] ??
        /\b\d{5}\b/.exec(input)?.[0] ??
        "";
      return result(
        toolCall("verify", "verify_order", { orderId, secret }),
        config,
      );
    }
    if (/\breturn\b|send (it|them|this) back|too (big|large|small)/i.test(input)) {
      return result(
        toolCall("route", "route_request", { department: "returns" }),
        config,
      );
    }
    if (
      /charged twice|duplicate charge|wrong amount|do not recognize|refund never/i.test(
        input,
      )
    ) {
      return result(
        toolCall("route", "route_request", { department: "billing" }),
        config,
      );
    }
    if (/that'?s (everything|all)|all set|nothing else/i.test(input)) {
      return result(
        toolCall("close", "close_case", {
          summary: "Closing the case with the outcomes recorded below.",
        }),
        config,
      );
    }
    return result(
      new AIMessage("Happy to help. Can you give me your order number?"),
      config,
    );
  }

  private returns(input: string, config: GraphLlmConfig): ModelResult<AIMessage> {
    if (/^(done|nothing else|no thanks)/i.test(input)) {
      return result(
        toolCall("end-returns", "end_return_request", { done: true }),
        config,
      );
    }
    const plan = this.plan.returns.find((entry) => entry.match.test(input));
    if (plan) {
      return result(
        toolCall("submit", "request_return", {
          lineIds: plan.lineIds,
          reason: plan.reason,
        }),
        config,
      );
    }
    return result(
      new AIMessage("Which item would you like to send back, and what went wrong?"),
      config,
    );
  }

  private approval(input: string, config: GraphLlmConfig): ModelResult<AIMessage> {
    if (/^(yes|confirm|go ahead|do it|approve)/i.test(input)) {
      return result(
        toolCall("confirm", "confirm_refund", { confirmed: true }),
        config,
      );
    }
    if (/^(no|cancel|not yet|hold off)/i.test(input)) {
      return result(
        toolCall("decline", "decline_refund", { declined: true }),
        config,
      );
    }
    return result(
      new AIMessage("Here is the refund breakdown. Shall I go ahead?"),
      config,
    );
  }

  private billing(input: string, config: GraphLlmConfig): ModelResult<AIMessage> {
    if (/^(done|nothing else)/i.test(input)) {
      return result(
        toolCall("end-billing", "end_billing_request", { done: true }),
        config,
      );
    }
    if (/charged twice|duplicate|both charges/i.test(input)) {
      return result(
        toolCall("dispute", "open_dispute", {
          chargeIds: ["CH-88422", "CH-88423"],
          description: "The customer reports the same amount posted twice.",
          amountInDispute: 429,
        }),
        config,
      );
    }
    return result(new AIMessage("Which charge looks wrong?"), config);
  }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name, args, type: "tool_call" }],
  });
}

function result<T>(value: T, config: GraphLlmConfig): ModelResult<T> {
  return {
    value,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      tool_input_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
    },
    execution: modelExecution(config),
  };
}

function latestHumanText(history: readonly BaseMessage[]): string {
  const message = [...history]
    .reverse()
    .find((candidate) => HumanMessage.isInstance(candidate));
  return message && typeof message.content === "string" ? message.content : "";
}

function hasToolMessage(
  history: readonly BaseMessage[],
  name: string,
): boolean {
  return history.some(
    (message) => ToolMessage.isInstance(message) && message.name === name,
  );
}
