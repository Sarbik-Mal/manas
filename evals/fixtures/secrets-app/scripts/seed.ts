import { connect } from "./db";

// Seeds the local database.
const db = await connect("localhost", "{{DB_PASSWORD}}");
await db.insert("products", [{ sku: "apple", price: 120 }]);
