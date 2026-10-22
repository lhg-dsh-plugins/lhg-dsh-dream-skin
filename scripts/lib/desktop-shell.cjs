/**
 * dsh-dream-skin — the OFFICIAL desktop shell's own bytes, read as a second corpus.
 *
 * Why this exists as a shared module: the shell and the npm install re-roll their CSS-module
 * hashes INDEPENDENTLY (measured: `uV2eYG_*` on npm `0.2.0-rc.1` vs `RlGAzG_*` in the shell's
 * `0.2.0-rc.2`, for the same `InputBar.module.css`). Any claim about "what replaced what" is
 * therefore only worth as much as the reading that produced it, and two test files reading the
 * same 121 MB bundle with two hand-written parsers is how such a claim quietly goes stale.
 *
 * The stable key across channels is the **CSS module path**, which the bundle embeds verbatim in
 * `//#region dsh-css:<abs path>` comments. Hashes roll; paths do not. So a successor is named as
 * (module path, class suffix) and re-derived here rather than pasted as a literal.
 *
 * Every function is read-only and returns `null` / an empty result when the shell is absent —
 * the CALLER decides between a named skip and a failure, because "this machine has no shell" and
 * "the check failed" are different facts (the lesson recorded twice in 10.10.0 and 10.11.0).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Where the official shell keeps its bundle. Env override first, then the installer default. */
function shellAsarCandidates(env = process.env) {
	return [
		env.DSH_DESKTOP_ASAR,
		path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
	].filter(Boolean);
}

/** The shell bundle if this machine has one, else null. */
function findShellAsar(env = process.env) {
	for (const p of shellAsarCandidates(env)) {
		try { if (fs.statSync(p).isFile()) return p; } catch { /* candidate absent */ }
	}
	return null;
}

let cachedPath = null;
let cachedText = null;

/** The bundle as a latin1 string (byte-exact for ASCII CSS). Cached per process. */
function readShellAsar() {
	const found = findShellAsar();
	if (!found) return null;
	if (cachedPath !== found || cachedText === null) {
		cachedText = fs.readFileSync(found).toString('latin1');
		cachedPath = found;
	}
	return cachedText;
}

/**
 * Every class base that draws the given suffix anywhere in the bundle.
 * `suffixesInShell(text, 'footArea')` → Set of bases, e.g. { '_2H3hWW' }.
 */
function suffixBasesInShell(text, suffix) {
	const out = new Set();
	if (!text) return out;
	const re = new RegExp('([\\w-]+)_' + suffix + '(?![\\w-])', 'g');
	let m;
	while ((m = re.exec(text))) out.add(m[1]);
	return out;
}

/**
 * The class tokens the shell draws for ONE CSS module, identified by the tail of its source
 * path (e.g. 'skeleton/InputBar.module.css'). Returns null when the module is not in the bundle.
 *
 * The region comment and its `const css$N = "..."` are adjacent in the bundle, so the scan window
 * is bounded by the NEXT `//#region` rather than by a guessed size — a fixed window silently
 * truncates a big module and would report a partial class set as if it were the whole thing.
 */
function moduleClassesInShell(text, moduleTail) {
	if (!text) return null;
	const needle = 'dsh-css:';
	let i = 0;
	while (true) {
		const at = text.indexOf(needle, i);
		if (at < 0) return null;
		const regionEnd = text.indexOf('\n', at);
		const header = text.slice(at, regionEnd);
		// The bundle embeds Windows paths with SINGLE backslashes; normalise before matching
		// so a caller can name a module by its POSIX-ish tail ('skeleton/InputBar.module.css').
		const norm = header.replace(/\\/g, '/');
		if (norm.includes(moduleTail)) {
			const body = text.slice(regionEnd, regionWindowEnd(text, regionEnd));
			const classes = new Set();
			let m;
			const re = /\.([\w-]+)_([\w-]+)(?![\w-])/g;
			while ((m = re.exec(body))) classes.add(m[1] + '_' + m[2]);
			const base = new Set();
			for (const c of classes) base.add(c.slice(0, c.indexOf('_')));
			return { header: norm.slice(needle.length, needle.length + 200), classes, bases: base };
		}
		i = regionEnd < 0 ? text.length : regionEnd;
	}
}

/** End of a module's region: the next `//#region`, or a bounded fallback when there is none. */
function regionWindowEnd(text, from) {
	const next = text.indexOf('//#region', from);
	return next >= 0 ? next : Math.min(from + 40000, text.length);
}

/**
 * The declaration block the shell writes for ONE class inside one module, or null.
 *
 * Used to check a claim of the form "losing our rule cannot change a pixel, because the host
 * declares nothing there" — which is only worth anything if someone reads the host's block
 * instead of asserting it. Returns the raw block text so the caller decides what to look for.
 */
function classRuleInShell(text, moduleTail, className) {
	if (!text) return null;
	const needle = 'dsh-css:';
	let i = 0;
	while (true) {
		const at = text.indexOf(needle, i);
		if (at < 0) return null;
		const regionEnd = text.indexOf('\n', at);
		const header = text.slice(at, regionEnd).replace(/\\/g, '/');
		i = regionEnd < 0 ? text.length : regionEnd;
		if (!header.includes(moduleTail)) continue;
		const body = text.slice(regionEnd, regionWindowEnd(text, regionEnd));
		const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const m = new RegExp('\\.' + escaped + '(?![\\w-])\\s*\\{([^{}]*)\\}').exec(body);
		if (m) return m[1];
	}
}

module.exports = {
	shellAsarCandidates,
	findShellAsar,
	readShellAsar,
	suffixBasesInShell,
	moduleClassesInShell,
	classRuleInShell
};
