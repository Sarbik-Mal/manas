import type { Cents } from "./money";

export type Discount =
	| { kind: "percent"; value: number }
	| { kind: "fixed"; value: Cents };

const CODES: Record<string, Discount> = {
	SAVE10: { kind: "percent", value: 10 },
	FIVEOFF: { kind: "fixed", value: 500 },
};

export const lookup = (code: string) => CODES[code.toUpperCase()];

// The current rule: never below zero.
export function applyDiscount(total: Cents, discount?: Discount): Cents {
	if (!discount) return total;
	const off =
		discount.kind === "percent"
			? Math.round((total * discount.value) / 100)
			: discount.value;
	return Math.max(0, total - off);
}

// Kept for old reports only: percent discounts, no floor.
export function applyDiscountLegacy(total: Cents, percent: number): Cents {
	return total - (total * percent) / 100;
}
