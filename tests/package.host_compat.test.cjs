/**
 * dsh-dream-skin — host compatibility gate (issue #62).
 *
 * Since dsh 0.2.0-rc.1 the host refuses to load a profile bundle whose
 * `@deepseek-ai/dsh*` peer ranges don't include the running dsh version —
 * `dsh-app-boot`'s `evaluatePluginCompatibility()` skips the bundle entirely,
 * so the plugin vanishes with one log line: no client.js route, no
 * `/dream-skin/api`, no diagnostics global. The previous ranges
 * (`^0.1.0-rc.6`, plus `*` for the store) satisfied every 0.1.x runtime the
 * plugin was verified on and silently excluded 0.2.x, which is exactly the
 * "0.2.0-rc.1 不适配啦" report.
 *
 * The expected values here are NOT computed by this file: they are a fixture
 * captured by calling the real host checker
 * (`@deepseek-ai/dsh-app-boot@0.2.0-rc.1`, `evaluatePluginCompatibility`) over
 * a table of runtime versions, for both the pre-fix and the post-fix manifest.
 * This test re-derives the same verdicts with a dependency-free range
 * evaluator (the repo ships no node_modules) and requires agreement — so a
 * retyped range that re-breaks 0.2.x, or a widened range that stops being a
 * bounded claim, goes red against an independent witness rather than against
 * this file's own opinion.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'host_compat_verdicts.json'), 'utf8'));

// ── the shared evaluator: scripts/lib/peer-window.cjs, NOT a copy in this file ──
const {
	parse, cmp, comparatorSets, satisfies, satisfiesDefault, failingPeers, isGatePeer
} = require("../scripts/lib/peer-window.cjs");

const checkedPeers = () => Object.fromEntries(Object.entries(pkg.peerDependencies).filter(([name]) => isGatePeer(name)));

test('host gate: our peer ranges reproduce the verdicts the real dsh checker returned', () => {
	assert.ok(FIXTURE.table.length >= 6, 'fixture must cover several host generations');
	for (const row of FIXTURE.table) {
		assert.deepEqual(failingPeers(pkg.peerDependencies, row.runtime), row.after.peers, `verdict mismatch for dsh ${row.runtime}`);
	}
});

test('host gate: the shipped ranges accept the runtimes we verified on, and refuse the one we did not', () => {
	const peers = checkedPeers();
	assert.ok(Object.keys(peers).length >= 5, 'the dsh* peers the host checks must still be declared');
	for (const runtime of ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0']) {
		assert.deepEqual(failingPeers(peers, runtime), [], `dsh ${runtime} must load the plugin`);
	}
	// Boundedness, not a vacuous `*`: an unverified future major must be refused
	// outright, because the host's refusal is a precise actionable message while
	// a false "compatible" claim is a silent crash surface.
	assert.ok(failingPeers(peers, '0.3.0-rc.1').length > 0, 'ranges must not claim compatibility with an untested 0.3.x host');
});

test('host gate: the fixture records a real red (it is not an all-green self-confirmation)', () => {
	const at020 = FIXTURE.table.find((r) => r.runtime === '0.2.0-rc.1');
	assert.ok(at020, 'fixture must cover 0.2.0-rc.1');
	assert.equal(at020.before.ok, false, 'the pre-fix manifest must FAIL the host gate, else this fixture proves nothing');
	assert.equal(at020.after.ok, true, 'the post-fix manifest must pass the host gate');
	assert.notDeepEqual(failingPeers(pkg.peerDependencies, '0.2.0-rc.1'), at020.before.peers, 'package.json must not still carry the pre-fix ranges');
});

test('host gate: every host-checked peer stays optional (a required peer would break `npm install` for consumers)', () => {
	for (const name of Object.keys(checkedPeers())) {
		assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} must stay optional`);
	}
});

// ── the OTHER ruler (issue #91) ────────────────────────────────────────────
//
// Two rulers read `peerDependencies`, and they do not read the same names:
//
//   * the HOST gate (`evaluatePluginCompatibility`) skips everything that is
//     not `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` — so it never looks at
//     `@deepseek-ai/cordis` or `react`;
//   * npm/pnpm peer resolution reads ALL of them, with DEFAULT semver
//     semantics, where a prerelease may only satisfy a set that carries a
//     prerelease on the same major.minor.patch.
//
// #91 caught the consequence: the host moved its own cordis to
// `~4.0.5-alpha.1` in 0.2.1-alpha.1 while our peer stayed `^4.0.1`, so the
// declaration said "I do not support this" about a version nobody installs but
// our manifest. The review's own suggested fix (`">=4.0.1"`) does NOT cover
// `4.0.5-alpha.1` under default semantics — that is pinned below, because a
// reviewer's suggestion is a hypothesis until it is measured.

const PEER_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'peer_range_verdicts.json'), 'utf8'));

test('#91: our dependency-free evaluator reproduces the real semver, including the prerelease rule', () => {
	assert.ok(PEER_FIXTURE.table.length >= 100, 'the range fixture must cover a real spread of versions');
	for (const row of PEER_FIXTURE.table) {
		assert.equal(
			satisfies(row.version, row.range),
			row.includePrerelease,
			`includePrerelease verdict mismatch for ${row.version} in ${row.range}`
		);
		assert.equal(
			satisfiesDefault(row.version, row.range),
			row._default,
			`default-semantics verdict mismatch for ${row.version} in ${row.range}`
		);
	}
	// The two rulers really do disagree — otherwise the check above would only
	// be comparing one implementation with itself.
	assert.ok(
		PEER_FIXTURE.table.some((r) => r.includePrerelease !== r._default),
		'the fixture must contain at least one version the two semantics disagree about'
	);
});

test('#91: the cordis peer covers the host alpha channel, and stays bounded', () => {
	const range = pkg.peerDependencies['@deepseek-ai/cordis'];
	assert.ok(range, '@deepseek-ai/cordis must stay declared');
	// The three host cordis demands we know about: rc.1/rc.2 ask for ~4.0.4,
	// 0.2.1-alpha.1 asks for ~4.0.5-alpha.1.
	for (const version of ['4.0.4', '4.0.5', '4.0.5-alpha.1']) {
		assert.ok(satisfiesDefault(version, range), `cordis ${version} must satisfy ${range} — this is the whole point of #91`);
	}
	assert.ok(!satisfiesDefault('4.0.0', range), 'the range must still be a bounded claim about cordis 4.0.x, not a superset of everything');
	assert.ok(!satisfiesDefault('5.0.0', range), 'cordis 5 is untested and must be refused rather than silently claimed');
	// The ROW that matters: a plain `>=` does not do this job. If someone
	// "simplifies" the range to `>=4.0.1`, this is the assertion that stops it.
	assert.ok(!satisfiesDefault('4.0.5-alpha.1', '>=4.0.1'), 'default semver excludes the prerelease — this is why the range is what it is');
	assert.ok(satisfiesDefault('4.0.5-alpha.1', '^4.0.1 || >=4.0.5-0 <5'), 'the union is what covers both the release line and the alpha line');
	// react is the other peer the host gate ignores; it must stay a real claim.
	assert.ok(satisfiesDefault('18.2.0', pkg.peerDependencies.react), 'react 18.2.0 must be declared as supported');
	assert.ok(!satisfiesDefault('19.0.0', pkg.peerDependencies.react), 'react 19 is untested and must be refused');
});

test('#91: a reverted cordis range reddens this check (the check really reads cordis)', () => {
	// Mutation: the pre-fix range. The HOST gate is blind to it, which is
	// exactly why this file has a second ruler.
	assert.equal(satisfiesDefault('4.0.5-alpha.1', '^4.0.1'), false, 'the pre-fix range must FAIL under default semantics');
	// …and the host gate must still be blind to it, or the two tests are the
	// same test wearing two names.
	assert.deepEqual(failingPeers({ '@deepseek-ai/cordis': '^4.0.1' }, '0.2.1-alpha.1'), [], 'the host gate must ignore cordis entirely');
	assert.deepEqual(failingPeers({ '@deepseek-ai/dsh-client-ui-theme': '^0.1.0-rc.6' }, '0.2.1-alpha.1'), ['@deepseek-ai/dsh-client-ui-theme'], 'control: the host gate does read dsh* peers');
});

test('#91: both documents say which peers the host gate does NOT judge', () => {
	// The reading this guards against is documented in #91: README explains
	// that "the peer range is no longer decoration" (correct, for dsh*), and a
	// reader then assumes cordis and react are part of that judgement. They
	// are not — the host loop `continue`s on anything without the dsh prefix.
	const SENTENCE = '@deepseek-ai/dsh';
	const sites = ['README.md', 'docs/desktop-support.md'];
	for (const rel of sites) {
		const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
		const line = text.split('\n').find((l) => l.includes('不参与') && l.includes(SENTENCE));
		assert.ok(line, `${rel} must state plainly which peers the host gate does not judge (issue #91)`);
		assert.ok(line.includes('cordis') && line.includes('react'), `${rel}: the sentence must name cordis and react, got: ${line && line.slice(0, 120)}`);
	}
});

// Exported so the evaluator can be cross-checked against the host's own
// node-semver in a one-off (docs/publishing-to-npm.md); the fixtures above are
// what keep that cross-check honest across releases.
module.exports = { satisfies, satisfiesDefault, failingPeers, comparatorSets };
