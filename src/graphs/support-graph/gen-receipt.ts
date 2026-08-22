import type { RefundQuote } from "./backend/policy-engine.js";

/** Renders the deterministic refund math the model is not allowed to restate. */
export class GenReceipt {
  static formatCurrency(
    amount: number,
    locale = "en-US",
    currency = "USD",
  ): string {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      amount,
    );
  }

  static quoteTable(quote: RefundQuote): string {
    const rows = [
      "| Line | Amount |",
      "| --- | --- |",
      ...quote.lines.map(
        (line) =>
          `| ${line.name} x${line.quantity} | ${GenReceipt.formatCurrency(line.amount)} |`,
      ),
      `| Items subtotal | ${GenReceipt.formatCurrency(quote.itemsSubtotal)} |`,
    ];
    if (quote.restockingFee > 0) {
      rows.push(
        `| Restocking fee | -${GenReceipt.formatCurrency(quote.restockingFee)} |`,
      );
    }
    if (quote.shippingRefund > 0) {
      rows.push(
        `| Shipping refunded | ${GenReceipt.formatCurrency(quote.shippingRefund)} |`,
      );
    }
    rows.push(
      `| **Net refund to ${quote.refundTarget}** | **${GenReceipt.formatCurrency(quote.netRefund)}** |`,
    );
    return rows.join("\n");
  }
}
