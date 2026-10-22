/**
 * dsh-dream-skin — the AUDIT SURFACE gate (external issue DSH-Store#1411, 2026-10-15 comment).
 *
 * A third-party catalog kept this plugin out for one reason that survived the size question: the
 * browser half used to resolve host modules through `require(name)`, and a scanner — like a human
 * reader — cannot prove a FINITE CALLER SET for a closure that can be invoked with anything. No
 * argument about intent fixes that; only removing the value-carrying parameter does. The bundle now
 * writes every specifier as a string literal at its call site, so "which host modules can this
 * plugin even ask for" has an enumerated answer, and this file keeps that answer from rotting.
 *
 * Four rulers, deliberately different:
 *   - the bundle's own call sites (text; comment handling in `codePart` below);
 *   - the two tables in `docs/desktop-support.md` § 可审计能力面 — the seed list and the capability
 *     matrix — parsed the way `tests/docs.machine_readable.test.cjs` parses its tables. Nothing is
 *     transcribed into this file, so a hand-copied list cannot quietly become the truth;
 *   - `package.json` `peerDependencies` (what the host is told we may need), `lib/index.js`
 *     `API_PREFIX` (the route the host half actually registers), and the archived reviewer comment;
 *   - runtime observation: a require that records what the bundle ACTUALLY asks for on both host
 *     generations, and a fetch that records the destination it ACTUALLY used.
 *
 * Admission rules (CONTRIBUTING.md "测试准入规则") bind here: each leg is its own case so a first
 * failure cannot hide a second assertion; every enumeration leg carries a self-guard count, because
 * this round's own F1 experiment found one leg (the peer check) sailing through an empty scan
 * green; and each reversal was measured in an isolated copy tree with the red assertion printed
 * verbatim (CHANGELOG 10.16.0 §四).
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
	buildSandbox, makeRequire, makeApplyContext, releaseAllIntervals
} = require('./fixtures/page-sandbox.cjs');

after(releaseAllIntervals);

const ROOT = path.join(__dirname, '..');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const HOST = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'desktop-support.md'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EVIDENCE_REL_NPM = 'docs/evidence/dsh-store-1411-followup-2026-10-15.md';
const EVIDENCE = fs.readFileSync(path.join(ROOT, EVIDENCE_REL_NPM), 'utf8');

/** The code part of a line: comment markers drop the line; a leading inline block comment drops only itself. */
function codePart(line) {
	let s = line.trimStart();
	if (s.startsWith('//') || s.startsWith('*')) return '';
	const m = /^\/\*[\s\S]*?\*\//.exec(s);
	if (m) s = s.slice(m[0].length).trimStart();
	return s;
}

/** Comment lines (and a leading inline block comment) blanked out, offsets preserved. */
function stripComments(source) {
	return source.split('\n').map((line) => {
		const lead = line.slice(0, line.length - line.trimStart().length);
		const s = line.trimStart();
		if (s.startsWith('//') || s.startsWith('*')) return lead;
		const m = /^\/\*[\s\S]*?\*\//.exec(s);
		return m ? lead + s.slice(m[0].length) : line;
	}).join('\n');
}

/**
 * Every `callee(` the bundle can execute, with the text of its FIRST argument.
 *
 * Scans the whole file with paren/quote tracking rather than line by line, because `fetch(HOST_API, {`
 * puts its closing paren on a later line and a line-local scan silently drops exactly those calls —
 * measured (the fetch leg found nothing while the bundle had two call sites). Comment-only lines and
 * a leading inline block comment are blanked first, but code that follows a closed comment on the
 * same line is still scanned, which is what keeps a comment from hiding a call site (mutation G1).
 */
function callArgs(source, callee) {
	const src = stripComments(source);
	const needle = callee + '(';
	const out = [];
	let at = -1;
	while ((at = src.indexOf(needle, at + 1)) >= 0) {
		const prev = src[at - 1];
		if (prev && /[A-Za-z0-9_$.]/.test(prev)) continue;
		const open = at + needle.length;
		let depth = 1;
		let i = open;
		let quote = null;
		for (; i < src.length && depth > 0; i++) {
			const ch = src[i];
			if (quote !== null) {
				if (ch === '\\') i++;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === '`') quote = ch;
			else if (ch === '(') depth++;
			else if (ch === ')') depth--;
		}
		const argText = src.slice(open, depth === 0 ? i - 1 : src.length);
		out.push(argText.split(',')[0].replace(/\s+/g, ' ').trim());
	}
	return out;
}

/** Rows of a `### `-scoped table: first backticked cell plus the rest of the row. */
function sectionRows(headingPrefix) {
	const lines = DOC.split('\n');
	const from = lines.findIndex((l) => l.startsWith('### ' + headingPrefix));
	assert.ok(from >= 0, `docs/desktop-support.md must still carry the "### ${headingPrefix}" section`);
	let to = lines.length;
	for (let i = from + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ') || lines[i].startsWith('### ')) { to = i; break; }
	}
	const rows = [];
	for (const line of lines.slice(from, to)) {
		const m = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
		if (m) rows.push({ token: m[1], rest: m[2] });
	}
	return rows;
}

const isStringLiteral = (arg) => /^"(?:[^"\\]|\\.)*"$/.test(arg);
const unquote = (arg) => arg.slice(1, -1);
/** A module id, not a traversal: no dot segments, no empty segment, no leading slash. */
const MODULE_ID = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

/**
 * The capability vocabulary — and the honest boundary of this gate. What is checked is that the
 * document and the bundle agree about EVERY token named here; a capability nobody listed (a new Web
 * API) would have to be added to BOTH sides, and the matrix leg fails if the document grows a row
 * outside the vocabulary, so the pair cannot drift apart silently.
 */
const CAPABILITIES = [
	['require("…")', 'require('],
	['fetch(', 'fetch('],
	['localStorage', 'localStorage.setItem('],
	['new FileReader', 'new FileReader'],
	['type: "file"', 'type: "file"'],
	['URL.createObjectURL', 'URL.createObjectURL'],
	['a.download', '.download ='],
	['canvas.toDataURL', 'toDataURL('],
	['navigator.clipboard', 'navigator.clipboard'],
	['document.execCommand', 'document.execCommand'],
	['XMLHttpRequest', 'XMLHttpRequest'],
	['WebSocket', 'WebSocket'],
	['navigator.sendBeacon', 'sendBeacon'],
	['EventSource', 'EventSource'],
	['import(…)', 'import('],
	['eval(…)', 'eval('],
	['new Function', 'new Function'],
	['new Worker', 'new Worker'],
	['SharedWorker', 'SharedWorker'],
	['navigator.serviceWorker', 'serviceWorker'],
	['indexedDB.open', 'indexedDB.open'],
	['sessionStorage', 'sessionStorage'],
	['document.cookie', 'document.cookie']
];

test('audit surface: no value ever reaches require() in the browser half', () => {
	// The exact thing the catalog scanner said it could not prove. Reverting the fix reddens this
	// case; CHANGELOG 10.16.0 §四 records which legs each reversal reddens, so no case claims a red
	// it does not actually own.
	const args = callArgs(BUNDLE, 'require');
	const computed = args.filter((a) => !isStringLiteral(a));
	assert.deepEqual(computed, [],
		'every require() argument must be a string literal written at the call site — a computed specifier makes the caller set unprovable (DSH-Store#1411)');
	// Vacuity guard, deliberately AFTER the semantic one so each disease names itself: a scan that
	// stops matching would otherwise report "no non-literals found" about an empty list.
	assert.ok(args.length >= 4, `the scan must actually see the seed call sites, saw ${args.length}`);
	const specs = [...new Set(args.map(unquote))];
	assert.ok(specs.length >= 4, `at least the four documented seeds must be enumerable, saw ${specs.length}`);
	for (const s of specs) {
		assert.ok(s.length > 0, 'an empty specifier would be a scan hole, not a module');
		assert.match(s, MODULE_ID, `"${s}" is not a plain module id (no dot segments, no empty segment)`);
	}
});

test('audit surface: requireSeed is handed a thunk, never a name', () => {
	// The helper could keep its literal-only property while the CALLERS degrade it
	// (`requireSeed(seed)` from a loop) — the parameter is a value again then. Measured: under that
	// reversal this leg and the one above reddens together, and this one names the caller.
	const calls = [];
	for (const line of BUNDLE.split('\n')) {
		const code = codePart(line);
		if (code === '') continue;
		let at = -1;
		while ((at = code.indexOf('requireSeed(', at + 1)) >= 0) {
			calls.push(code.slice(at + 'requireSeed('.length).trim());
		}
	}
	assert.ok(calls.length >= 4, `all four seed call sites must be visible, saw ${calls.length}`);
	for (const raw of calls) {
		// Whitespace is folded first (round-3 R-6 lesson): a pin matched to an arrow function's exact
		// spaces reddens on a formatter run, and brittle gates get deleted.
		const arg = raw.replace(/\s+/g, ' ').trim();
		assert.ok(arg.startsWith('() => require('),
			`requireSeed() must be handed a zero-arg thunk that requires a LITERAL, got: ${arg.slice(0, 60)}`);
	}
});

test('audit surface: the documented seed table and the bundle call sites are the same list, in order', () => {
	// Two rulers over one fact, checked BOTH ways and ORDER-sensitively: candidate order is
	// behaviour (master seed first, stable seed second — issue #43).
	const docs = sectionRows('可审计能力面').map((r) => r.token);
	const code = [...new Set(callArgs(BUNDLE, 'require').map(unquote))];
	assert.ok(docs.length >= 4, `the document table must enumerate the seeds, found ${docs.length} rows`);
	assert.deepEqual(docs, code,
		'docs/desktop-support.md 可审计能力面 must list exactly the specifiers the bundle can require, in probe order');
});

test('audit surface: every seed the browser half asks for is a declared peer', () => {
	// Independent third source: the manifest the HOST reads. A specifier that is literal and
	// documented but undeclared is a plugin asking for a module nobody promised it.
	const peers = Object.keys(PKG.peerDependencies || {});
	assert.ok(peers.length >= 4, `peerDependencies must be present to check against, found ${peers.length}`);
	const args = callArgs(BUNDLE, 'require');
	const specs = [...new Set(args.filter(isStringLiteral).map(unquote))];
	// Same self-guard as the first case — this leg iterates a set, so an empty scan sailed through
	// it green before the guard existed (measured: F1).
	assert.equal(specs.length, args.length, 'every require() argument must be a literal for this leg to have anything to check');
	assert.ok(specs.length >= 4, `the peer leg must enumerate the seeds, saw ${specs.length} of ${args.length} call sites`);
	for (const spec of specs) {
		assert.match(spec, MODULE_ID, `"${spec}" must be a plain module id, not a path`);
		const covered = peers.some((p) => spec === p || spec.startsWith(p + '/'));
		assert.ok(covered, `"${spec}" is required by lib/client.js but covered by no peerDependency (${peers.join(', ')})`);
	}
});

test('audit surface: at runtime the bundle asks for exactly those seeds, and nothing else', () => {
	// The behavioural half. Text can be reworded; this is what the module actually does on boot,
	// sampled on BOTH host generations (store present, store missing).
	const askedBy = ({ storeMissing = false } = {}) => {
		const asked = [];
		const inner = makeRequire({ storeMissing });
		const h = buildSandbox({});
		const entry = h.factory((s) => { asked.push(s); return inner(s); });
		entry.apply(makeApplyContext(h));
		return asked;
	};
	const docs = sectionRows('可审计能力面').map((r) => r.token);
	const modern = askedBy({ storeMissing: false });
	const stable = askedBy({ storeMissing: true });
	assert.deepEqual(modern, docs.slice(0, 3),
		'a master-generation host must be asked for exactly jsx-runtime, react, dsh-client-store — in that order');
	assert.deepEqual(stable, docs,
		'a stable-generation host must additionally be asked for the fallback seed, and STILL for nothing outside the table');
	assert.deepEqual([...new Set(modern.concat(stable))], docs,
		'the two boots together must cover the documented table exactly — a seed nobody asks for is a stale row');
});

test('audit surface: every fetch call site uses the one constant, and that constant names the host route', () => {
	// The static half of "where can bytes from this page go". Measured reason it exists: making
	// HOST_API absolute reddens ONLY the runtime legs, and a future `fetch(userInput)` inside an
	// event handler would never run in a sandbox — so the call-site shape is pinned too, and the
	// route is cross-checked against the host half's own constant rather than against a copy.
	const args = callArgs(BUNDLE, 'fetch');
	assert.ok(args.length >= 1, 'the scan must actually see the fetch call sites');
	assert.deepEqual([...new Set(args)], ['HOST_API'],
		'every fetch() must be handed the HOST_API constant — a variable there is an open destination');
	const defs = BUNDLE.match(/const HOST_API = new URL\(([^,]+), document\.baseURI \|\| ([^)]+)\)\.pathname;/g) || [];
	assert.equal(defs.length, 1, `HOST_API must be defined exactly once in that shape, saw ${defs.length}`);
	const parts = /const HOST_API = new URL\(("([^"]+)"), document\.baseURI \|\| ("[^"]+")\)\.pathname;/.exec(defs[0]);
	assert.ok(parts, `HOST_API's two URL arguments must both be string literals, got: ${defs[0]}`);
	assert.ok(!/^[a-z]+:/.test(parts[2]) && !parts[2].startsWith('/'),
		`the URL spec must stay relative — an absolute or rooted spec could leave the page's own origin, got ${parts[2]}`);
	const hostPrefix = (HOST.match(/const API_PREFIX = "(\/[^"]+)";/) || [null, null])[1];
	assert.ok(hostPrefix, 'lib/index.js must still declare the API_PREFIX the browser half talks to');
	assert.equal('/' + parts[2], hostPrefix,
		'the browser half must target the route the host half registers (otherwise persistence silently degrades)');
});

test('audit surface: the destination observed at runtime carries no scheme and no authority', () => {
	// Two boots, two shapes of `document.baseURI`: one WITHOUT it (the sandbox default, where
	// HOST_API falls back to the literal) and one under a path prefix (a real deployment shape).
	// Both must yield a bare path — the claim under test is "cannot leave this page's origin", not
	// "the path is always exactly /dream-skin/api".
	const cases = [
		['no baseURI (fallback branch)', null, '/dream-skin/api'],
		['page under a path prefix', 'https://host.invalid/console/', '/console/dream-skin/api']
	];
	return (async () => {
		for (const [label, baseURI, expected] of cases) {
			const h = buildSandbox({});
			// HOST_API is computed when the FACTORY body runs, so the page's baseURI has to be set
			// before `h.factory(...)` — the fixture hands the document over through `window`.
			if (baseURI === null) delete h.window.document.baseURI; else h.window.document.baseURI = baseURI;
			const entry = h.factory(makeRequire());
			entry.apply(makeApplyContext(h));
			await new Promise((r) => setTimeout(r, 80));
			assert.ok(h.sent.urls.length >= 1, `${label}: the boot probe must actually reach fetch`);
			for (const url of h.sent.urls) {
				assert.ok(!url.includes('://'), `${label}: a fetch target must carry no scheme/authority, got ${url}`);
				const parsed = new URL(url, 'http://this-origin.invalid');
				assert.equal(parsed.hostname, 'this-origin.invalid',
					`${label}: the destination must stay on the page's own origin`);
				assert.equal(parsed.pathname, expected, `${label}: unexpected path for ${url}`);
			}
		}
	})();
});

test('audit surface: the capability matrix in the document agrees with the bundle, in both directions', () => {
	// "Real file/network capabilities" was the reviewer's OTHER open item. This leg is the answer:
	// every vocabulary token gets a verdict read off the bundle, and the document must state the
	// same verdict — no unlisted capability, no "不使用" that crept in, no row outside the list.
	const rows = sectionRows('页面侧能力矩阵');
	const byToken = new Map(rows.map((r) => [r.token, r]));
	assert.ok(byToken.size >= 15, `the matrix must be populated, found ${byToken.size} rows (self-guard against an empty scan)`);
	assert.equal(byToken.size, rows.length, 'the matrix must not repeat a token');
	const lines = BUNDLE.split('\n').map(codePart).filter((l) => l !== '');
	const present = (needle) => lines.some((l) => l.includes(needle));
	for (const [token, needle] of CAPABILITIES) {
		const row = byToken.get(token);
		assert.ok(row, `the capability matrix must carry a row for "${token}" (present in the bundle: ${present(needle)})`);
		const saysPresent = /^\s*存在/.test(row.rest);
		assert.equal(saysPresent, present(needle),
			`"${token}": the document says ${saysPresent ? '存在' : '不存在'} but the bundle says ${present(needle) ? '存在' : '不存在'}`);
	}
	for (const token of byToken.keys()) {
		assert.ok(CAPABILITIES.some(([t]) => t === token),
			`the matrix lists "${token}", which is not in the gate's vocabulary — the two lists drifted apart`);
	}
});

test('audit surface: what the catalog wrote is archived, byte-for-byte, and our summary cites it', () => {
	// This repository retires causal sentences that were only INFERRED (CHANGELOG 10.15.0), so the
	// external premise of THIS release ships as the reviewer's own text with a hash of it: silently
	// editing the archived block is a red, not a typo.
	const m = /```text\n([\s\S]*?)\n```/.exec(EVIDENCE);
	assert.ok(m, 'the evidence file must carry the comment body in a fenced ```text block');
	const body = m[1].replace(/\n+$/, '');
	const sha = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
	assert.ok(EVIDENCE.includes(sha),
		`the archived body's sha256 must be stated in the file (recomputed ${sha}) — otherwise the "原文未改动" claim has no witness`);
	for (const phrase of ['That diagnostic was incorrect', 'needs no minification or splitting', 'does not prove its finite caller set']) {
		assert.ok(body.includes(phrase), `the archived comment must carry "${phrase}" — three claims depend on it`);
	}
	assert.match(EVIDENCE, /comment id 6195702732/, 'the archive must name the comment it is a copy of');
	// The archive is cited FROM shipped documents (`docs/desktop-support.md` and
	// `docs/publishing-to-npm.md` are both in `files`), so the archive has to be in the tarball too
	// or an installed reader gets a dead path. Measured while writing this: whitelisting the whole
	// `docs/evidence` directory dragged in 590 kB of screenshots (24 → 33 files) and doubled the
	// tarball, which is the exact trade `docs/publishing-to-npm.md` §一 made in the other direction
	// for issue #83 — so the whitelist names the one file.
	const shipped = (PKG.files || []).some((entry) => entry === EVIDENCE_REL_NPM || EVIDENCE_REL_NPM.startsWith(entry.replace(/\/$/, '') + '/'));
	assert.ok(shipped,
		`the evidence archive must be listed in package.json "files" or every citation to it is a dead link in the published package (files: ${(PKG.files || []).join(', ')})`);
	const readers = [DOC, fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
		fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
		fs.readFileSync(path.join(ROOT, 'docs', 'publishing-to-npm.md'), 'utf8')];
	for (const doc of readers) {
		assert.ok(doc.includes('DSH-Store#1411'), 'each summary must cite the issue');
		if (/作废|收回|更正|withdrawn/.test(doc)) {
			assert.ok(doc.includes('dsh-store-1411-followup-2026-10-15'),
				'a document that says the report was withdrawn/corrected must point at the archived text that says so');
		}
	}
});
