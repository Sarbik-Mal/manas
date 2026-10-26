import { applyDiscountLegacy } from "../discounts";
import { format } from "../money";

// Monthly sales report, still using the old discount rule.
export function monthlyReport(sales: number[], percent: number) {
	const net = sales.map((s) => applyDiscountLegacy(s, percent));
	return net.map(format).join("\n");
}
