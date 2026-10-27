import type { ParseResult } from "./powershell";

// Claude Code's PowerShell security checks (2.1.310), in its order, plus
// Manas's own never-auto-allowed cases (tools.md §2). A flagged command asks
// whatever a specific allow rule says; only a bare PowerShell rule lets it
// through, and it gets no "don't ask again" (a rule wouldn't stop it asking).

type Part = ParseResult["commands"][number];

export const unquote = (a: string) => a.replace(/^(['"])(.*)\1$/s, "$2");
export const SECRET = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];

// What a part runs: the cmdlet an alias resolves to, or the program's file
// name without its extension.
const id = (p: Part) =>
	(p.resolved ?? p.name ?? "")
		.toLowerCase()
		.split(/[\\/]/)
		.pop()
		?.replace(/\.(exe|cmd|bat)$/, "") ?? "";
const named =
	(...names: string[]) =>
	(p: Part) =>
		names.includes(id(p));
// `-e` / `-enc` / `/encodedcommand`: a prefix of `full`, at least `min` long.
const hasParam = (p: Part, full: string, min: string) =>
	p.args.some((a) => {
		const f = a
			.replace(/^[/–—―]/, "-")
			.toLowerCase()
			.split(":")[0];
		return f.startsWith(min) && full.startsWith(f);
	});
const positionalString = (p: Part) =>
	p.args.some((a, i) => p.kinds[i] === "StringConstant" && !a.startsWith("-"));

const POWERSHELL = ["pwsh", "powershell"];
const SCRIPT_RUNNERS = [
	"invoke-command",
	"start-job",
	"start-threadjob",
	"register-scheduledjob",
];
const SCHEDULED = [
	"register-scheduledtask",
	"new-scheduledtask",
	"new-scheduledtaskaction",
	"set-scheduledtask",
];
const DANGEROUS_BLOCKS = [
	...SCRIPT_RUNNERS,
	"invoke-expression",
	"register-engineevent",
	"register-objectevent",
	"register-wmievent",
	"new-pssession",
	"enter-pssession",
];
const FILTERS = [
	"where-object",
	"sort-object",
	"select-object",
	"group-object",
	"format-table",
	"format-list",
	"format-wide",
	"format-custom",
];
const MODULES = [
	"import-module",
	"ipmo",
	"install-module",
	"save-module",
	"update-module",
	"install-script",
	"save-script",
];
const ALIASES_VARIABLES = [
	"set-alias",
	"sal",
	"new-alias",
	"nal",
	"set-variable",
	"sv",
	"new-variable",
	"nv",
];
const WMI = ["invoke-wmimethod", "iwmi", "invoke-cimmethod", "icim"];
const LOCATION = [
	"set-location",
	"sl",
	"cd",
	"chdir",
	"push-location",
	"pushd",
	"pop-location",
	"popd",
	"new-psdrive",
	"ndr",
	"mount",
];
const PROVIDER =
	/^(?:[\w.]+\\)?(env|hklm|hkcu|function|alias|variable|cert|wsman|registry)::?/i;
const UNC = /(?<!:)[\\/]{2,}[^\s\\/]/;

// Claude Code's ConstrainedLanguage type allowlist.
const SAFE_TYPES = new Set(
	`alias allowemptycollection allowemptystring allownull argumentcompleter argumentcompletions array bigint bool byte char
	cimclass cimconverter ciminstance cimtype cmdletbinding cultureinfo datetime decimal double dsclocalconfigurationmanager
	dscproperty dscresource experimentaction experimental experimentalfeature float guid hashtable int int16 int32 int64
	ipaddress ipendpoint long mailaddress norunspaceaffinity nullstring objectsecurity ordered outputtype parameter
	physicaladdress pscredential pscustomobject psdefaultvalue pslistmodifier psobject psprimitivedictionary
	pstypenameattribute ref regex sbyte securestring semver short single string supportswildcards switch timespan uint
	uint16 uint32 uint64 ulong uri ushort validatecount validatedrive validatelength validatenotnull validatenotnullorempty
	validatenotnullorwhitespace validatepattern validaterange validatescript validateset validatetrusteddata
	validateuserdrive version void wildcardpattern x500distinguishedname x509certificate xml system.array system.boolean
	system.byte system.char system.datetime system.decimal system.double system.guid system.int16 system.int32
	system.int64 system.numerics.biginteger system.sbyte system.single system.string system.timespan system.uint16
	system.uint32 system.uint64 system.uri system.version system.void system.collections.hashtable
	system.text.regularexpressions.regex system.globalization.cultureinfo system.net.ipaddress system.net.ipendpoint
	system.net.mail.mailaddress system.net.networkinformation.physicaladdress system.security.securestring
	system.security.cryptography.x509certificates.x509certificate
	system.security.cryptography.x509certificates.x500distinguishedname system.xml.xmldocument
	system.management.automation.pscredential system.management.automation.pscustomobject
	system.management.automation.pslistmodifier system.management.automation.psobject
	system.management.automation.psprimitivedictionary system.management.automation.psreference
	system.management.automation.semanticversion system.management.automation.switchparameter
	system.management.automation.wildcardpattern system.management.automation.language.nullstring
	microsoft.management.infrastructure.cimclass microsoft.management.infrastructure.cimconverter
	microsoft.management.infrastructure.ciminstance microsoft.management.infrastructure.cimtype
	system.collections.specialized.ordereddictionary system.security.accesscontrol.objectsecurity object system.object
	microsoft.powershell.commands.modulespecification`.split(/\s+/),
);
const safeType = (t: string) =>
	SAFE_TYPES.has(
		t
			.toLowerCase()
			.replace(/\[\]$/, "")
			.replace(/\[.*\]$/, "")
			.trim(),
	);

// New-Object's type: -TypeName (any prefix from -t), else the first
// positional argument.
function newObjectType(p: Part) {
	for (let i = 0; i < p.args.length; i++) {
		const m = /^-(\w+)(?::(.*))?$/s.exec(p.args[i]);
		if (!m) return unquote(p.args[i]);
		const f = `-${m[1].toLowerCase()}`;
		if (f.startsWith("-t") && "-typename".startsWith(f))
			return unquote(m[2] ?? p.args[i + 1] ?? "");
		const takesValue = ["-argumentlist", "-comobject", "-property"].some(
			(x) => f.length >= 3 && x.startsWith(f),
		);
		if (takesValue && m[2] === undefined) i++;
	}
	return undefined;
}

const runAs = (p: Part) =>
	(hasParam(p, "-verb", "-v") &&
		p.args.some((a) => unquote(a).toLowerCase() === "runas")) ||
	p.args.some((a) => /^-v[a-z]*:['"]?runas['"]?$/i.test(a));

// ponytail: a cd to the folder it's already in still counts (Claude Code
// skips such no-ops); resolve the target if `cd .; git ...` asks too often.
export const changesLocation = (p: ParseResult) =>
	p.commands.some(named(...LOCATION));

// Why this command must ask whatever specific allow rules say, or undefined.
export function flagged(p: ParseResult): string | undefined {
	const parts = p.commands;
	const any = (f: (c: Part) => boolean) => parts.some(f);
	if (p.errors.length > 0)
		return "Could not parse command for security analysis";
	if (any(named("invoke-expression", "iex")))
		return "Command uses Invoke-Expression which can execute arbitrary code";
	if (any((c) => c.name === null))
		return "Command name is a dynamic expression which cannot be statically validated";
	const shell = named(...POWERSHELL);
	if (any((c) => shell(c) && hasParam(c, "-encodedcommand", "-e")))
		return "Command uses encoded parameters which obscure intent";
	if (any(shell))
		return "Command spawns a nested PowerShell process which cannot be validated";
	// (Claude's download-and-run check needs iex, which already asked.)
	if (
		any(named("start-bitstransfer")) ||
		any(
			(c) =>
				id(c) === "bitsadmin" && c.args.some((a) => /^\/transfer$/i.test(a)),
		)
	)
		return "Command downloads files via BITS transfer";
	if (
		any(
			(c) =>
				id(c) === "certutil" && c.args.some((a) => /^[-/]urlcache$/i.test(a)),
		)
	)
		return "Command uses certutil to download from a URL";
	if (any(named("add-type"))) return "Command compiles and loads .NET code";
	for (const c of parts.filter(named("new-object"))) {
		if (hasParam(c, "-comobject", "-com"))
			return "Command instantiates a COM object which may have execution capabilities";
		const type = newObjectType(c);
		if (type !== undefined && !safeType(type))
			return `New-Object instantiates .NET type '${type}' outside the ConstrainedLanguage allowlist`;
	}
	for (const c of parts.filter(named(...SCRIPT_RUNNERS))) {
		if (hasParam(c, "-filepath", "-f") || hasParam(c, "-literalpath", "-l"))
			return `${c.name} -FilePath executes an arbitrary script file`;
		if (positionalString(c))
			return `${c.name} with positional string argument binds to -FilePath and executes a script file`;
	}
	if (any(named("invoke-item", "ii")))
		return "Invoke-Item opens files with the default handler (ShellExecute). On executable files this runs arbitrary code.";
	for (const c of parts) {
		if (SCHEDULED.includes(id(c)))
			return `${c.name} creates or modifies a scheduled task (persistence primitive)`;
		if (
			id(c) === "schtasks" &&
			c.args.some((a) => /^[-/](create|change)$/i.test(a))
		)
			return "schtasks with create/change modifies scheduled tasks (persistence primitive)";
	}
	for (const c of parts.filter(named("foreach-object"))) {
		if (hasParam(c, "-membername", "-m"))
			return "ForEach-Object -MemberName invokes methods by string name which cannot be validated";
		if (positionalString(c))
			return "ForEach-Object with positional string argument binds to -MemberName and invokes methods by name";
	}
	for (const c of parts.filter(named("start-process", "saps", "start"))) {
		if (runAs(c)) return "Command requests elevated privileges";
		const exe = (a: string) =>
			unquote(a)
				.toLowerCase()
				.split(/[\\/]/)
				.pop()
				?.replace(/\.exe$/, "") ?? "";
		if (c.args.some((a) => POWERSHELL.includes(exe(a))))
			return "Start-Process launches a nested PowerShell process which cannot be validated";
	}
	// Claude's rule as it is: a script block is fine only among filters and
	// formatters, since its code can run anything.
	if (any((c) => c.kinds.includes("ScriptBlock"))) {
		if (any(named(...DANGEROUS_BLOCKS)))
			return "Command contains script block with dangerous cmdlet that may execute arbitrary code";
		if (!parts.every(named(...FILTERS)))
			return "Command contains script block that may execute arbitrary code";
	}
	if (p.subexpressions) return "Command contains subexpressions $()";
	if (p.expandable)
		return "Command contains expandable strings with embedded expressions";
	if (p.splatting) return "Command uses splatting (@variable)";
	if (p.stopParsing) return "Command uses stop-parsing token (--%)";
	if (p.invocations.length > 0) return "Command invokes .NET methods";
	const type = p.types.find((t) => !safeType(t));
	if (type !== undefined)
		return `Command uses .NET type [${type}] outside the ConstrainedLanguage allowlist`;
	// Manas: any write through a drive or scope, not just $env:.
	const scoped = p.scopedAssignments[0];
	if (scoped !== undefined)
		return /^\$\{?env:/i.test(scoped)
			? "Command modifies environment variables"
			: `Command assigns to ${scoped}, which can write a file or change the session`;
	if (any(named(...MODULES)))
		return "Command loads, installs, or downloads a PowerShell module or script, which can execute arbitrary code";
	if (any(named(...ALIASES_VARIABLES)))
		return "Command creates or modifies an alias or variable that can affect future command resolution";
	for (const c of parts) {
		if (WMI.includes(id(c)))
			return `${c.name} can spawn arbitrary processes via WMI/CIM (Win32_Process Create)`;
		if (id(c) === "wmic")
			return "wmic can spawn arbitrary processes (process call create), execute scripts (/format, /translate XSL), or write arbitrary files (/output, /append, /record) via WMI";
	}
	// Claude's checks outside that list.
	for (const c of parts) {
		for (const a of c.args) {
			const value = unquote(a).replace(/^-\w+:/, "");
			if (PROVIDER.test(value))
				return `Command argument '${a}' uses a non-filesystem provider path and requires approval`;
			if (UNC.test(value))
				return `Command argument '${a}' contains a UNC path that could trigger network requests`;
		}
	}
	if (p.usings)
		return "Command contains a `using` statement that may load external code (module or assembly)";
	if (p.requires)
		return "Command contains a `#Requires` directive that may trigger module loading";
	if (p.background)
		return "Command uses the background job operator (`&`) which spawns a child PowerShell process";
	if (parts.length > 1 && changesLocation(p) && any(named("git")))
		return "Compound commands with cd/Set-Location and git require approval to prevent bare repository attacks";
	if (p.redirections.length > 0)
		return "Command contains file redirections that could write to arbitrary paths";
	// Manas: secrets and saved credentials never reach the model unasked.
	if (any(named("cmdkey"))) return "cmdkey can list saved Windows credentials";
	for (const c of parts) {
		for (const a of c.args) {
			const name = unquote(a).split(/[\\/]/).pop() ?? "";
			if (SECRET.some((s) => s.test(name)))
				return `Command names a secret file (${a})`;
		}
	}
	return undefined;
}
