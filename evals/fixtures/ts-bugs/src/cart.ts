// Prices are in cents.
export type Line = { sku: string; price: number; qty: number };

export function subtotal(lines: Line[]): number {
	return lines.reduce((sum, l) => sum + l.price, 0);
}

export function itemCount(lines: Line[]): number {
	return lines.reduce((n, l) => n + l.qty, 0);
}
