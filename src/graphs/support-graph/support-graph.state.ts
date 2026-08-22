import { createGraphStateAnnotation } from "ezgraph";
import type { NodeStateValue } from "ezgraph";
import type {
  Adjudication,
  RefundQuote,
  ReturnReason,
} from "./backend/policy-engine.js";
import { TriageNode } from "./nodes/triage.node.js";

/** The verified order snapshot every specialist stage works from. */
export type VerifiedOrder = {
  orderId: string;
  customerName: string;
  email: string;
  placedAt: string;
  deliveredAt: string | null;
  shippingStatus: string;
  carrier: string;
  tracking: string;
  paymentMethod: string;
  lineItems: {
    lineId: string;
    name: string;
    category: string;
    quantity: number;
    unitPrice: number;
    opened: boolean;
    finalSale: boolean;
    returnable: boolean;
  }[];
};

export type ReturnRequest = {
  orderId: string;
  lineIds: string[];
  reason: ReturnReason;
  note?: string;
};

/** An action the customer must explicitly confirm before it is committed. */
export type PendingRefund = {
  request: ReturnRequest;
  quote: RefundQuote;
  reasons: string[];
};

/** A committed, irreversible outcome recorded on the case. */
export type RefundRecord = {
  rma: string;
  orderId: string;
  lineIds: string[];
  netRefund: number;
  refundTarget: string;
  authority: "agent" | "customer_confirmed";
};

export type BillingDispute = {
  orderId: string;
  chargeIds: string[];
  description: string;
  amountInDispute: number;
};

export type EscalationTicket = {
  ticketId: string;
  category:
    | "duplicate_charge"
    | "wrong_amount"
    | "missing_refund"
    | "payment_method"
    | "other";
  summary: string;
  customerImpact: "low" | "medium" | "high";
  requestedRemedy: string;
  amountInDispute: number;
  openedAt: string;
};

export type SupportGraphNodes = {
  /** The hub owns the case record: identity, routing, and committed outcomes. */
  TriageNode?: NodeStateValue<{
    order?: VerifiedOrder;
    verifyAttempts?: number;
    refunds?: RefundRecord[];
    tickets?: EscalationTicket[];
  }>;
  ReturnsNode?: NodeStateValue<{
    returnedLineIds?: string[];
    lastDenial?: string[];
  }>;
  BillingNode?: NodeStateValue<{ dispute?: BillingDispute }>;
  /** `pending` is cleared with the `undefined` deletion marker once decided. */
  ApprovalNode?: NodeStateValue<{
    pending?: PendingRefund | undefined;
    decidedAt?: string;
  }>;
  AdjudicateNode?: NodeStateValue<{
    request?: ReturnRequest;
    decision?: Adjudication["decision"];
    adjudication?: Adjudication;
  }>;
  EscalateNode?: NodeStateValue<{
    dispute?: BillingDispute;
    ticket?: EscalationTicket;
  }>;
};

export const SupportGraphState = createGraphStateAnnotation(
  TriageNode.name,
  () => ({} as SupportGraphNodes),
);

export type SupportGraphStateType = typeof SupportGraphState.State;
