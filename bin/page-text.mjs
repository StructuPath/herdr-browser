// --- Page snapshots ---------------------------------------------------------

const INTERACTIVE_ROLES = new Set([
	"button", "link", "textbox", "checkbox", "combobox", "radio",
	"menuitem", "option", "tab", "switch", "slider", "spinbutton", "searchbox",
]);

function axValue(value) {
	if (value && typeof value === "object" && "value" in value) return String(value.value ?? "");
	return String(value ?? "");
}

/** Format a CDP accessibility tree as indented, referenceable text. */
export function formatAxNodes(nodes) {
	const list = Array.isArray(nodes) ? nodes : [];
	const byId = new Map(list.map((node) => [node.nodeId, node]));
	const children = new Set(list.flatMap((node) => Array.isArray(node.childIds) ? node.childIds : []));
	const roots = list.filter((node) => !children.has(node.nodeId));
	const lines = [];
	const visited = new Set();
	let interactive = 0;

	const walk = (node, depth) => {
		if (!node || visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		const role = axValue(node.role) || "unknown";
		const name = axValue(node.name);
		let line = `${"  ".repeat(depth)}${role}`;
		if (name) line += ` ${JSON.stringify(name)}`;
		if (INTERACTIVE_ROLES.has(role.toLowerCase())) line += ` @e${++interactive}`;
		lines.push(line);
		for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
			walk(byId.get(childId), depth + 1);
		}
	};

	for (const root of roots) walk(root, 0);
	for (const node of list) walk(node, 0);
	return { title: `page snapshot (${interactive} interactive)`, lines };
}

/** Parse an agent-browser interactive snapshot without changing its refs. */
export function parseAgentSnapshot(text) {
	const input = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
	const headers = [];
	while (input.length && /^(?:Page|URL)\s*:/i.test(input[0])) {
		headers.push(input.shift().replace(/^(?:Page|URL)\s*:\s*/i, ""));
	}
	while (input.length && input[0] === "") input.shift(); // blank separator line
	while (input.length && input.at(-1) === "") input.pop();
	return { title: headers.join(" — ") || "page snapshot", lines: input };
}

// --- Network requests -------------------------------------------------------

function redactUrl(value) {
	try {
		const url = new URL(String(value));
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return String(value ?? "").replace(/([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/i, "$1").split(/[?#]/, 1)[0];
	}
}

/** Format network request rows as a compact, redacted table. */
export function formatRequests(rows) {
	const values = (Array.isArray(rows) ? rows : []).map((row) => [
		String(row.method ?? ""),
		row.status == null ? "…" : String(row.status),
		String(row.type ?? ""),
		redactUrl(row.url),
	]);
	const headings = ["METHOD", "STATUS", "TYPE"];
	const widths = headings.map((heading, index) => Math.max(heading.length, ...values.map((row) => row[index].length)));
	const lines = [
		[headings[0].padEnd(widths[0]), headings[1].padEnd(widths[1]), headings[2].padEnd(widths[2]), "URL"].join(" "),
		...values.map((row) => [row[0].padEnd(widths[0]), row[1].padEnd(widths[1]), row[2].padEnd(widths[2]), row[3]].join(" ")),
	];
	return { title: `requests (${values.length})`, lines };
}

// --- Snapshot differences --------------------------------------------------

function normalizeRefs(line) {
	return String(line)
		.replace(/@e\d+\b/g, "") // CDP formatAxNodes refs
		.replace(/,?\s*ref=e\d+\b/g, "") // agent-browser snapshot refs
		.replace(/\[\s*\]/g, "") // empty attribute list left behind
		.replace(/[ \t]+$/g, "");
}

/** Diff snapshots while ignoring volatile interactive-element references. */
export function diffSnapshot(prevLines, nextLines) {
	const previous = (Array.isArray(prevLines) ? prevLines : []).map(normalizeRefs);
	const next = (Array.isArray(nextLines) ? nextLines : []).map(normalizeRefs);
	const previousCounts = new Map();
	for (const line of previous) previousCounts.set(line, (previousCounts.get(line) || 0) + 1);
	const added = [];
	for (const line of next) {
		const count = previousCounts.get(line) || 0;
		if (count) previousCounts.set(line, count - 1);
		else added.push(line);
	}
	const nextCounts = new Map();
	for (const line of next) nextCounts.set(line, (nextCounts.get(line) || 0) + 1);
	const removed = [];
	for (const line of previous) {
		const count = nextCounts.get(line) || 0;
		if (count) nextCounts.set(line, count - 1);
		else removed.push(line);
	}
	if (!added.length && !removed.length) return { title: "snapshot diff (no change)", lines: [] };
	return {
		title: `snapshot diff (+${added.length} -${removed.length})`,
		lines: [...added.map((line) => `+ ${line}`), ...removed.map((line) => `- ${line}`)],
	};
}
