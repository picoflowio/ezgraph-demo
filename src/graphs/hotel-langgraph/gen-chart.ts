type ChartRow = Record<string, string | number>;

export class GenChart {
  static getChart(hotels: ChartRow[]): string {
    if (hotels.length === 0) return "";
    const keys = Object.keys(hotels[0] ?? {});
    const rows = [
      `| Features | ${hotels.map((_, index) => `Hotel ${index + 1}`).join(" | ")} |`,
      `| --- | ${hotels.map(() => "---").join(" | ")} |`,
      ...keys.map(
        (key) =>
          `| ${key} | ${hotels.map((hotel) => String(hotel[key] ?? "")).join(" | ")} |`,
      ),
    ];
    return rows.join("\n");
  }

  static formatCurrency(
    amount: number,
    locale = "en-US",
    currency = "USD",
  ): string {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      amount,
    );
  }

  static comparisonRows(
    hotels: Array<Record<string, string | number | boolean>>,
  ): ChartRow[] {
    const keys = new Set(hotels.flatMap((hotel) => Object.keys(hotel)));
    return hotels.map((hotel) =>
      Object.fromEntries(
        [...keys].map((key) => {
          const value = hotel[key];
          return [
            key,
            value === undefined
              ? "❌"
              : value === true
                ? "✅"
                : value === false
                  ? "❌"
                  : value,
          ];
        }),
      ) as ChartRow,
    );
  }

  static roomTypes(roomTypes: string[]): Record<string, boolean> {
    return Object.fromEntries(roomTypes.map((roomType) => [roomType, true]));
  }
}
