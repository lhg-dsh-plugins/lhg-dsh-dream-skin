/* Roadmap A1, 10.13.0 — the pairing gate.
 *
 * A1's promise is "a host re-roll cannot silently delete a refinement". For years the judge was
 * runtime (`anchors.drifted` empty). 10.12.1 added a bucket for absences that are only CHANNEL
 * divergence, and the acceptance became "drifted AND channelAbsent both empty" — which, once a
 * rule is honestly carried by a hash-free anchor, can only be satisfied by DELETING the working
 * hash branch to turn a light green. That is this repository's own "为变绿而放宽" failure with the
 * sign flipped, so this gate moves the judge onto what every machine can check in both
 * directions:
 *
 *   1. PAIRING (bundle text only — runs with no host and no browser, so CI always runs it):
 *      every rule in a registered stylesheet that names a host build hash must ALSO name a
 *      hash-free anchor in the same selector list, unless that hash is registered in
 *      `DEAD_HASHES` (0 hits on every host we can read; kept for the `0.1.x` line; reported in
 *      `anchors.retired`) or in `CHANNEL_DIVERGENT_GROUPS` WITH a `carriedBy` field (present on
 *      one channel, absent on the other; reported in `anchors.channelAbsent`). The exemption
 *      lists are read from the registries, so a new hash-only rule cannot be smuggled past by
 *      editing this file.
 *   2. MEASUREMENT (both channels' own shipped bytes): the anchors `carriedBy` names must be
 *      published by npm AND by the official shell — re-read from the installed host tree and
 *      from `app.asar`, never from a copied constant, including the structural claim that the
 *      queue dock renders its panel as a direct child. The host tree is scanned as a CORPUS (every
 *      package that ships a `lib/client.js`, not only the one the registry names), because an
 *      attribute anchor is only safe while exactly one component stamps it.
 *
 * Two exits (issue #102): no host / no shell ⇒ `t.skip` naming which halves could not be read;
 * a pairing violation ⇒ red, with the rule quoted.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { extractSheets, parseBlocks } = require("../scripts/craft-audit.cjs");
const { DEAD_HASHES, CHANNEL_DIVERGENT_GROUPS } = require("../scripts/data/dead-hashes.cjs");
const { findHostRoot, listFiles } = require("../scripts/host-consumers.cjs");
const shell = require("../scripts/lib/desktop-shell.cjs");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* A CSS-module class token is `.<base>_<key>`; the base is the rolled hash. The width is
 * deliberately looser than the census's 8-char hashes — a gate that only recognises the exact
 * spelling it was written against is a gate against last release. `[class$="_footArea"]` is NOT
 * hash-shaped, which is the whole distinction. */
const HASH_CLASS = /(?:^|[\s,>+~(])\.([A-Za-z0-9_-]{4,9})_[A-Za-z][A-Za-z0-9-]*/g;

function hashBasesIn(selector) {
	const out = [];
	let m;
	HASH_CLASS.lastIndex = 0;
	while ((m = HASH_CLASS.exec(selector))) out.push(m[1]);
	return out;
}

/** The comma-separated branches of a selector list that are hash-free by SHAPE. */
function hashFreeBranches(selector) {
	return selector.split(",").map((s) => s.trim()).filter((s) => s && !hashBasesIn(s).length);
}

/** Bases excused from pairing, read out of the registries — never re-typed here. */
function exemptBases(registry = CHANNEL_DIVERGENT_GROUPS) {
	const set = new Set(Object.keys(DEAD_HASHES));
	for (const entry of Object.values(registry)) {
		if (!entry.carriedBy) continue;
		for (const s of entry.surfaces || []) {
			set.add(s.npmBase);
			set.add(s.shellBase);
		}
	}
	return set;
}

/** Divergent bases whose registry entry forgot to say what carries the rule. */
function uncarriedBases(registry) {
	const set = new Set();
	for (const entry of Object.values(registry)) {
		if (entry.carriedBy) continue;
		for (const s of entry.surfaces || []) {
			set.add(s.npmBase);
			set.add(s.shellBase);
		}
	}
	return set;
}

/** Exit 1: the bundle alone decides this, so it runs everywhere including CI. */
function pairingProblems(cssById, registry = CHANNEL_DIVERGENT_GROUPS) {
	const problems = [];
	const exempt = exemptBases(registry);
	const uncarried = uncarriedBases(registry);
	for (const [sheetId, css] of Object.entries(cssById)) {
		for (const block of parseBlocks(css)) {
			const sel = block.selector || "";
			const bases = hashBasesIn(sel);
			if (!bases.length) continue;
			const free = hashFreeBranches(sel);
			const unknown = bases.filter((b) => !exempt.has(b) && !uncarried.has(b));
			if (unknown.length && !free.length) {
				problems.push(`${sheetId}: "${sel.slice(0, 72)}" bets on host hash [${unknown.join(",")}] `
					+ "with no hash-free anchor in the same selector — a re-roll silently deletes this refinement (Roadmap A1)");
				continue;
			}
			const dangling = bases.filter((b) => uncarried.has(b));
			if (dangling.length) {
				// Independent of whether the rule happens to carry some anchor: an entry in this
				// registry is the RECORD of why the hash may be absent, and a record that does not
				// name what replaced it cannot be checked by whoever reads `anchors.channelAbsent`.
				problems.push(`${sheetId}: "${sel.slice(0, 72)}" is excused only as channel-divergent, but that `
					+ `registry entry names no carriedBy anchor [${dangling.join(",")}] — nothing is carrying this rule`);
			}
		}
	}
	return problems;
}

/** The stronger half of the pairing rule, and the one the generic check cannot do:
 *  a registry entry names WHICH anchor carries it, so the rule that names those hashes must
 *  name THAT anchor. Without this leg, deleting the todo-panel anchor from a rule that still
 *  carries the queue-dock anchor looks perfectly paired to the generic gate — while the todo
 *  panel silently loses its frosting on the shell again. */
function carriedByProblems(cssById, registry = CHANNEL_DIVERGENT_GROUPS) {
	const problems = [];
	const blocks = Object.entries(cssById).flatMap(([id, css]) => parseBlocks(css).map((b) => [id, b]));
	for (const [group, entry] of Object.entries(registry)) {
		if (!entry.carriedBy) continue;
		const bases = (entry.surfaces || []).flatMap((s) => [s.npmBase, s.shellBase]);
		const rules = blocks.filter(([, b]) => bases.some((x) => hashBasesIn(b.selector || "").includes(x)));
		if (!rules.length) {
			problems.push(`registry entry "${group.slice(0, 40)}" names no shipped rule — the carriedBy excuse guards nothing`);
			continue;
		}
		for (const [id, b] of rules) {
			for (const a of entry.carriedBy.anchors || []) {
				if (!b.selector.includes(a)) {
					problems.push(`${id}: rule "${b.selector.slice(0, 72)}" names a hash this release excused, but no longer carries `
						+ `the anchor the registry promised (${a}) — the generic pairing check cannot see this: another anchor in the same `
						+ "list would satisfy it while this surface silently stops painting");
				}
			}
		}
	}
	return problems;
}

/** Which injected stylesheets does craft-audit NOT know by name?
 *  Pairing itself would still grade an unnamed sheet (it iterates every sheet it is handed),
 *  but every OTHER craft gate keys off the registered tables — so an unnamed sheet is graded by
 *  half the gates and ignored by the rest. That split is worth a red line, not a comment. */
function unregisteredSheetIds(sheetList) {
	return sheetList.filter((s) => s.registered === false).map((s) => s.id);
}

/** Every channel-divergent excuse has to say what carries the rule now. This is a claim about
 *  the REGISTRY, not about the CSS: a rule can keep its anchor while the excuse behind the
 *  absent hash went mute, and then `anchors.channelAbsent` would be read by a consumer with no
 *  way to check it. */
function excuseShapeProblems(registry = CHANNEL_DIVERGENT_GROUPS) {
	const problems = [];
	for (const [group, entry] of Object.entries(registry)) {
		const cb = entry.carriedBy;
		if (!cb || !Array.isArray(cb.anchors) || cb.anchors.length === 0) {
			problems.push(`"${group.slice(0, 44)}" is registered as channel-divergent without a carriedBy anchor — `
				+ "`anchors.channelAbsent` would report an absence nobody has shown to be harmless");
		}
	}
	return problems;
}

/** The token a host has to publish for an anchor to be the anchor we claim. */
function hookTokensOf(anchor) {
	const out = [];
	const re = /\[([\w-]+)(?:\s*=\s*"([^"]+)")?\]/g;
	let m;
	while ((m = re.exec(anchor))) out.push(m[2] !== undefined ? m[2] : m[1]);
	return out;
}

/** Which of the read packages publish a hook token. A hook claimed by ONE component stops being
 *  an anchor the moment a second component stamps it too — then the rule paints a surface nobody
 *  asked for, which is the issue-L1 shape arriving through an attribute instead of a class
 *  suffix. Measured 2026-10-13: `todo-panel` and `data-queue-dock` appear in exactly one npm
 *  package each (`dsh-client-ui-conversation`) and once in the shell's `app.asar`. */
function publishersOf(textByPackage, token) {
	return Object.entries(textByPackage || {}).filter(([, t]) => t && t.includes(token)).map(([p]) => p);
}

/** Exit 2's pure half: given both channels' bytes, does every carriedBy claim still hold? */
function measureProblems({ registry = CHANNEL_DIVERGENT_GROUPS, npmTexts, shellText, npmTextByPackage }) {
	const problems = [];
	const channels = [];
	if (npmTexts && npmTexts.length) channels.push(["npm", npmTexts.join("\n")]);
	if (shellText) channels.push(["shell", shellText]);
	for (const [group, entry] of Object.entries(registry)) {
		const cb = entry.carriedBy;
		if (!cb) continue;
		const anchors = cb.anchors || [];
		if (!anchors.length) {
			problems.push(`${group.slice(0, 40)}: carriedBy with no anchors — the excuse asserts nothing`);
			continue;
		}
		for (const a of anchors) {
			if (hashBasesIn(a).length) problems.push(`${group.slice(0, 40)}: anchor "${a}" is itself hash-shaped`);
		}
		// Our own stamps are not a host publication; only the host-published hooks get measured.
		const hostHooks = anchors.filter((a) => !a.includes("data-dsh-dream-skin"));
		const want = [...new Set(hostHooks.flatMap(hookTokensOf))];
		if (!want.length) continue;
		for (const [name, text] of channels) {
			const declared = (cb.hookOccurrences || {})[name];
			for (const token of want) {
				if (!text.includes(token)) {
					problems.push(`${group.slice(0, 40)}: the ${name} channel does not publish "${token}" — `
						+ "the anchor this entry claims is not there, so the rule is NOT carried hash-free");
					continue;
				}
				// Presence is not exclusivity-within-a-component: a host that stamps the same hook on
				// a SECOND element passes `includes()` while our rule starts painting a surface nobody
				// claimed. The registry therefore has to say HOW MANY times, and that number is
				// re-counted from the channel's bytes on every run rather than trusted.
				const seen = text.split(token).length - 1;
				const wantCount = declared ? declared[token] : undefined;
				if (wantCount === undefined) {
					problems.push(`${group.slice(0, 40)}: carriedBy declares no expected "${token}" count for ${name} `
						+ `(measured ${seen}) — a presence-only claim cannot tell one stamp from two, and frosting `
						+ `the second element would be the issue-L1 shape again`);
				} else if (seen !== wantCount) {
					problems.push(`${group.slice(0, 40)}: "${token}" is stamped ${seen} times on ${name}, the registry says `
						+ `${wantCount} — ${seen > wantCount ? "a second element now carries the hook this rule matches, so it would be frosted too"
							: "the hook is thinning out; this anchor may no longer be the one the rule needs"}`);
				}
			}
			if (!text.includes("data-queue-dock")) continue;
			const at = text.indexOf("data-queue-dock");
			const win = text.slice(at, at + 400);
			// The rendered shape both channels were read in: the dock element's `children` is a
			// `jsxs("div", { className: <mod>.panel … })` — i.e. the panel we frost is the dock's
			// DIRECT child, which is what makes `[data-queue-dock] > [class$="_panel"]` exact.
			const directChild = /data-queue-dock"\s*:\s*"[^"]*",\s*children:\s*\(0,\s*[\w$.]+\)\(\s*"div",\s*\{\s*className:\s*[\w$.]+\.panel\b/.test(win);
			if (!directChild) {
				problems.push(`${group.slice(0, 40)}: on ${name} the element after "data-queue-dock" is no longer rendered `
					+ "as the dock's direct `.panel` child — `[data-queue-dock] > [class$=\"_panel\"]` must be re-measured");
			}
		}
		const owner = (entry.surfaces || [])[0] && (entry.surfaces || [])[0].npmPackage;
		// Skipped, not silently satisfied, when the caller has no per-package corpus: "I could not
		// read who stamps this" must never be reported as "one component stamps this".
		if (npmTextByPackage) {
			for (const token of want) {
				const pubs = publishersOf(npmTextByPackage, token);
				if (pubs.length > 1) {
					problems.push(`${group.slice(0, 40)}: "${token}" is stamped by ${pubs.length} npm packages [${pubs.join(",")}] `
						+ `— the anchor stopped belonging to ${owner} alone, so frosting it would paint a foreign surface (the issue-L1 shape, `
						+ "arriving through an attribute this time)");
				} else if (pubs.length === 1 && owner && pubs[0] !== owner) {
					problems.push(`${group.slice(0, 40)}: "${token}" is published by ${pubs[0]}, not the claimed owner ${owner}`);
				}
			}
		}
	}
	return problems;
}

/* ------------------------------- the tests --------------------------------- */

const sheets = {};
for (const s of extractSheets(read("lib/client.js"))) sheets[s.id] = s.css;

test("A1 pairing: no rule in a registered sheet may bet on a host hash without a hash-free anchor", () => {
	assert.ok(Object.keys(sheets).length >= 2, `this gate must see both registered sheets, saw [${Object.keys(sheets)}]`);
	const unnamed = unregisteredSheetIds(extractSheets(read("lib/client.js")));
	assert.deepEqual(unnamed, [], `the bundle injects stylesheet(s) [${unnamed.join(", ")}] that craft-audit does not name — `
		+ "pairing would grade them, but every other craft gate keys off the REGISTERED tables, so this release would be `clean` on a sheet only half the gates can see. Name it in craft-audit first.");
	const problems = pairingProblems(sheets).concat(carriedByProblems(sheets));
	assert.deepEqual(problems, [], `Roadmap A1 regressions:\n${problems.join("\n")}`);
});

test("A1 pairing: the frosting rule names BOTH host hooks by name, not merely some hash-free branch", () => {
	const all = Object.values(sheets).flatMap((css) => parseBlocks(css));
	const frost = all.find((b) => /todo-panel/.test(b.selector || ""));
	assert.ok(frost, "the frosting rule disappeared — the shell loses its frosting and this gate would not have said so");
	for (const need of ["[data-testid=\"todo-panel\"]", "[data-queue-dock] > [class$=\"_panel\"]"]) {
		assert.ok(frost.selector.includes(need),
			`the frosting rule must carry ${need} literally; a generic anchor elsewhere would not put the frosting back on the shell (selector was: ${frost.selector})`);
	}
});

/** A host bundle shaped like the real one (measured 2026-10-13 on both channels), so the
 *  measurement legs run without a host installed — CI has none. */
function hostFake(testidValue) {
	return [
		"function TodoPanel({ todos, t }) { if (todos.length === 0) return null;",
		"  return (0, react_jsx_runtime.jsx)(\"section\", { className: TodoPanel_module_css_default.root,",
		"    \"data-testid\": \"" + testidValue + "\", \"aria-label\": t(\"todo.title\"), children: (0, react_jsx_runtime.jsxs)(\"div\", {",
		"      className: TodoPanel_module_css_default.body }) }); }",
		"return (0, react_jsx_runtime.jsx)(\"div\", { className: QueueDock_module_css_default.dock,",
		"  \"data-queue-dock\": \"\",",
		"  children: (0, react_jsx_runtime.jsxs)(\"div\", {",
		"    className: QueueDock_module_css_default.panel, children: [rowCount > 1] }) });"
	].join("\n");
}
const npmFake = () => hostFake("todo-panel") + "\n.lXshSW_root{}._7yHdaG_panel{}";
const shellFake = () => hostFake("todo-panel") + "\n.aSus8q_root{}.v1kfCW_panel{}";

test("A1 pairing mutations: each way the promise can rot reddens its own leg", () => {
	const legs = [];
	const bundleText = read("lib/client.js");
	const baseCss = sheets.material;

	// A stylesheet craft-audit cannot name is graded HERE but by no other craft gate, so the
	// release could read "clean" on a sheet only half the gates can see. The leg plants a real
	// `.textContent =` assignment into a string copy of the bundle and lets the EXTRACTOR answer —
	// this file is not asserting a shape it invented.
	legs.push(["the bundle injects a sheet craft-audit does not name", () => {
		const planted = bundleText + "\n;var probe=document.createElement('style');probe.textContent='.zzZz99_card{color:red}';\n";
		assert.ok(unregisteredSheetIds(extractSheets(planted)).length > 0,
			"the planted sheet was not picked up as unnamed — this leg would be grading nothing");
		// The control half: the real bundle must have no unnamed sheet, or the check is a tautology.
		assert.deepEqual(unregisteredSheetIds(extractSheets(bundleText)), [],
			"the shipped bundle itself carries an unnamed stylesheet — fix that before this leg means anything");
		return unregisteredSheetIds(extractSheets(planted)).map((id) => `sheet ${id} is not registered in craft-audit — half the gates would ignore it`);
	}, /not registered in craft-audit/]);

	legs.push(["a hash-only rule with no anchor", () => {
		const copy = Object.assign({}, sheets, { material: baseCss + "\n.q7Zz0a_card{background:red}" });
		return pairingProblems(copy);
	}, /no hash-free anchor/]);

	legs.push(["the frosting anchor dropped from the rule, while another anchor still satisfies the generic check", () => {
		const copy = Object.assign({}, sheets, {
			material: baseCss.replace("[data-testid=\"todo-panel\"], ", "")
		});
		// pairingProblems must stay SILENT here (the queue-dock anchor is still in the list), which
		// is exactly why carriedByProblems exists: the generic rule cannot see this rot.
		const generic = pairingProblems(copy);
		const strict = carriedByProblems(copy);
		assert.ok(generic.length === 0,
			`unexpected: the generic pairing check caught it (${JSON.stringify(generic)}) — then the strict leg below is dead weight, say so instead of keeping both`);
		return strict;
	}, /no longer carries the anchor/]);

	legs.push(["the queue-dock anchor dropped instead", () => {
		const copy = Object.assign({}, sheets, {
			material: baseCss.replace(", [data-queue-dock] > [class$=\"_panel\"]", "")
		});
		return carriedByProblems(copy);
	}, /no longer carries the anchor/]);

	legs.push(["a registry excuse whose entry stopped naming what carries it", () => {
		const clone = JSON.parse(JSON.stringify(CHANNEL_DIVERGENT_GROUPS));
		delete clone[".lXshSW_root, ._7yHdaG_panel"].carriedBy;
		return pairingProblems(sheets, clone);
	}, /excused only as channel-divergent/]);

	legs.push(["an excuse that no shipped rule matches any more", () => {
		const copy = Object.assign({}, sheets, {
			material: baseCss.replace(", .lXshSW_root, ._7yHdaG_panel", "")
		});
		return carriedByProblems(copy);
	}, /names no shipped rule/]);

	legs.push(["an anchor that is itself a hash", () => {
		const clone = JSON.parse(JSON.stringify(CHANNEL_DIVERGENT_GROUPS));
		clone[".lXshSW_root, ._7yHdaG_panel"].carriedBy.anchors = [".aSus8q_root"];
		return measureProblems({ registry: clone, npmTexts: [""], shellText: "" });
	}, /hash-shaped/]);

	legs.push(["carriedBy that claims anchors with no anchors", () => {
		const clone = JSON.parse(JSON.stringify(CHANNEL_DIVERGENT_GROUPS));
		clone[".lXshSW_root, ._7yHdaG_panel"].carriedBy.anchors = [];
		return measureProblems({ registry: clone, npmTexts: [""], shellText: "" });
	}, /no anchors/]);

	// The measurement legs run on synthetic bytes: "the channel stopped publishing the hook" and
	// "the host re-nested the panel" must both be caught by re-reading the corpora, not by prose.
	legs.push(["the shell stops publishing the todo-panel testid", () => {
		const fake = shellFake().replace(/todo-panel/g, "todo-list");
		return measureProblems({ npmTexts: [npmFake()], shellText: fake });
	}, /the shell channel does not publish/]);

	legs.push(["the queue dock re-nests its panel behind another div", () => {
		const reNest = (t) => t.replace("className: QueueDock_module_css_default.panel",
			"className: QueueDock_module_css_default.shell, children: (0, react_jsx_runtime.jsx)(\"div\", { className: QueueDock_module_css_default.panel");
		const shellNested = reNest(shellFake());
		const npmNested = reNest(npmFake());
		assert.ok(shellNested !== shellFake() && npmNested !== npmFake(),
			"the re-nest mutation did not change the fixtures — it would test nothing");
		// control: the same fixtures without the re-nest must be clean, or this leg proves nothing
		assert.deepEqual(measureProblems({ npmTexts: [npmFake()], shellText: shellFake() }), [],
			"the synthetic fixtures must pass the measurement before they are mutated");
		return measureProblems({ npmTexts: [npmNested], shellText: shellNested });
	}, /dock's direct `\?panel`? child|no longer rendered/]);

	// The attribute anchor is only as exclusive as the corpus says. Both legs read a synthetic
	// corpus whose owner is the package the registry names, so the reddening is attributable to
	// the publisher set alone and not to a fixture that was already wrong.
	legs.push(["a second npm package starts stamping the same hooks", () => {
		const owner = "dsh-client-ui-conversation";
		const byPkg = { [owner]: npmFake(), "dsh-client-ui-planner": hostFake("todo-panel") };
		assert.deepEqual(measureProblems({ npmTexts: [npmFake()], shellText: shellFake(), npmTextByPackage: { [owner]: npmFake() } }), [],
			"the one-publisher synthetic corpus must pass before it is mutated");
		return measureProblems({ npmTexts: [npmFake()], shellText: shellFake(), npmTextByPackage: byPkg });
	}, /stamped by 2 npm packages/]);

	legs.push(["the hooks' only publisher stopped being the package the registry claims", () => {
		const byPkg = { "dsh-client-ui-something-else": hostFake("todo-panel") };
		return measureProblems({ npmTexts: [npmFake()], shellText: shellFake(), npmTextByPackage: byPkg });
	}, /not the claimed owner/]);

	legs.push(["the host starts stamping the same hook on a second element", () => {
		const doubled = shellFake().replace('"data-queue-dock": ""', '"data-queue-dock": "", "data-queue-dock": ""');
		assert.ok(doubled !== shellFake(), "the double-stamp mutation did not change the fixture — it would test nothing");
		assert.deepEqual((doubled.match(/data-queue-dock/g) || []).length, 2,
			"the double-stamp fixture must actually contain the hook twice, or this leg measures nothing");
		return measureProblems({ npmTexts: [npmFake()], shellText: doubled });
	}, /stamped 2 times on shell, the registry says 1/]);

	legs.push(["an excuse that stopped saying how many times the host stamps it", () => {
		const clone = JSON.parse(JSON.stringify(CHANNEL_DIVERGENT_GROUPS));
		delete clone[".lXshSW_root, ._7yHdaG_panel"].carriedBy.hookOccurrences;
		return measureProblems({ registry: clone, npmTexts: [npmFake()], shellText: shellFake() });
	}, /declares no expected "todo-panel" count/]);

	for (const [label, mutate, expect] of legs) {
		const problems = mutate();
		assert.ok(problems.length > 0, `mutation "${label}" produced NO problem — the gate cannot see this rot`);
		assert.ok(problems.some((p) => expect.test(p)),
			`mutation "${label}" reddened, but not for the reason it claims: ${JSON.stringify(problems)}`);
	}
});

test("A1 measurement: the anchors are published on npm AND on the official shell's own bytes", (t) => {
	const missing = [];
	let root = null;
	try {
		root = findHostRoot();
	} catch (e) {
		missing.push(`no installed DSH host (${e.message.split("\n")[0]})`);
	}
	if (!shell.findShellAsar()) missing.push("no official desktop shell app.asar");
	if (missing.length) {
		t.skip(`${missing.join(" and ")} — the pairing legs above ran; the cross-channel measurement could not`);
		return;
	}
	const pkgs = [...new Set(Object.values(CHANNEL_DIVERGENT_GROUPS).flatMap((e) => (e.surfaces || []).map((s) => s.npmPackage)))];
	// Every package that ships a client bundle, not only the ones the registry names: the claim
	// being measured is "this hook belongs to one component", and a claim re-read only from the
	// named package can never notice a neighbour starting to stamp the same attribute.
	const npmTextByPackage = {};
	for (const d of fs.readdirSync(root, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const f = path.join(root, d.name, "lib", "client.js");
		if (!fs.existsSync(f)) continue;
		npmTextByPackage[d.name] = fs.readFileSync(f, "latin1");
	}
	const npmTexts = [];
	for (const p of pkgs) {
		assert.ok(npmTextByPackage[p],
			`the registry names npm package ${p}, but no ${p}/lib/client.js is installed — re-measure before this sentence stays`);
		npmTexts.push(npmTextByPackage[p]);
	}
	const shellText = shell.readShellAsar();
	assert.ok(shellText && shellText.length > 1e7, `the shell bundle read suspiciously small (${shellText && shellText.length} bytes)`);
	const problems = measureProblems({ npmTexts, shellText, npmTextByPackage });
	assert.deepEqual(problems, [], `the hash-free anchors no longer hold on both channels:\n${problems.join("\n")}`);

	// The corpus is the measurement, so name what it counted: one publisher per hook, and it is the
	// package the registry claims. Written out rather than only asserted, because a reader who
	// re-runs this wants the numbers, not a green tick.
	console.log(`frosthooks corpus: ${Object.keys(npmTextByPackage).length} npm client bundles read;`);
	for (const [group, entry] of Object.entries(CHANNEL_DIVERGENT_GROUPS)) {
		if (!entry.carriedBy) continue;
		const owner = (entry.surfaces || [])[0] && (entry.surfaces || [])[0].npmPackage;
		const hostHooks = (entry.carriedBy.anchors || []).filter((a) => !a.includes("data-dsh-dream-skin"));
		for (const token of [...new Set(hostHooks.flatMap(hookTokensOf))]) {
			const pubs = publishersOf(npmTextByPackage, token);
			const occ = entry.carriedBy.hookOccurrences || {};
			console.log(`  ${group.slice(0, 26)}: "${token}" — npm publishers [${pubs.join(", ")}]${owner ? ` (owner ${owner})` : ""}, `
				+ `stamps npm ${(npmTexts.join("\n").split(token).length - 1)}/${((occ.npm || {})[token] ?? "?")} `
				+ `declared, shell ${(shellText.split(token).length - 1)}/${((occ.shell || {})[token] ?? "?")} declared`);
		}
	}
});
