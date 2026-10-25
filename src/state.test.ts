import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, newestPosition, newestTabs, parse, prunePositions, renamePath, serialize, tabSignature } from "./state.ts";

test("serialize/parse round-trips and survives the note frontmatter", () => {
	const s = emptyState("abc", 'My "Mac"');
	s.tabs = { updated: 5, active: "a.md", list: [{ path: "a.md", pinned: true }] };
	s.positions["a.md"] = { scroll: 12.5, ts: 7 };
	assert.deepEqual(parse(serialize(s)), s);
});

test("parse rejects junk", () => {
	assert.equal(parse("hello"), null);
	assert.equal(parse("```json\n{nope\n```"), null);
	assert.equal(parse('```json\n{"version":2}\n```'), null);
});

test("tab signature ignores order but not pins or the active tab", () => {
	const a = [{ path: "a.md", pinned: false }, { path: "b.md", pinned: true }];
	const b = [...a].reverse();
	assert.equal(tabSignature(a, "a.md"), tabSignature(b, "a.md"));
	assert.notEqual(tabSignature(a, "a.md"), tabSignature(a, "b.md"));
	assert.notEqual(tabSignature(a, "a.md"), tabSignature([{ path: "a.md", pinned: true }, a[1]], "a.md"));
});

test("newest tabs and positions win; devices with no tabs are skipped", () => {
	const phone = emptyState("p", "Phone");
	const mac = emptyState("m", "Mac");
	const empty = emptyState("e", "Empty");
	phone.tabs = { updated: 20, active: null, list: [{ path: "x.md", pinned: false }] };
	mac.tabs = { updated: 10, active: null, list: [{ path: "y.md", pinned: false }] };
	empty.tabs.updated = 99;
	assert.equal(newestTabs([mac, phone, empty])?.device.id, "p");
	phone.positions["x.md"] = { scroll: 3, ts: 1 };
	mac.positions["x.md"] = { scroll: 40, ts: 2 };
	assert.equal(newestPosition([phone, mac], "x.md")?.scroll, 40);
	assert.equal(newestPosition([phone, mac], "nope.md"), null);
});

test("tabs from another workspace aren't handed off", () => {
	const phone = emptyState("p", "Phone");
	const mac = emptyState("m", "Mac");
	phone.tabs = { updated: 20, active: null, list: [{ path: "home.md", pinned: false }], workspace: "Personal" };
	mac.tabs = { updated: 10, active: null, list: [{ path: "work.md", pinned: false }], workspace: "Work" };
	assert.equal(newestTabs([phone, mac], "Work")?.device.id, "m");
	assert.equal(newestTabs([phone, mac], "Personal")?.device.id, "p");
	assert.equal(newestTabs([phone], "Work"), null);
	const old = emptyState("o", "Old");
	old.tabs = { updated: 30, active: null, list: [{ path: "x.md", pinned: false }] };
	assert.equal(newestTabs([phone, old], "Personal")?.device.id, "p");
	assert.equal(newestTabs([phone, mac, old])?.device.id, "o");
	assert.notEqual(tabSignature(phone.tabs.list, null, "Personal"), tabSignature(phone.tabs.list, null, "Work"));
});

test("prune keeps the most recent positions", () => {
	const p = { a: { scroll: 1, ts: 1 }, b: { scroll: 1, ts: 3 }, c: { scroll: 1, ts: 2 } };
	assert.deepEqual(Object.keys(prunePositions(p, 2)).sort(), ["b", "c"]);
});

test("rename moves files and folders", () => {
	const s = emptyState("a", "A");
	s.tabs = { updated: 1, active: "Old/n.md", list: [{ path: "Old/n.md", pinned: false }, { path: "Older.md", pinned: false }] };
	s.positions["Old/n.md"] = { scroll: 9, ts: 1 };
	assert.ok(renamePath(s, "Old", "New"));
	assert.equal(s.tabs.active, "New/n.md");
	assert.deepEqual(s.tabs.list.map((t) => t.path), ["New/n.md", "Older.md"]);
	assert.equal(s.positions["New/n.md"].scroll, 9);
	assert.ok(!renamePath(s, "Missing", "X"));
});
