/* Peer-range window, dependency-free.
 *
 * Two things live here, and neither is ours to invent:
 *
 *   - `satisfies()` mirrors the host boot gate: `@deepseek-ai/dsh` names only, `includePrerelease`
 *     semantics on (that is what dsh-app-boot passes to its own semver).
 *   - `satisfiesDefault()` is the OTHER ruler (issue #91) — what npm/pnpm peer resolution uses,
 *     which excludes a prerelease unless a comparator carries the same major.minor.patch.
 *
 * The verdicts are NOT trusted because this file wrote them: `tests/package.host_compat.test.cjs`
 * replays two fixtures captured from the host's own `evaluatePluginCompatibility()` and from the
 * host-shipped node-semver (276 rows) against this implementation, row by row. That is why the
 * release preflight (`scripts/host-preflight.cjs`) imports the evaluator from HERE instead of
 * carrying a second copy — two implementations is how a window drifts.
 */
"use strict";

const assert = require("node:assert");

/** Only these peer names feed the host gate (cordis and react are ignored by it). */
const isGatePeer = (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");

/** The peers the host actually gates on, from a parsed package.json. */
function gatePeers(manifest) {
	return Object.entries((manifest && manifest.peerDependencies) || {}).filter(([name]) => isGatePeer(name));
}

/** The window as the manifest states it — one range, or the window has become two. */
function gateRange(manifest) {
	const peers = gatePeers(manifest);
	if (!peers.length) throw new Error("the manifest declares no @deepseek-ai/dsh* peer, so the host gate cannot see it");
	const ranges = [...new Set(peers.map(([, range]) => range))];
	if (ranges.length !== 1) {
		throw new Error(`the gate peers must share ONE range, found ${ranges.length}: ${ranges.join(" | ")} — `
			+ "a peer with its own range is how the window silently becomes two windows");
	}
	return ranges[0];
}

function parse(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim());
	assert.ok(m, `unsupported version spelling in a range or fixture: ${JSON.stringify(v)}`);
	const pre = m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : null;
	return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

function cmp(a, b) {
	for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1;
	if (!a.pre && !b.pre) return 0;
	if (!a.pre) return 1; // a release outranks every prerelease of the same tuple
	if (!b.pre) return -1;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i], y = b.pre[i];
		if (x === undefined) return -1; // shorter prerelease list sorts first
		if (y === undefined) return 1;
		if (x === y) continue;
		if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1; // numeric < alphanumeric
		return x < y ? -1 : 1;
	}
	return 0;
}

function bump(target, op) {
	const [M, m, p] = target.n;
	const next = op === '^' ? (M > 0 ? [M + 1, 0, 0] : m > 0 ? [0, m + 1, 0] : [0, 0, p + 1]) : [M, m + 1, 0];
	return { n: next, pre: [0] };
}

/**
 * Materialise a range into OR-sets of `{op, target}` comparators, the way
 * node-semver's `parseRange` does (`^4.0.1` → `>=4.0.1 <5.0.0-0`, `5` →
 * `>=5.0.0 <6.0.0-0`). The materialised form is what the SECOND ruler below
 * needs: the default-semantics prerelease rule is defined on the comparator
 * list ("a prerelease may only satisfy a set if some comparator with the same
 * major.minor.patch ALSO carries a prerelease tag"), so it cannot be evaluated
 * comparator-by-comparator.
 *
 * The `includePrerelease` flag changes the desugaring itself, not just the
 * predicate: node-semver writes `-0` into the bounds it invents only when the
 * flag is on (`pr = options.includePrerelease ? '-0' : ''`), while the upper
 * bound of an expanded x-range carries `-0` either way. Getting that backwards
 * is exactly how `>=5` would start claiming `5.0.0-alpha.1`.
 */
function comparatorSets(range, includePrerelease = true) {
	const lower0 = () => ({ n: [0, 0, 0], pre: includePrerelease ? [0] : null });
	const pre = includePrerelease ? [0] : null;
	return range.split('||').map((set) =>
		set
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.flatMap((c) => {
				if (c === '*' || c === 'x' || c === 'latest') return [{ op: '>=', t: lower0() }];
				const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(c);
				assert.ok(m, `unsupported comparator in a peer range: ${JSON.stringify(c)}`);
				const op = m[1] || '=';
				const target = m[2];
				if (target.startsWith('^') || target.startsWith('~')) {
					const lower = parse(target.slice(1));
					return [{ op: '>=', t: lower }, { op: '<', t: bump(lower, target[0]) }];
				}
				assert.ok(op !== '^' && op !== '~', `unsupported comparator in a peer range: ${JSON.stringify(c)}`);
				if (/^[0-9x*]+(\.[0-9x*]+){0,2}$/.test(target)) {
					const bits = target.split('.');
					const num = (i, fb) => (/^[0-9]+$/.test(bits[i] || '') ? Number(bits[i]) : fb);
					const isx = (i) => bits[i] === undefined || bits[i] === 'x' || bits[i] === '*' || bits[i] === 'X';
					if (isx(0)) return [{ op: '>=', t: lower0() }];
					const lower = { n: [num(0, 0), num(1, 0), num(2, 0)], pre };
					if (op !== '=') return [{ op, t: lower }];
					if (isx(1)) return [{ op: '>=', t: lower }, { op: '<', t: { n: [lower.n[0] + 1, 0, 0], pre: [0] } }];
					if (isx(2)) return [{ op: '>=', t: lower }, { op: '<', t: { n: [lower.n[0], lower.n[1] + 1, 0], pre: [0] } }];
				}
				return [{ op, t: parse(target) }];
			})
	);
}

/**
 * `includePrerelease: true` — what the host's compatibility gate passes. Every
 * prerelease exclusion rule is off, so this reduces to plain ordering.
 */
function satisfies(version, range) {
	const v = parse(version);
	return comparatorSets(range, true).some((set) =>
		set.every(({ op, t }) => {
			const r = cmp(v, t);
			return op === '>=' ? r >= 0 : op === '<=' ? r <= 0 : op === '>' ? r > 0 : op === '<' ? r < 0 : r === 0;
		})
	);
}

/**
 * Default semver semantics — what npm/pnpm peer resolution uses. This is the
 * OTHER ruler (issue #91), and it is stricter in exactly one place: a version
 * carrying a prerelease tag may only satisfy a set if some comparator with the
 * same major.minor.patch also carries one. That single rule is why
 * `>=4.0.1` does NOT cover `4.0.5-alpha.1` — a distinction the review that
 * raised #91 got wrong in its own suggestion, so it is pinned here.
 */
function satisfiesDefault(version, range) {
	const v = parse(version);
	return comparatorSets(range, false).some((set) => {
		const inRange = set.every(({ op, t }) => {
			const r = cmp(v, t);
			return op === '>=' ? r >= 0 : op === '<=' ? r <= 0 : op === '>' ? r > 0 : op === '<' ? r < 0 : r === 0;
		});
		if (!inRange) return false;
		if (!v.pre) return true;
		return set.some(({ t }) => t.pre && t.n[0] === v.n[0] && t.n[1] === v.n[1] && t.n[2] === v.n[2]);
	});
}

function failingPeers(peers, runtime) {
	return Object.entries(peers).filter(([name, range]) => isGatePeer(name) && !satisfies(runtime, range)).map(([name]) => name).sort();
}

module.exports = {
	isGatePeer, gatePeers, gateRange, parse, cmp, bump, comparatorSets,
	satisfies, satisfiesDefault, failingPeers
};
