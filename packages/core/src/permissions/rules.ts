import { parseRule, type Rules, toolKey } from "../config/settings";

// A bare deny (`"Read"`) covers the whole tool. Scoped rules, ask and allow
// are evaluated by the permission engine (1.7).
export function deniedBy(name: string, rules: Rules) {
	return rules.deny.find((rule) => {
		const r = parseRule(rule);
		return r && !r.specifier && toolKey(r.tool) === toolKey(name);
	});
}
