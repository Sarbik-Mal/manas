import type { Cart } from "./cart";
import { applyDiscount, type Discount } from "./discounts";
import type { Cents } from "./money";

export type Order = { id: number; total: Cents; shipping: Cents };

let nextId = 1;
const SHIPPING: Cents = 499;

export function placeOrder(cart: Cart, discount?: Discount): Order {
	// Shipping is discounted too.
	const total = applyDiscount(cart.subtotal() + SHIPPING, discount);
	return { id: nextId++, total, shipping: SHIPPING };
}
