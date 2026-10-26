// Amounts are kept in cents to avoid floating-point errors.
export type Cents = number;

export const cents = (amount: number): Cents => Math.round(amount * 100);

export const format = (value: Cents) => `$${(value / 100).toFixed(2)}`;
