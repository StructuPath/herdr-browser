import test from "node:test";
import assert from "node:assert/strict";

import {
	diffSnapshot,
	formatAxNodes,
	formatRequests,
	parseAgentSnapshot,
} from "../bin/page-text.mjs";

test("formatAxNodes flattens nesting and refs only interactive roles", () => {
	const result = formatAxNodes([
		{ nodeId: "root", role: { value: "document" }, name: { value: "Example" }, childIds: ["heading", "group"] },
		{ nodeId: "heading", role: { value: "heading" }, name: { value: "Welcome" }, childIds: [] },
		{ nodeId: "group", role: "group", name: "", childIds: ["button", "link"] },
		{ nodeId: "button", role: "button", name: "Save", childIds: [] },
		{ nodeId: "link", role: "link", name: "More information", childIds: [] },
	]);

	assert.deepEqual(result, {
		title: "page snapshot (2 interactive)",
		lines: [
			'document "Example"',
			'  heading "Welcome"',
			"  group",
			'    button "Save" @e1',
			'    link "More information" @e2',
		],
	});
});

test("formatAxNodes handles empty input and an interactive node without a name", () => {
	assert.deepEqual(formatAxNodes([]), { title: "page snapshot (0 interactive)", lines: [] });
	assert.deepEqual(formatAxNodes([{ nodeId: "1", role: "checkbox", name: "", childIds: [] }]), {
		title: "page snapshot (1 interactive)",
		lines: ["checkbox @e1"],
	});
});

test("parseAgentSnapshot moves leading page headers into the title", () => {
	const text = "pAgE: Example site\r\nuRl: https://example.test/path\r\n- button \"Save\" @e17\r\n  - text: body\r\n";
	assert.deepEqual(parseAgentSnapshot(text), {
		title: "Example site — https://example.test/path",
		lines: ['- button "Save" @e17', "  - text: body"],
	});
});

test("parseAgentSnapshot preserves a headerless body and handles empty text", () => {
	assert.deepEqual(parseAgentSnapshot("button @e9"), { title: "page snapshot", lines: ["button @e9"] });
	assert.deepEqual(parseAgentSnapshot(""), { title: "page snapshot", lines: [] });
});

test("parseAgentSnapshot drops the blank separator between header and body", () => {
	const text = "Page: Home\nURL: https://x/\n\n@e1 [button] \"Go\"\n";
	assert.deepEqual(parseAgentSnapshot(text), {
		title: "Home — https://x/",
		lines: ['@e1 [button] "Go"'],
	});
});

test("formatRequests pads columns and redacts sensitive URL components", () => {
	const result = formatRequests([
		{ method: "GET", status: null, type: "Document", url: "https://alice:secret@example.test/path?q=secret#token" },
		{ method: "POST", status: "net::ERR_CONNECTION_REFUSED", type: "Fetch", url: "https://example.test/api?key=value" },
		{ method: "GET", status: 204, type: "XHR", url: "https://example.test/done#result" },
	]);

	assert.equal(result.title, "requests (3)");
	assert.deepEqual(result.lines, [
		"METHOD STATUS                      TYPE     URL",
		"GET    …                           Document https://example.test/path",
		"POST   net::ERR_CONNECTION_REFUSED Fetch    https://example.test/api",
		"GET    204                         XHR      https://example.test/done",
	]);
	assert.ok(result.lines.every((line) => !/secret|token|alice|key=value/.test(line)));
});

test("formatRequests handles no rows", () => {
	assert.deepEqual(formatRequests([]), {
		title: "requests (0)",
		lines: ["METHOD STATUS TYPE URL"],
	});
});

test("diffSnapshot ignores refs and emits additions before removals", () => {
	assert.deepEqual(
		diffSnapshot(['button "Save" @e1', 'link "Old" @e2'], ['button "Save" @e99', 'textbox "Name" @e4']),
		{
			title: "snapshot diff (+1 -1)",
			lines: ['+ textbox "Name"', '- link "Old"'],
		},
	);
});

test("diffSnapshot handles duplicate lines and empty or unchanged input", () => {
	assert.deepEqual(diffSnapshot(["button @e1", "button @e2"], ["button @e8"]), {
		title: "snapshot diff (+0 -1)",
		lines: ["- button"],
	});
	assert.deepEqual(diffSnapshot(["link @e1"], ["link @e42"]), {
		title: "snapshot diff (no change)",
		lines: [],
	});
	assert.deepEqual(diffSnapshot([], []), { title: "snapshot diff (no change)", lines: [] });
});

test("diffSnapshot normalizes agent-browser ref=eN refs as well", () => {
	// agent-browser `snapshot -i -c` emits `ref=eN` inside an attribute list,
	// and refs shift on every snapshot; role/name/level stay stable.
	assert.deepEqual(diffSnapshot(['- link "Go" [ref=e2]'], ['- link "Go" [ref=e9]']), {
		title: "snapshot diff (no change)",
		lines: [],
	});
	assert.deepEqual(
		diffSnapshot(
			['- heading "Hello" [level=1, ref=e1]', '- button "Click" [ref=e3]'],
			['- heading "Hello" [level=1, ref=e7]', '- textbox "Name" [ref=e9]'],
		),
		{
			title: "snapshot diff (+1 -1)",
			lines: ['+ - textbox "Name"', '- - button "Click"'],
		},
	);
});
