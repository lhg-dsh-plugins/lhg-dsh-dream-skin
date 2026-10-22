/* Roadmap A (S) — the host release preflight, and its own gate.
 *
 * Two rulers run in this file and they are not interchangeable:
 *   - the judgment legs call `buildTable()` with an INJECTED `evaluate`, because what is under test
 *     is the table's reasoning (which row is "today's host", what counts as a problem, which exit
 *     is which) — not semver, which `tests/package.host_compat.test.cjs` already pins against
 *     fixtures captured from the host's own checker;
 *   - the CLI legs run `main()` with an injected `spawn` / `findHost`, so no network and no host
 *     install is needed for a machine to grade the whole decision path — and, per issue #102, so a
 *     missing environment reads as exit 3/4 naming the piece rather than as a red.
 *
 * The `--profile-load` half DOES need the installed host (it drives the host's real loader), so it
 * declares its precondition and skips by name when the machine has none. That half is the one that
 * catches what a version table cannot: an exemption we quietly rely on, a bundle the profile never
 * installed, a patch layer that stopped parsing.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const preflight = require("../scripts/host-preflight.cjs");
const { gateRange } = require("../scripts/lib/peer-window.cjs");
const OUR_MANIFEST = require(path.join(ROOT, "package.json"));
const RANGE = gateRange(OUR_MANIFEST);

const FIXTURE = (name) => path.join(ROOT, "tests", "fixtures", name);
const readJson = (name) => JSON.parse(fs.readFileSync(FIXTURE(name), "utf8"));
const SAMPLE = readJson("host_packument_sample.json");
const FUTURE = readJson("host_packument_future.json");
const SAMPLE_ARG = ["--packument", FIXTURE("host_packument_sample.json")];
const FUTURE_ARG = ["--packument", FIXTURE("host_packument_future.json")];

/**
 * A stand-in for the host's evaluator, written as a LOOKUP rather than a re-derivation: if it
 * computed ranges it would be a second implementation of the thing under test, and the leg could
 * only ever agree with itself. `outside` is the set of versions this synthetic host refuses.
 */
function evaluator(outside) {
	const set = new Set(outside);
	return (version) => {
		if (!set.has(version)) return undefined;
		const peers = {};
		for (const [name] of Object.entries(OUR_MANIFEST.peerDependencies)) {
			if (name.startsWith("@deepseek-ai/dsh-")) peers[name] = RANGE;
		}
		return { peers, exempted: false };
	};
}

const noHostFn = () => {
	const e = new Error("synthetic: no installed @deepseek-ai/dsh on this machine");
	e.environment = true;
	e.piece = "host install";
	throw e;
};

const packumentWith = (rows, tags) => ({
	name: "@deepseek-ai/dsh",
	versions: Object.fromEntries(rows.map((r) => [r.version, { version: r.version }])),
	time: Object.fromEntries(rows.filter((r) => r.at).map((r) => [r.version, r.at])),
	"dist-tags": tags || {}
});

test("the table's newest ruler is the publish stamp, not the version tuple", () => {
	// `0.2.1-alpha.9` sorts BELOW `0.3.0` by tuple but ABOVE it by stamp — the case where an
	// implementation that sorted by version string would call the wrong row "today's host" and then
	// pronounce a flawless verdict about the wrong version.
	const rows = [
		{ version: "0.3.0", at: "2026-01-01T00:00:00.000Z" },
		{ version: "0.2.1-alpha.9", at: "2026-09-01T00:00:00.000Z" }
	];
	const table = preflight.buildTable({ packument: packumentWith(rows), range: RANGE, evaluate: evaluator(["0.3.0"]) });
	assert.equal(table.summary.newest.version, "0.2.1-alpha.9", "the newest published version is the one stamped last");
	assert.deepEqual(table.problems, [], "an OLD version outside the window is not today's problem — the newest one is");
});

test("a newest host outside our window reddens, and the sentence names both honest ways out", () => {
	const rows = [
		{ version: "0.2.0-rc.2", at: "2026-09-29T09:56:27.792Z" },
		{ version: "0.3.0-rc.1", at: "2026-10-20T00:00:00.000Z" }
	];
	const table = preflight.buildTable({ packument: packumentWith(rows, { latest: "0.2.0-rc.2" }), range: RANGE, evaluate: evaluator(["0.3.0-rc.1"]) });
	assert.equal(table.problems.length, 1, `expected exactly one problem, got: ${JSON.stringify(table.problems)}`);
	const p = table.problems[0];
	assert.match(p, /NEWEST published @deepseek-ai\/dsh is 0\.3\.0-rc\.1/);
	assert.match(p, /does NOT cover it/);
	// The sentence is only useful if it carries the two responses this repository has committed to;
	// "widen it" alone is how a window becomes an unbounded claim.
	assert.match(p, /widen the window/);
	assert.match(p, /不支持/);
	assert.match(p, /issue #62/);
});

test("dist-tags.latest is its own joint, and an inconsistent tag is a checker problem", () => {
	// Newest-by-stamp is inside while the TAG points outside. Two different user experiences, so two
	// separate problems: `npm i @deepseek-ai/dsh` follows the tag, not the stamp.
	const rows = [
		{ version: "0.3.0", at: "2026-01-01T00:00:00.000Z" },
		{ version: "0.2.1-alpha.2", at: "2026-10-09T08:18:00.500Z" }
	];
	const table = preflight.buildTable({ packument: packumentWith(rows, { latest: "0.3.0" }), range: RANGE, evaluate: evaluator(["0.3.0"]) });
	assert.equal(table.problems.length, 1, JSON.stringify(table.problems));
	assert.match(table.problems[0], /dist-tags\.latest 0\.3\.0 is outside our window/);

	const ghost = preflight.buildTable({ packument: packumentWith(rows, { latest: "9.9.9" }), range: RANGE, evaluate: evaluator([]) });
	assert.ok(ghost.problems.some((p) => /no such entry/.test(p)),
		"a tag naming a version the list does not carry is a broken INPUT and must be reported, not judged around");
});

test("missing publish stamps and an empty version list are reported, never smoothed over", () => {
	// The fallback has to say it fell back: "newest" by tuple is a DIFFERENT claim, and a runbook
	// that reads the printed row as today's host would be acting on an unlabelled approximation.
	const rows = [{ version: "0.1.0-rc.6" }, { version: "0.2.0-rc.2", at: "2026-09-29T09:56:27.792Z" }];
	const partial = preflight.buildTable({ packument: packumentWith(rows), range: RANGE, evaluate: evaluator([]) });
	assert.ok(partial.problems.some((p) => /could not rank by publish date/.test(p) && /fell back to version order/.test(p)),
		JSON.stringify(partial.problems));

	const empty = preflight.buildTable({ packument: { name: "@deepseek-ai/dsh", versions: {} }, range: RANGE, evaluate: evaluator([]) });
	assert.match(empty.problems[0], /no versions at all — a table with no candidates proves nothing/,
		"zero candidates must never read as a clean bill of health");
});

test("the mirror is only a fallback: when the host answers, the two must agree", () => {
	// `mirror: true` is set exactly when a real host was found. A disagreement here is not a second
	// opinion — it means the dependency-free ruler that CI and every machine-without-a-host depends
	// on has drifted from the evaluator that actually loads or skips us.
	const rows = [{ version: "0.2.0-rc.2", at: "2026-09-29T09:56:27.792Z" }];
	const agree = preflight.buildTable({ packument: packumentWith(rows), range: RANGE, evaluate: evaluator([]), mirror: true });
	assert.deepEqual(agree.problems, [], "control: host says loads, mirror says loads");
	assert.equal(agree.rows[0].mirror, true, "the mirror's own verdict is recorded on the row, not merely compared");

	const drift = preflight.buildTable({ packument: packumentWith(rows), range: RANGE, evaluate: evaluator(["0.2.0-rc.2"]), mirror: true });
	assert.ok(drift.problems.some((p) => /DISAGREE about 0\.2\.0-rc\.2/.test(p) && /host_compat_verdicts\.json/.test(p)),
		`a drifted mirror has to name the fixture to regenerate, got: ${JSON.stringify(drift.problems)}`);
});

test("npm's array-shaped `versions` and the registry's object-shaped one judge the same table", () => {
	// `npm view <pkg> --json` projects versions as an ARRAY; the registry's own packument is an
	// OBJECT keyed by version. Reading the array with Object.keys yields ["0","1","2",…] — a table
	// of indices that still prints numbers, still "judges", and would have graded nothing forever.
	// This leg exists because the first version of the script had exactly that bug.
	const asArray = {
		name: "@deepseek-ai/dsh",
		versions: ["0.2.0-rc.2", "0.3.0-rc.1"],
		time: { "0.2.0-rc.2": "2026-09-29T09:56:27.792Z", "0.3.0-rc.1": "2026-10-20T00:00:00.000Z" },
		"dist-tags": {}
	};
	const asObject = packumentWith([
		{ version: "0.2.0-rc.2", at: "2026-09-29T09:56:27.792Z" },
		{ version: "0.3.0-rc.1", at: "2026-10-20T00:00:00.000Z" }
	]);
	const evaluate = evaluator(["0.3.0-rc.1"]);
	const a = preflight.buildTable({ packument: asArray, range: RANGE, evaluate });
	const b = preflight.buildTable({ packument: asObject, range: RANGE, evaluate });
	assert.deepEqual(a.rows.map((r) => r.version), b.rows.map((r) => r.version), "same candidates from both shapes");
	assert.deepEqual(a.problems, b.problems, "same verdict from both shapes");
	assert.ok(!a.rows.some((r) => /^\d+$/.test(r.version)), "no row may be a bare array index");
});

test("the captured registry sample is green today, and the future-shaped fixture is red", () => {
	// Judged by the SAME ruler the script falls back to (the mirror in scripts/lib), so this leg is
	// about the table's verdict, not about a stub that agrees with whatever we assert.
	const { satisfies } = require("../scripts/lib/peer-window.cjs");
	const mirrorEvaluate = (version) => (satisfies(version, RANGE) ? undefined : { peers: { "@deepseek-ai/dsh-client-locale": RANGE } });
	const outside = Object.keys(SAMPLE.versions).filter((v) => !satisfies(v, RANGE));
	const ok = preflight.buildTable({ packument: SAMPLE, range: RANGE, evaluate: mirrorEvaluate });
	assert.equal(outside.length, 5, `the capture is expected to hold five pre-window versions, got ${JSON.stringify(outside)} — if the capture itself changed, re-read this fixture rather than the assertion`);
	assert.equal(ok.summary.inWindow, Object.keys(SAMPLE.versions).length - outside.length, "the count follows the ruler, not a typed number");
	assert.equal(ok.summary.newest.version, "0.2.1-alpha.2");
	assert.deepEqual(ok.problems, [],
		`old versions outside the window are history, not today's problem — only the NEWEST row can redden, got ${JSON.stringify(ok.problems)}`);

	const bad = preflight.buildTable({ packument: FUTURE, range: RANGE, evaluate: mirrorEvaluate });
	assert.equal(bad.summary.newest.version, "0.3.0-rc.1", "the synthetic row is stamped 2099 so the stamp ruler must pick it");
	assert.equal(bad.problems.length, 1);
	assert.match(bad.problems[0], /0\.3\.0-rc\.1/);

	// Both fixtures are witnesses, and a witness has to be able to stop being one: the day a real
	// capture contains a version outside the window, the leg above reddens for the right reason —
	// this one says which file rotted.
	assert.ok(Object.keys(SAMPLE.versions).length >= 30, "the sample must stay a real capture, not a trimmed list");
});

test("a registry that will not answer is exit 3, and strict turns it into exit 4 — never a red verdict", async () => {
	const failing = async () => ({ status: 1, stdout: "", stderr: "npm error code ECONNRESET\n" });
	const off = await preflight.main([], {}, { spawn: failing });
	assert.equal(off.exitCode, 3, `offline is a skip, not a failure: ${JSON.stringify(off.lines)}`);
	assert.equal(off.outcome, "skip");
	assert.ok(off.lines.some((l) => /registry: SKIPPED/.test(l) && /ECONNRESET/.test(l)), JSON.stringify(off.lines));
	assert.ok(off.lines.some((l) => /a skip is not a pass/.test(l)), "and it says so out loud");

	const refused = async () => ({ status: 1, stdout: "", stderr: "npm error code ECONNREFUSED\n" });
	const strict = await preflight.main(["--strict"], {}, { spawn: refused });
	assert.equal(strict.exitCode, 4, "a runbook that promised a measurement and got none is its own exit code");
	assert.ok(strict.lines.some((l) => /strict mode was asked for/.test(l)), JSON.stringify(strict.lines));
});

test("no host install degrades to the mirror and SAYS SO, instead of failing or pretending", async () => {
	const r = await preflight.main([...SAMPLE_ARG, "--limit", "1"], {}, { findHost: noHostFn });
	assert.equal(r.exitCode, 0, `the mirror alone still answers the question, so this is not a skip: ${JSON.stringify(r.lines)}`);
	assert.equal(r.table.evaluator, "mirror");
	assert.match(r.lines[0], /evaluator: MIRROR scripts\/lib\/peer-window\.cjs/);
	assert.match(r.lines[0], /synthetic: no installed @deepseek-ai\/dsh/, "the reason the host was unusable is printed, not swallowed");
	assert.ok(!r.lines.some((l) => /the host's own evaluatePluginCompatibility/.test(l)),
		"the table must not claim the host answered when it did not");
});

test("a bad packument path and an unknown flag are usage failures, not verdicts", async () => {
	const missing = await preflight.main(["--packument", FIXTURE("definitely-not-a-fixture.json")], {}, {});
	assert.equal(missing.exitCode, 1);
	assert.match(missing.lines[0], /preflight could not run/);
	assert.match(missing.lines.join(" "), /definitely-not-a-fixture\.json/);

	const usage = await preflight.main(["--probably-a-typo"], {}, {});
	assert.equal(usage.exitCode, 1);
	assert.equal(usage.outcome, "usage");
	assert.match(usage.lines[0], /unknown argument --probably-a-typo/);
	assert.match(usage.lines[0], /--packument/, "and it lists what it does take, so the fix is obvious from the terminal");

	const limit = await preflight.main(["--limit", "0"], {}, {});
	assert.match(limit.lines[0], /--limit must be a positive integer/);

	// The future fixture end to end through the CLI: the red has to reach the exit code, not stop at
	// a printed sentence.
	const bad = await preflight.main([...FUTURE_ARG, "--limit", "1"], {}, { findHost: noHostFn });
	assert.equal(bad.exitCode, 1, JSON.stringify(bad.lines));
	assert.ok(bad.lines.some((l) => /PROBLEM: the NEWEST published/.test(l)), JSON.stringify(bad.lines));
});

test("the release runbook has to name this command, or the ritual is not yet an action", () => {
	// The Roadmap item is "make it a release action", and an action nobody is told about is the same
	// as none: issue #62 was not a missing-tool failure, it was a missing-repetition failure.
	const pkg = require(path.join(ROOT, "package.json"));
	assert.equal(pkg.scripts["host:preflight"], "node scripts/host-preflight.cjs",
		"the command must be reachable as a package script, not as a path only this file knows");

	const doc = fs.readFileSync(path.join(ROOT, "docs", "publishing-to-npm.md"), "utf8");
	assert.match(doc, /host:preflight/, "the publish checklist names the command");
	assert.match(doc, /profile-load/, "…and the second half (a real profile load)");
	assert.ok(doc.includes("DSH_PREFLIGHT_STRICT"), "…and the strict form a runbook should use");
	// The exit codes are the contract; a checklist that only prints a command lets the next person
	// read "exit 3" as "the plugin is broken".
	assert.match(doc, /不算通过|不是插件不兼容/, "the checklist states which exit is an environment fact, not a verdict");
	assert.match(doc, /窗外|不覆盖/, "…and which exit means the window has genuinely been overtaken");
});

test("--profile-load drives the host's real loader and requires that we are mounted", async (t) => {
	let host;
	try {
		host = preflight.findHost({});
	} catch (e) {
		t.skip(`no installed DSH host to load a real profile from (${e.message.split("\n")[0]}) — the table legs above ran`);
		return;
	}
	const r = await preflight.main([...SAMPLE_ARG, "--profile-load", "--limit", "1"], {}, { findHost: () => host });
	assert.equal(r.exitCode, 0, JSON.stringify(r.lines));
	assert.ok(r.loaded, "the load half really ran");
	assert.equal(r.loaded.oursMounted, true, `the host skipped us: ${JSON.stringify(r.loaded.skipped)}`);
	assert.ok(r.loaded.bundles > 0, `the profile loaded no bundle layers at all (${r.loaded.bundles}) — that is not a pass either`, JSON.stringify(r.lines));
	assert.ok(r.lines.some((l) => l.includes(`profile ${r.loaded.profileName}`)), "the reading is printed, not just asserted");
});

test("the profile half degrades the same way: named skip off strict, exit 4 on strict, never silence", async (t) => {
	let host;
	try { host = preflight.findHost({}); } catch (e) { t.skip(`no installed DSH host here (${e.message.split("\n")[0]})`); return; }
	// A profile name that does not exist is the closest thing to "this machine has no profile". It
	// must produce a NAMED skip on top of a table that still stands — not a stack, and not a red.
	const env = { DSH_HOME: FIXTURE("definitely-absent-home") };
	const off = await preflight.main([...SAMPLE_ARG, "--profile", "no-such-profile-xyz", "--limit", "1"], env, { findHost: () => host });
	assert.equal(off.exitCode, 0, `off strict the table still answers the question: ${JSON.stringify(off.lines)}`);
	assert.ok(off.lines.some((l) => /profile load SKIPPED/.test(l)), JSON.stringify(off.lines));

	const strict = await preflight.main([...SAMPLE_ARG, "--profile", "no-such-profile-xyz", "--strict", "--limit", "1"], env, { findHost: () => host });
	assert.equal(strict.exitCode, 4, "a runbook that asked for the load and did not get one is a broken pipeline");
});
