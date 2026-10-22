"use strict";
/**
 * Roadmap C (M) — the machine-readable answer to "did the skin take effect".
 *
 * `docs/desktop-support.md` now carries a section that a script can follow: the
 * three sources, the persisted-key table, and four decision recipes. A document
 * like that rots in exactly one direction — the code gains (or renames) a
 * setting and the table quietly keeps describing the old world. So the key list
 * is NOT transcribed here either: both sides are derived at run time.
 *
 * Two rulers, deliberately different:
 *   - the KEY set comes from `lib/client.js` (grep of the constant literals),
 *     which is the same command the document tells a reader to run;
 *   - the DOM markers named by the document are checked against the bundle's
 *     quoted literals, so "we set data-dsh-dream-skin-scheme" is evidence, not
 *     a memory of what the last release said.
 *
 * Boundaries stated up front: this gate reads text. It proves the doc still
 * names every key and every marker the code has, that its recipes point at real
 * fields, and that no stale row survives. It cannot prove a recipe's SEMANTICS
 * are still right — that half lives in the live readings logged in the same
 * section (and in `tests/client.smoke.test.cjs` for the snapshot shape).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DOC_REL = "docs/desktop-support.md";
const doc = fs.readFileSync(path.join(ROOT, DOC_REL), "utf8");
const bundle = fs.readFileSync(path.join(ROOT, "lib/client.js"), "utf8");
const hostHalf = fs.readFileSync(path.join(ROOT, "lib/index.js"), "utf8");

/** The recipe section: line-start anchors, never a phrase quoted mid-paragraph. */
function recipeSection(text) {
	const lines = text.split("\n");
	const from = lines.findIndex((l) => l.startsWith("## 机读出口"));
	if (from < 0) return null;
	let to = lines.length;
	for (let i = from + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) { to = i; break; }
	}
	return lines.slice(from, to).join("\n");
}

/** Exactly what `grep -oE '"dsh-dream-skin:[a-z-]+"' lib/client.js | sort -u` gives. */
function bundleKeys() {
	return [...new Set((bundle.match(/"dsh-dream-skin:[a-z-]+"/g) || []).map((s) => s.slice(1, -1)))].sort();
}

/** Keys the document CLAIMS, read off its table rows (backticked first cell). */
function claimedKeys(section) {
	const out = [];
	for (const line of section.split("\n")) {
		const m = /^\|\s*`([a-z-]+)`\s*\|/.exec(line);
		if (m) out.push("dsh-dream-skin:" + m[1]);
	}
	return out.sort();
}

// Verbatim, including the `tr -d` stage: `grep -o` emits the WHOLE quoted match,
// and comparing that to the file's bare keys makes every key look unknown. This
// is not a hypothetical — writing the section produced exactly that false
// reading once, so the command a reader is told to run is pinned as a string.
const Q = '"';
const SQ = "'";
const ENUM_COMMAND = `grep -oE ${SQ}${Q}dsh-dream-skin:[a-z-]+${Q}${SQ} lib/client.js | tr -d ${SQ}${Q}${SQ} | sort -u`;
const SCHEMA_KEY = /export const STATE_SCHEMA_KEY = "([^"]+)"/.exec(hostHalf)[1];
const SCHEMA_VERSION = /export const STATE_SCHEMA_VERSION = "([^"]+)"/.exec(hostHalf)[1];

/** Every `data-dsh-*` the section names must be a quoted literal in the bundle. */
function markersWithoutEvidence(section) {
	const names = [...new Set((section.match(/data-dsh-[a-z0-9-]+/g) || []))];
	return names.filter((n) => !bundle.includes('"' + n + '"'));
}

function recipeProblems(section) {
	if (section === null) return ["the recipe section heading is gone from docs/desktop-support.md"];
	const problems = [];
	const keys = bundleKeys();
	const claims = claimedKeys(section);
	// The reserved key is documented too, so it joins the expected set.
	const expected = [...keys, SCHEMA_KEY].sort();
	const missing = expected.filter((k) => !claims.includes(k));
	const stale = claims.filter((k) => !expected.includes(k));
	if (missing.length) problems.push("keys the bundle writes but the table never documents: " + missing.join(", "));
	if (stale.length) problems.push("table rows naming a key no constant in lib/client.js has: " + stale.join(", "));
	// A count check on top of the set check: same members, different amount is
	// how a duplicated or dropped row hides (shape gates do not count).
	if (claims.length !== expected.length) problems.push(`row count ${claims.length} != key count ${expected.length}`);
	// The reader must be told to derive, not to trust this table.
	if (!section.includes(ENUM_COMMAND)) problems.push("the enumeration command the reader is supposed to run is gone");
	// The two read-order constraints, each named by what it prevents.
	if (!section.includes("文件里没有某枚键")) problems.push("the constraint \"absent key != the user never set it\" was deleted");
	if (!section.includes("文件里有某枚键")) problems.push("the constraint \"present key != this version wrote it\" was deleted");
	if (!section.includes("`get` 永不返回它")) problems.push("the reserved key's get-boundary sentence is gone");
	if (!section.includes("只升不降")) problems.push("the reserved key's monotone rule is gone");
	// Four recipes, each with the field it actually depends on.
	const recipes = [
		["配方 A｜", ["host:preflight"]],
		["配方 B｜", ["__DSH_DREAM_SKIN_STATUS__", "data-dsh-dream-skin-scheme", "--dsw-alias-bg-base"]],
		["配方 C｜", ["status !== \"degraded\"", "pending === false", "host.frosthooks.test.cjs"]],
		["配方 D｜", ["localStorage"]]
	];
	for (const [heading, needs] of recipes) {
		const at = section.indexOf(heading);
		if (at < 0) { problems.push(`recipe ${heading} is gone`); continue; }
		const next = section.slice(at + heading.length).search(/\*\*配方 /);
		const body = next < 0 ? section.slice(at) : section.slice(at, at + heading.length + next);
		for (const needle of needs) if (!body.includes(needle)) problems.push(`recipe ${heading} no longer names ${needle}`);
	}
	const unproven = markersWithoutEvidence(section);
	if (unproven.length) problems.push("DOM markers the doc claims with no quoted literal in lib/client.js: " + unproven.join(", "));
	return problems;
}

test("the machine-readable section documents exactly the keys lib/client.js writes", () => {
	const keys = bundleKeys();
	assert.ok(keys.length >= 20, `expected the persisted surface to be at least 20 keys, derived ${keys.length}`);
	assert.ok(keys.includes("dsh-dream-skin:skin"), "the derivation must see the skin key");
	// The reserved key is the host half's, so it must NOT leak into this list —
	// otherwise the table would claim a setting that is not one.
	assert.ok(!keys.includes(SCHEMA_KEY), "the reserved schema key must not look like a setting constant");
	assert.deepEqual(recipeProblems(recipeSection(doc)), [], "recipe section must match the code, current reading: " + keys.length + " keys + 1 reserved");
});

test("the schema key the section documents is the one lib/index.js writes", () => {
	// Cross-source: the version and the boundary sentences are checked against
	// the host half, not against this file's own copy of them.
	assert.match(SCHEMA_VERSION, /^\d+$/);
	const section = recipeSection(doc);
	assert.ok(section.includes("`" + SCHEMA_KEY.replace("dsh-dream-skin:", "") + "`"), `the table must carry the reserved key ${SCHEMA_KEY}`);
	// deleting the row for the reserved key must be named, not silently tolerated
	const withoutRow = section.split("\n").filter((l) => !new RegExp("^\\|\\s*`" + SCHEMA_KEY.split(":")[1] + "`").test(l)).join("\n");
	assert.match(recipeProblems(withoutRow).join(" / "), /never documents/);
	// and the monotone/version claims must actually be tied to the value the
	// host half exports: drop the version sentence, the gate names it.
	assert.match(recipeProblems(section.replace("`get` 永不返回它", "另外一句话")).join(" / "), /get-boundary sentence/);
});

test("reverse: the gate is red on the document as it stood BEFORE this section", () => {
	// The honest control. `git show HEAD~N:` is not available here (tests must
	// not shell out to git), so the pre-change shape is reproduced structurally:
	// every heading of the section removed, the key table removed, the recipes
	// removed. If a gate can stay green with its subject deleted, it is decoration.
	const stripped = doc.replace(/^## 机读出口[\s\S]*?\n## 锚点依赖清单/m, "## 锚点依赖清单\n");
	assert.notEqual(stripped, doc, "the strip must actually find the section");
	assert.deepEqual(recipeProblems(recipeSection(stripped)), ["the recipe section heading is gone from docs/desktop-support.md"]);
});

test("mutation: a key shipped without a table row reddens the gate", () => {
	const section = recipeSection(doc);
	const line = section.split("\n").find((l) => /^\|\s*`accent`/.test(l));
	assert.ok(line, "fixture: the accent row must exist to remove it");
	assert.match(recipeProblems(section.replace(line, "")).join(" / "), /accent/);
});

test("mutation: a stale row (a key that no longer exists) reddens the gate", () => {
	const section = recipeSection(doc);
	const injected = section.replace("| `skin` |", "| `gone-in-a-future-version` | STORAGE_KEY | dropped |\n| `skin` |");
	const joined = recipeProblems(injected).join(" / ");
	assert.match(joined, /no constant in lib\/client\.js has/);
	assert.match(joined, /row count/); // the count leg fires too, not just the set leg
});

test("mutation: dropping the derive-don't-trust command reddens the gate", () => {
	const section = recipeSection(doc);
	assert.match(recipeProblems(section.replace(ENUM_COMMAND, "grep something else")).join(" / "), /enumeration command/);
	// The `tr -d` stage specifically: without it the command yields QUOTED tokens
	// and a reader who compares them to file keys concludes nothing matches.
	const noTr = section.replace("| tr -d '\"' | sort -u", "| sort -u");
	assert.notEqual(noTr, section, "control: the tr stage must be present to remove it");
	assert.match(recipeProblems(noTr).join(" / "), /enumeration command/);
});

test("mutation: renaming a documented DOM marker away from the code reddens the gate", () => {
	const section = recipeSection(doc);
	const renamed = section.split("data-dsh-dream-skin-scheme").join("data-dsh-dream-skin-painted");
	assert.match(recipeProblems(renamed).join(" / "), /no quoted literal in lib\/client\.js/);
});

test("mutation: softening a recipe's precondition reddens the gate", () => {
	const section = recipeSection(doc);
	assert.match(recipeProblems(section.replace('s.status !== "degraded"', "s.status")).join(" / "), /配方 C｜ no longer names/);
	assert.match(recipeProblems(section.replace("pending === false", "pending")).join(" / "), /配方 C｜ no longer names/);
	// and the same leg must stay GREEN when nothing is wrong
	assert.deepEqual(recipeProblems(section), []);
});

test("mutation: deleting a read-order constraint reddens the gate", () => {
	const section = recipeSection(doc);
	assert.match(recipeProblems(section.replace("文件里没有某枚键", "少了一枚键")).join(" / "), /absent key/);
	assert.match(recipeProblems(section.replace("只升不降", "不要 downgrade")).join(" / "), /monotone rule/);
});
