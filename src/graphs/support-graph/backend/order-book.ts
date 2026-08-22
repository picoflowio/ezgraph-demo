import { readFileSync } from "node:fs";

export type LineItemCategory = "apparel" | "footwear" | "gear" | "electronics";

export type OrderLineItem = {
  lineId: string;
  sku: string;
  name: string;
  category: LineItemCategory;
  quantity: number;
  unitPrice: number;
  opened: boolean;
  finalSale: boolean;
  returned: boolean;
};

export type OrderCharge = {
  chargeId: string;
  postedAt: string;
  amount: number;
  descriptor: string;
};

export type Order = {
  orderId: string;
  email: string;
  postalCode: string;
  customerName: string;
  placedAt: string;
  deliveredAt: string | null;
  paymentMethod: { brand: string; last4: string };
  shipping: {
    carrier: string;
    tracking: string;
    status: "in_transit" | "delivered" | "returned";
    paid: number;
  };
  lineItems: OrderLineItem[];
  charges: OrderCharge[];
};

const orders = JSON.parse(
  readFileSync(new URL("../data/orders.json", import.meta.url), "utf8"),
) as Order[];

/**
 * Read-only order catalog for this self-contained demo graph.
 *
 * Nothing here mutates the fixture. Return activity produced during a
 * conversation lives in graph state, so every session sees the same data.
 */
export class OrderBook {
  /** Verifies an order against a caller-supplied email or postal code. */
  static verify(orderId: string, secret: string): Order | undefined {
    const order = OrderBook.find(orderId);
    if (!order) return undefined;
    const candidate = secret.trim().toLowerCase();
    return candidate === order.email.toLowerCase() ||
      candidate === order.postalCode.toLowerCase()
      ? order
      : undefined;
  }

  static find(orderId: string): Order | undefined {
    const id = orderId.trim().toUpperCase();
    return orders.find((order) => order.orderId.toUpperCase() === id);
  }

  static lineItems(order: Order, lineIds: readonly string[]): OrderLineItem[] {
    const byId = new Map(
      order.lineItems.map((item) => [item.lineId.toUpperCase(), item]),
    );
    return lineIds.flatMap((lineId) => {
      const item = byId.get(lineId.trim().toUpperCase());
      return item ? [item] : [];
    });
  }

  /** Charges that share an amount, which is the signal a dispute starts from. */
  static duplicateCharges(order: Order): OrderCharge[] {
    return order.charges.filter(
      (charge, _index, all) =>
        all.filter((other) => other.amount === charge.amount).length > 1,
    );
  }
}
