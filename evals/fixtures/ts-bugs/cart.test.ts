import { expect, test } from "bun:test";
import { itemCount, subtotal } from "./src/cart";

const lines = [
	{ sku: "apple", price: 200, qty: 3 },
	{ sku: "pear", price: 50, qty: 1 },
];

test("subtotal counts quantities", () => {
	expect(subtotal(lines)).toBe(650);
});

test("item count", () => {
	expect(itemCount(lines)).toBe(4);
});
