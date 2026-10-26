import { Cart } from "../cart";
import { applyDiscount, lookup } from "../discounts";
import { placeOrder } from "../orders";

// POST /checkout { items: [{ sku, price, qty }], code? }
export function checkout(body: {
	items: { sku: string; price: number; qty: number }[];
	code?: string;
}) {
	const cart = new Cart();
	for (const i of body.items) cart.add(i.sku, i.price, i.qty);
	const discount = body.code ? lookup(body.code) : undefined;
	const preview = applyDiscount(cart.subtotal(), discount);
	return { preview, order: placeOrder(cart, discount) };
}
