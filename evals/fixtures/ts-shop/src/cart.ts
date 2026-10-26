import { applyDiscount, type Discount } from "./discounts";
import type { Cents } from "./money";

export type Line = { sku: string; price: Cents; qty: number };

export class Cart {
	lines: Line[] = [];

	add(sku: string, price: Cents, qty = 1) {
		const line = this.lines.find((l) => l.sku === sku);
		if (line) line.qty += qty;
		else this.lines.push({ sku, price, qty });
	}

	subtotal(): Cents {
		return this.lines.reduce((sum, l) => sum + l.price * l.qty, 0);
	}

	total(discount?: Discount): Cents {
		return applyDiscount(this.subtotal(), discount);
	}
}
