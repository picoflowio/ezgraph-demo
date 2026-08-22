import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { OrderBook, type Order } from "../backend/order-book.js";
import { PolicyEngine } from "../backend/policy-engine.js";
import { GenReceipt } from "../gen-receipt.js";
import type {
  EscalationTicket,
  RefundRecord,
  SupportGraphStateType,
  VerifiedOrder,
} from "../support-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  supportPrompt,
} from "../prompt/support-prompt.js";
import { BillingNode } from "./billing.node.js";
import { ReturnsNode } from "./returns.node.js";

type Department = "returns" | "billing";
type TriageNodeState = {
  order?: VerifiedOrder;
  verifyAttempts?: number;
  refunds?: RefundRecord[];
  tickets?: EscalationTicket[];
};
type TriageContext = {
  order?: VerifiedOrder;
  verifyAttempts: number;
  department?: Department;
  closing?: string;
};
type VerifyOrderInput = { orderId: string; secret: string };
type RouteRequestInput = { department: Department };
type CloseCaseInput = { summary: string };

/**
 * The hub of the support graph.
 *
 * Triage owns customer identity and the case record, answers order and
 * shipping questions itself, and delegates everything else to a specialist
 * stage. Every specialist returns here, so this is the only node that can
 * complete the graph.
 */
export class TriageNode extends ConversationNode<
  SupportGraphStateType,
  TriageNodeState,
  TriageContext
> {
  getPrompt(state: SupportGraphStateType): string {
    const local = this.state(state);
    return `${supportPrompt.role}\n\n${fillPrompt(supportPrompt.triage, {
      TODAY: PolicyEngine.today().toISOString().slice(0, 10),
      ORDER: JSON.stringify(local.order ?? null),
      CASE: JSON.stringify({
        refunds: local.refunds ?? [],
        tickets: local.tickets ?? [],
      }),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<VerifyOrderInput>
    | ToolDefinition<RouteRequestInput>
    | ToolDefinition<CloseCaseInput>
  )[] {
    return [
      {
        name: "verify_order",
        description:
          "Verify an order number against the email address or shipping ZIP code on the order.",
        schema: z.object({
          orderId: z.string().min(1).describe("The customer's order number"),
          secret: z
            .string()
            .min(1)
            .describe("The email address or shipping ZIP code on the order"),
        }),
      },
      {
        name: "route_request",
        description:
          "Hand the verified order to the returns or billing specialist.",
        schema: z.object({ department: z.enum(["returns", "billing"]) }),
      },
      {
        name: "close_case",
        description:
          "Close the support case once every committed outcome has been reported.",
        schema: z.object({
          summary: z
            .string()
            .min(1)
            .describe("One paragraph naming every RMA number and ticket ID"),
        }),
      },
    ];
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return { params: { temperature: 0.3 } };
  }

  @Tool("verify_order")
  async verifyOrder(
    { orderId, secret }: VerifyOrderInput,
    _context: TriageContext,
  ): Promise<ConversationToolResult> {
    const order = OrderBook.verify(orderId, secret);
    if (!order) {
      return this.toolResult({
        accepted: false,
        error:
          "That order number and email or ZIP code do not match. Ask the customer to check both.",
      }).withContext((context) => ({
        verifyAttempts: context.verifyAttempts + 1,
      }));
    }
    const verified = summarizeOrder(order);
    return this.toolResult({ accepted: true, order: verified }).withContext({
      order: verified,
      verifyAttempts: 0,
    });
  }

  @Tool("route_request")
  async routeRequest(
    { department }: RouteRequestInput,
    context: TriageContext,
  ): Promise<ConversationToolResult> {
    if (!context.order) {
      return this.toolResult({
        accepted: false,
        error: "Verify the order before routing the request.",
      });
    }
    return this.toolResult({ accepted: true, department })
      .withContext({ department })
      .haltAfterBatch();
  }

  @Tool("close_case")
  async closeCase(
    { summary }: CloseCaseInput,
    _context: TriageContext,
    state: SupportGraphStateType,
  ): Promise<ConversationToolResult> {
    const local = this.state(state);
    if ((local.refunds ?? []).length + (local.tickets ?? []).length === 0) {
      return this.toolResult({
        accepted: false,
        error: "Nothing has been committed on this case yet.",
      });
    }
    return this.toolResult({ accepted: true })
      .withContext({ closing: summary })
      .haltAfterBatch();
  }

  protected createContext(state: SupportGraphStateType): TriageContext {
    const local = this.state(state);
    return {
      ...(local.order ? { order: local.order } : {}),
      verifyAttempts: local.verifyAttempts ?? 0,
    };
  }

  protected nextStep(
    state: SupportGraphStateType,
    context: TriageContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<SupportGraphStateType> {
    if (conversation.quitRequested) {
      return this.quit(conversation).withState(this.snapshot(context));
    }
    if (context.closing) {
      return this.finish(this.caseSummary(state, context.closing), conversation)
        .withState(this.snapshot(context));
    }
    if (context.department === "returns") {
      return this.advance(ReturnsNode, conversation)
        .withState(this.snapshot(context))
        .forwardInput(state, "Start a return request for this order.");
    }
    if (context.department === "billing") {
      return this.advance(BillingNode, conversation)
        .withState(this.snapshot(context))
        .forwardInput(state, "Start a billing dispute for this order.");
    }
    return this.stay(conversation).withState(this.snapshot(context));
  }

  /**
   * The closing message restates committed outcomes from persisted state
   * rather than from the model, so an RMA number can never drift.
   */
  private caseSummary(state: SupportGraphStateType, closing: string): string {
    const local = this.state(state);
    const lines = [closing.trim()];
    for (const refund of local.refunds ?? []) {
      lines.push(
        `- RMA ${refund.rma}: ${GenReceipt.formatCurrency(refund.netRefund)} refunded to ${refund.refundTarget}.`,
      );
    }
    for (const ticket of local.tickets ?? []) {
      lines.push(
        `- Ticket ${ticket.ticketId} (${ticket.category}) is with the billing team.`,
      );
    }
    lines.push("Thank you for shopping with Northwind Outfitters.");
    return lines.join("\n");
  }

  private snapshot(context: TriageContext): Partial<TriageNodeState> {
    return {
      ...(context.order ? { order: context.order } : {}),
      verifyAttempts: context.verifyAttempts,
    };
  }
}

/** Projects the private order record onto the fields the graph may expose. */
function summarizeOrder(order: Order): VerifiedOrder {
  return {
    orderId: order.orderId,
    customerName: order.customerName,
    email: order.email,
    placedAt: order.placedAt,
    deliveredAt: order.deliveredAt,
    shippingStatus: order.shipping.status,
    carrier: order.shipping.carrier,
    tracking: order.shipping.tracking,
    paymentMethod: `${order.paymentMethod.brand} ending ${order.paymentMethod.last4}`,
    lineItems: order.lineItems.map((item) => ({
      lineId: item.lineId,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      opened: item.opened,
      finalSale: item.finalSale,
      returnable: !item.finalSale && !item.returned,
    })),
  };
}
