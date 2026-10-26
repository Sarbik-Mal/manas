import { Cart } from "./cart";
import { lookup } from "./discounts";
import { cents, format } from "./money";

// npm start -- add <sku> <price> | checkout <code>
const cart = new Cart();
const [command, ...args] = process.argv.slice(2);

if (command === "add") {
	cart.add(args[0], cents(Number(args[1] ?? 1)));
	console.log(`added ${args[0]}`);
} else if (command === "checkout") {
	console.log(format(cart.total(lookup(args[0] ?? ""))));
} else {
	console.log("usage: add <sku> <price> | checkout <code>");
}
