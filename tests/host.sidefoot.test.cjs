'use strict';
/**
 * Roadmap A1 — the sidebar foot plane's anchor is a claim about the HOST, so the host
 * has to be the one answering.
 *
 * What changed: `lib/client.js` used to address the left sidebar's footer / settings
 * surfaces with `.hHd-Xa_root .hHd-Xa_footArea, …` — a build hash. Two facts made that
 * a defect rather than a risk, both measured before this file existed:
 *
 *   1. npm `0.2.0-rc.1` and the official desktop shell (host `0.2.0-rc.2`) ship
 *      DIFFERENT bases for the same component, so the 「左侧栏底部断裂」 alignment never
 *      applied on the shell at all;
 *   2. `_footerActions` is used by MORE THAN ONE component, so the bare suffix form
 *      would reach the question card's footer too — the issue-L1 shape (our rule
 *      painting somebody else's surface).
 *
 * This file owns those two claims. The measurement functions are PURE (they take a
 * file list and a reader), so CI exercises the logic against synthetic corpora even on
 * a machine with no DSH installed — the discipline issue #102 and the 10.10.0 CI round
 * both established: "no host here" is a named skip, never a pass and never a failure.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');

/** The three anchors the shipped sheet uses, read back out of the bundle. */
function ourAnchors(source = SOURCE) {
	const pick = (name) => {
		const m = new RegExp(`const ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(source);
		if (!m) throw new Error(`${name} moved out of lib/client.js — the side-foot gate cannot name our anchor`);
		return m[1].replace(/\\"/g, '"');
	};
	return {
		foot: pick('SIDEBAR_FOOT_SELECTOR'),
		settings: pick('SIDEBAR_SETTINGS_SELECTOR'),
		actions: pick('SIDEBAR_FOOTER_ACTIONS_SELECTOR')
	};
}

const SUFFIXES = ['_footArea', '_settingsArea', '_footerActions'];

/**
 * Every class token in the corpus that ENDS with one of the family suffixes, grouped by
 * suffix and by its build-hash base. The `$`-anchored form matters: `_footerActions` is
 * the end of the token, while `_footAreaX` would be a different face entirely.
 */
function measureSideFoot(files, readFile, packageOf) {
	const bySuffix = {};
	for (const s of SUFFIXES) bySuffix[s] = {};
	for (const file of files) {
		let text;
		try { text = readFile(file); } catch { continue; }
		for (const m of text.matchAll(/\.?([\w-]+?)(_footArea|_settingsArea|_footerActions)(?![\w-])/g)) {
			const base = m[1];
			const suffix = m[2];
			if (!base) continue;
			const pkg = packageOf(file);
			const row = bySuffix[suffix][base] || (bySuffix[suffix][base] = { occurrences: 0, packages: new Set() });
			row.occurrences += 1;
			row.packages.add(pkg);
		}
	}
	const out = {};
	for (const s of SUFFIXES) {
		out[s] = Object.fromEntries(Object.entries(bySuffix[s]).map(([base, r]) => [base, {
			occurrences: r.occurrences,
			packages: [...r.packages].sort()
		}]));
	}
	return out;
}

/**
 * The nesting the descendant combinator depends on: the host renders
 * `footArea > { footerActions, settingsArea }`. Read from the host's own JSX rather than
 * assumed, because "we scoped it under the parent" is only true while the parent is the
 * parent. Looks for a className referencing `footArea` whose children array mentions both
 * nested keys before the block closes.
 */
function hostNestsFootAreas(text) {
	const keyOf = (name) => {
		const m = new RegExp(`"${name}":\\s*"([\\w-]+_${name})"`).exec(text);
		return m ? m[1] : null;
	};
	const foot = keyOf('footArea');
	if (!foot) return { found: false, reason: 'no footArea class token in the corpus' };
	const useIdx = text.indexOf('.footArea,');
	if (useIdx === -1) return { found: false, reason: 'footArea is declared but no JSX site names it' };
	// Read only the element's OWN children array, by bracket depth. A fixed-size lookahead
	// was the first version and it passed a flattened tree — the two keys appear a few
	// hundred characters later in unrelated code, and "in the window" is not "inside".
	const open = text.indexOf('children: [', useIdx);
	if (open === -1) return { found: false, reason: 'the footArea element names no children array' };
	let depth = 0;
	let end = open + 'children: ['.length;
	for (let i = open + 'children: '.length; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '[') depth += 1;
		else if (ch === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
	}
	const inner = text.slice(open, end + 1);
	return {
		found: true,
		footToken: foot,
		nested: {
			footerActions: /\.footerActions\b/.test(inner),
			settingsArea: /\.settingsArea\b/.test(inner)
		}
	};
}

/**
 * The gate. `measured` is what the corpus says, `anchors` is what we ship, `nesting` is
 * the host's own JSX reading, and `corpora` names which roots were actually read.
 */
function checkSideFoot({ measured, anchors, nesting, corpora }) {
	const problems = [];
	const notices = [];
	if (!Array.isArray(corpora) || corpora.length === 0) {
		return { problems: ['checkSideFoot needs the corpus list (which roots were read, which were absent)'], notices, counts: {} };
	}
	if (!measured || Object.keys(measured).length !== SUFFIXES.length) {
		return { problems: ['the side-foot measurement came back with the wrong shape — expected a row per suffix'], notices, counts: {} };
	}
	const read = corpora.filter((c) => c.exists);
	const absent = corpora.filter((c) => !c.exists);
	if (read.length === 0) {
		return { problems: ['every side-foot corpus is absent — that is a machine without the host, not a host without the face'], notices, counts: {} };
	}
	for (const s of SUFFIXES) {
		const bases = Object.keys(measured[s]);
		if (bases.length === 0) {
			// The face moved. Our suffix anchor now matches nothing, which is the silent
			// no-op this whole gate family exists to catch (issue #97 was exactly this).
			problems.push(`no class token in the corpus ends with ${s} — the anchor is dead, the surface renamed or gone`);
			continue;
		}
		if (s === '_footArea' && bases.length > 1) {
			problems.push(`${s} is drawn by ${bases.length} bases (${bases.join(', ')}): the landmark that scopes the other two is no longer unique, so ${anchors.foot} may reach a surface nobody looked at`);
		}
	}
	// `_footerActions` shared across components is EXPECTED and is the reason for scoping;
	// record it, but red the moment our own sheet stops scoping it. The test is whether the
	// anchor's OWN text keeps the `_footArea` ancestor — the scoped form
	// `[class$="_footArea"] [class$="_footerActions"]` contains the bare suffix too, so a
	// substring search for the bare form would call the shipped anchor "unscoped" (and did,
	// on the first run of this file).
	const actionBases = Object.keys(measured._footerActions || {});
	if (actionBases.length > 1 && !anchors.actions.includes('_footArea')) {
		problems.push(`_footerActions has ${actionBases.length} bases (${actionBases.join(', ')}) while our anchor is unscoped — this would restyle another component's footer`);
	}
	if (nesting && nesting.found && !(nesting.nested.footerActions && nesting.nested.settingsArea)) {
		problems.push(`the host no longer renders both nested surfaces inside footArea (footerActions=${nesting.nested.footerActions} settingsArea=${nesting.nested.settingsArea}) — the descendant combinator in our anchors describes a tree that is gone`);
	}
	if (absent.length) {
		// Named, printed, NOT a red — a machine without the desktop shell cannot re-verify
		// a claim measured on it (issue #102's two exits, applied to a corpus).
		notices.push(`NOT RE-VERIFIED here: ${absent.map((c) => `${c.kind} ${c.path}`).join(', ')} — re-measured: ${read.map((c) => `${c.kind}=${c.packages}`).join(', ') || '(nothing)'}`);
	}
	return {
		problems,
		notices,
		counts: Object.fromEntries(SUFFIXES.map((s) => [s, Object.keys(measured[s] || {}).length]))
	};
}

// ---------------------------------------------------------------------------
// host discovery — same candidate order as scripts/host-consumers.cjs
// ---------------------------------------------------------------------------

function hostRoot() {
	const usable = (c) => {
		// A directory is not a host. The 10.10.0 CI round learned this the hard way on the
		// wash gate: an empty or partial DSH_HOST_ROOT has to route to the SKIP exit, or
		// "this machine has no host" arrives as "the check failed". The sidebar package is
		// the one this file actually reads, so its presence is the honest test.
		try {
			return fs.statSync(path.join(c, 'dsh-client-ui-sidebar', 'lib', 'client.js')).isFile();
		} catch { return false; }
	};
	const cands = [];
	if (process.env.DSH_HOST_ROOT) cands.push(process.env.DSH_HOST_ROOT);
	const { execSync } = require('node:child_process');
	try {
		const g = execSync('npm root -g', { encoding: 'utf8', timeout: 30000 }).trim();
		cands.push(path.join(g, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
	} catch {}
	cands.push(path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'));
	return cands.find(usable) || null;
}

function listCodeFiles(root) {
	const out = [];
	const walk = (d, depth) => {
		if (depth > 6) return;
		let ents;
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) {
			const q = path.join(d, e.name);
			if (e.isDirectory()) { if (e.name !== 'node_modules') walk(q, depth + 1); }
			else if (/\.(css|js|mjs)$/.test(e.name)) out.push(q);
		}
	};
	walk(root, 0);
	return out;
}

// ---------------------------------------------------------------------------
// synthetic corpora — these run everywhere, including CI with no host installed
// ---------------------------------------------------------------------------

const pkg = (f) => f.split('/')[0];
const okNesting = { found: true, footToken: 'AAAA_footArea', nested: { footerActions: true, settingsArea: true } };

test('A1: the gate is green on a corpus where one base draws each surface and the host nests them', () => {
	const files = ['side/lib/client.js', 'side/lib/x.css'];
	const read = (f) => f.endsWith('.css')
		? '.hHd-Xa_footArea{padding:6px}.hHd-Xa_settingsArea{color:red}.hHd-Xa_footerActions{display:flex}'
		: '"footArea": "hHd-Xa_footArea", "footerActions": "hHd-Xa_footerActions"';
	const measured = measureSideFoot(files, read, pkg);
	const { problems } = checkSideFoot({ measured, anchors: ourAnchors(), nesting: okNesting, corpora: [{ kind: 'host', path: 'x', exists: true, packages: 2 }] });
	assert.deepEqual(problems, [], problems.join('; '));
});

test('A1 mutation: a second component drawing `_footArea` reddens it — the landmark is what scopes the other two', () => {
	const files = ['a/lib/x.css', 'b/lib/y.css'];
	const read = (f) => f.startsWith('a/')
		? '.hHd-Xa_footArea{padding:6px}.hHd-Xa_settingsArea{a}.hHd-Xa_footerActions{b}'
		: '.ZZzzzz_footArea{padding:1px}';
	const measured = measureSideFoot(files, read, pkg);
	const { problems } = checkSideFoot({ measured, anchors: ourAnchors(), nesting: okNesting, corpora: [{ kind: 'host', path: 'x', exists: true, packages: 2 }] });
	assert.equal(problems.length, 1, problems.join('; '));
	assert.ok(/no longer unique/.test(problems[0]), problems[0]);
});

test('A1 mutation: a host that renamed the whole family reddens it instead of filing a dead anchor as healthy', () => {
	const files = ['a/lib/x.css'];
	const measured = measureSideFoot(files, () => '.someOther_thing{color:red}', pkg);
	const { problems } = checkSideFoot({ measured, anchors: ourAnchors(), nesting: { found: false, reason: 'no footArea class token in the corpus' }, corpora: [{ kind: 'host', path: 'x', exists: true, packages: 1 }] });
	assert.equal(problems.length, SUFFIXES.length, `expected one problem per suffix, saw: ${problems.join('; ')}`);
	assert.ok(problems.every((p) => /ends with|renamed/.test(p)), problems.join('; '));
});

test('A1 mutation: an unscoped `_footerActions` against a shared suffix reddens it', () => {
	const files = ['q/lib/x.css', 'r/lib/y.css'];
	const read = (f) => f.startsWith('q/')
		? '.hHd-Xa_footArea{padding:6px}.hHd-Xa_settingsArea{a}.hHd-Xa_footerActions{display:flex}'
		: '.Mbwy4a_footerActions{display:grid}';
	const measured = measureSideFoot(files, read, pkg);
	// The anchors as they would be if someone dropped the scoping.
	const unscoped = { foot: '[class$="_footArea"]', settings: '[class$="_settingsArea"]', actions: '[class$="_footerActions"]' };
	const { problems } = checkSideFoot({ measured, anchors: unscoped, nesting: okNesting, corpora: [{ kind: 'host', path: 'x', exists: true, packages: 2 }] });
	assert.ok(problems.some((p) => /unscoped/.test(p)), problems.join('; '));
	// Control: the shipped, scoped form is green on the SAME corpus — so the red above is
	// about the scoping, not about the corpus being unusual.
	const control = checkSideFoot({ measured, anchors: ourAnchors(), nesting: okNesting, corpora: [{ kind: 'host', path: 'x', exists: true, packages: 2 }] });
	assert.deepEqual(control.problems, [], control.problems.join('; '));
});

test('A1 mutation: the host stops nesting the surfaces and the descendant combinator reddens', () => {
	const files = ['a/lib/x.css'];
	const read = () => '.hHd-Xa_footArea{padding:6px}.hHd-Xa_settingsArea{color:red}.hHd-Xa_footerActions{display:flex}';
	const measured = measureSideFoot(files, read, pkg);
	const { problems } = checkSideFoot({
		measured,
		anchors: ourAnchors(),
		nesting: { found: true, footToken: 'hHd-Xa_footArea', nested: { footerActions: false, settingsArea: true } },
		corpora: [{ kind: 'host', path: 'x', exists: true, packages: 1 }]
	});
	assert.ok(problems.some((p) => /descendant combinator/.test(p)), problems.join('; '));
});

test('A1: a corpus that is absent is a named notice, not a pass and not a failure', () => {
	const files = ['a/lib/x.css'];
	const measured = measureSideFoot(files, () => '.hHd-Xa_footArea{padding:6px}.hHd-Xa_settingsArea{a}.hHd-Xa_footerActions{b}', pkg);
	const { problems, notices } = checkSideFoot({
		measured,
		anchors: ourAnchors(),
		nesting: okNesting,
		corpora: [
			{ kind: 'host', path: 'x', exists: true, packages: 1 },
			{ kind: 'desktop-shell', path: 'C:/not/here/app.asar', exists: false }
		]
	});
	assert.deepEqual(problems, [], problems.join('; '));
	assert.equal(notices.length, 1, notices.join('; '));
	assert.ok(/NOT RE-VERIFIED here: desktop-shell/.test(notices[0]), notices[0]);
	// And the degenerate "nothing was read" case must be a RED, not a notice — that is the
	// distinction issue #102 exists for.
	const none = checkSideFoot({ measured, anchors: ourAnchors(), nesting: okNesting, corpora: [{ kind: 'host', path: 'x', exists: false }] });
	assert.equal(none.problems.length, 1);
	assert.ok(/machine without the host/.test(none.problems[0]), none.problems[0]);
});

test('A1: reading the nesting out of host JSX works on the real shape and refuses a flattened one', () => {
	const real = '"footArea": "hHd-Xa_footArea",\n"footerActions": "hHd-Xa_footerActions",\n"settingsArea": "hHd-Xa_settingsArea",\n\t\t\t\t\tclassName: SidebarRoot_module_css_default.footArea,\n\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("div", { className: SidebarRoot_module_css_default.footerActions }), (0, react_jsx_runtime.jsx)("div", { className: SidebarRoot_module_css_default.settingsArea })]';
	const r = hostNestsFootAreas(real);
	assert.equal(r.found, true, r.reason || 'found');
	assert.ok(r.nested.footerActions && r.nested.settingsArea, JSON.stringify(r.nested));
	const flattened = '"footArea": "hHd-Xa_footArea",\nclassName: SidebarRoot_module_css_default.footArea,\nchildren: []\nother: SidebarRoot_module_css_default.footerActions + SidebarRoot_module_css_default.settingsArea';
	const f = hostNestsFootAreas(flattened);
	assert.ok(!(f.nested.footerActions && f.nested.settingsArea), 'a flattened tree must not read as nested: ' + JSON.stringify(f.nested));
});

// ---------------------------------------------------------------------------
// the real corpus — named skip when this machine has no DSH installed
// ---------------------------------------------------------------------------

const ROOT = hostRoot();
const SKIP = ROOT ? false : 'no DSH host install readable here (set DSH_HOST_ROOT) — the synthetic legs above still ran';
const asarCandidates = [
	process.env.DSH_DESKTOP_ASAR,
	path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
].filter(Boolean);
const ASAR = asarCandidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;

test('A1: the installed host really draws each foot surface under exactly one base, and nests them', { skip: SKIP }, () => {
	const files = listCodeFiles(ROOT);
	assert.ok(files.length > 200, `the host corpus looks too small to be the install: ${files.length} files`);
	const anchors = ourAnchors();
	// Our own bundle must never enter the corpus it is checked against.
	const hostFiles = files.filter((f) => !/[\\/]dsh-dream-skin[\\/]/.test(f));
	const measured = measureSideFoot(hostFiles, (f) => fs.readFileSync(f, 'utf8'), (f) => path.relative(ROOT, f).split(/[\\/]/)[0]);
	const sidebarDir = path.join(ROOT, 'dsh-client-ui-sidebar', 'lib', 'client.js');
	const nesting = fs.existsSync(sidebarDir)
		? hostNestsFootAreas(fs.readFileSync(sidebarDir, 'utf8'))
		: { found: false, reason: 'dsh-client-ui-sidebar absent' };
	const corpora = [{ kind: 'host', path: ROOT, exists: true, packages: new Set(hostFiles.map((f) => path.relative(ROOT, f).split(/[\\/]/)[0])).size }];
	const { problems, notices, counts } = checkSideFoot({ measured, anchors, nesting, corpora });
	assert.deepEqual(problems, [], problems.join('\n'));
	assert.equal(counts._footArea, 1, 'the landmark must stay unique on the installed host');
	assert.ok(nesting.found, nesting.reason);
	for (const line of notices) console.log('side-foot: ' + line);
});

test('A1: the desktop shell ships a DIFFERENT base for the same surfaces — the claim behind the fix', { skip: ASAR ? false : 'no official desktop shell app.asar on this machine — the hash disagreement is a dated claim in docs/desktop-support.md, not re-measured here' }, () => {
	// Read the bytes the shell actually ships. This is the only evidence in this round
	// that does not come from this repository, which is the point (the 10.9.3 lesson:
	// cross-checks have to be external to be cross-checks).
	const text = fs.readFileSync(ASAR, 'latin1');
	const bases = new Set();
	for (const m of text.matchAll(/([\w-]+)_footArea(?![\w-])/g)) bases.add(m[1]);
	assert.ok(bases.size >= 1, 'the shell draws no `_footArea` at all — the surface is gone there, re-decide');
	const hostBases = new Set(Object.keys(measureSideFoot(
		listCodeFiles(ROOT).filter((f) => !/[\\/]dsh-dream-skin[\\/]/.test(f)),
		(f) => fs.readFileSync(f, 'utf8'),
		(f) => path.relative(ROOT, f).split(/[\\/]/)[0]
	)._footArea));
	assert.notDeepEqual([...bases].sort(), [...hostBases].sort(),
		'the shell and the npm install now share a base — the "never applied on the shell" finding needs re-reading before this sentence stays in the docs');
});
