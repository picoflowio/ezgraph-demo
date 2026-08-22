import {
  OrderBook,
  type LineItemCategory,
  type Order,
  type OrderLineItem,
} from "./order-book.js";

export type ReturnReason =
  | "damaged"
  | "wrong_item"
  | "too_small"
  | "too_large"
  | "not_as_described"
  | "no_longer_needed";

export const RETURN_REASONS: readonly ReturnReason[] = [
  "damaged",
  "wrong_item",
  "too_small",
  "too_large",
  "not_as_described",
  "no_longer_needed",
];

export type RefundLine = {
  lineId: string;
  name: string;
  quantity: number;
  amount: number;
};

export type RefundQuote = {
  lines: RefundLine[];
  itemsSubtotal: number;
  restockingFee: number;
  shippingRefund: number;
  netRefund: number;
  refundTarget: string;
};

/** Decision produced by the deterministic adjudicator, never by the model. */
export type AdjudicationDecision = "auto" | "review" | "deny";

export type Adjudication = {
  decision: AdjudicationDecision;
  reasons: string[];
  quote?: RefundQuote;
};

/** Days a delivered item may be returned, by merchandise category. */
const RETURN_WINDOW_DAYS: Readonly<Record<LineItemCategory, number>> = {
  apparel: 60,
  footwear: 60,
  gear: 45,
  electronics: 30,
};

/** Opened electronics carry a restocking fee, which forces an approval gate. */
const RESTOCKING_FEE_RATE = 0.15;

/** Net refund at or below this amount is inside the agent's own authority. */
const AUTO_APPROVAL_LIMIT = 250;

/** Outbound shipping is only refunded when the merchant was at fault. */
const SHIPPING_REFUND_REASONS: readonly ReturnReason[] = [
  "damaged",
  "wrong_item",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The entire refund policy for this demo. Every eligibility rule and every
 * amount is computed here so the model can request an outcome but never
 * decide one.
 */
export class PolicyEngine {
  static get autoApprovalLimit(): number {
    return AUTO_APPROVAL_LIMIT;
  }

  static returnWindowDays(category: LineItemCategory): number {
    return RETURN_WINDOW_DAYS[category];
  }

  /** The date this graph treats as "today", frozen by env for repeatable tests. */
  static today(): Date {
    const override = process.env.SUPPORT_GRAPH_CURRENT_DATE?.trim();
    return override ? new Date(override) : new Date();
  }

  static daysSinceDelivery(order: Order, today = PolicyEngine.today()): number {
    if (!order.deliveredAt) return -1;
    const delivered = Date.parse(`${order.deliveredAt}T00:00:00.000Z`);
    if (!Number.isFinite(delivered)) return -1;
    return Math.floor((today.getTime() - delivered) / DAY_MS);
  }

  /**
   * Adjudicates a return request against the order and the policy.
   *
   * `deny` blocks the request outright, `auto` is inside agent authority, and
   * `review` requires the customer to confirm the exact deducted amount before
   * anything is committed.
   */
  static adjudicate(
    order: Order,
    lineIds: readonly string[],
    reason: ReturnReason,
    alreadyReturned: readonly string[] = [],
    today = PolicyEngine.today(),
  ): Adjudication {
    const items = OrderBook.lineItems(order, lineIds);
    if (items.length === 0 || items.length !== lineIds.length) {
      return {
        decision: "deny",
        reasons: ["One or more line items are not part of this order."],
      };
    }

    const denials = PolicyEngine.denialReasons(
      order,
      items,
      alreadyReturned,
      today,
    );
    if (denials.length > 0) return { decision: "deny", reasons: denials };

    const quote = PolicyEngine.quote(order, items, reason);
    const reasons: string[] = [];
    if (quote.restockingFee > 0) {
      reasons.push(
        `Opened electronics carry a ${Math.round(RESTOCKING_FEE_RATE * 100)}% restocking fee of ${quote.restockingFee.toFixed(2)}.`,
      );
    }
    if (quote.netRefund > AUTO_APPROVAL_LIMIT) {
      reasons.push(
        `The net refund of ${quote.netRefund.toFixed(2)} exceeds the ${AUTO_APPROVAL_LIMIT} agent approval limit.`,
      );
    }
    if (reasons.length > 0) return { decision: "review", reasons, quote };
    return {
      decision: "auto",
      reasons: ["Inside the standard return window and agent approval limit."],
      quote,
    };
  }

  static quote(
    order: Order,
    items: readonly OrderLineItem[],
    reason: ReturnReason,
  ): RefundQuote {
    const lines = items.map((item) => ({
      lineId: item.lineId,
      name: item.name,
      quantity: item.quantity,
      amount: round(item.unitPrice * item.quantity),
    }));
    const itemsSubtotal = round(
      lines.reduce((total, line) => total + line.amount, 0),
    );
    const restockingFee = round(
      items.reduce(
        (total, item) =>
          item.category === "electronics" && item.opened
            ? total + item.unitPrice * item.quantity * RESTOCKING_FEE_RATE
            : total,
        0,
      ),
    );
    const shippingRefund = SHIPPING_REFUND_REASONS.includes(reason)
      ? round(order.shipping.paid)
      : 0;
    return {
      lines,
      itemsSubtotal,
      restockingFee,
      shippingRefund,
      netRefund: round(itemsSubtotal - restockingFee + shippingRefund),
      refundTarget: `${order.paymentMethod.brand} ending ${order.paymentMethod.last4}`,
    };
  }

  private static denialReasons(
    order: Order,
    items: readonly OrderLineItem[],
    alreadyReturned: readonly string[],
    today: Date,
  ): string[] {
    const reasons: string[] = [];
    if (order.shipping.status !== "delivered") {
      reasons.push(
        `Order ${order.orderId} has not been delivered yet, so it cannot be returned.`,
      );
      return reasons;
    }

    const returned = new Set(alreadyReturned.map((id) => id.toUpperCase()));
    const age = PolicyEngine.daysSinceDelivery(order, today);
    for (const item of items) {
      if (item.finalSale) {
        reasons.push(`${item.name} was a final-sale item and is not returnable.`);
      }
      if (item.returned || returned.has(item.lineId.toUpperCase())) {
        reasons.push(`${item.name} has already been returned on this order.`);
      }
      const window = RETURN_WINDOW_DAYS[item.category];
      if (age > window) {
        reasons.push(
          `${item.name} is ${age} days past delivery, beyond the ${window}-day ${item.category} return window.`,
        );
      }
    }
    return reasons;
  }
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}
