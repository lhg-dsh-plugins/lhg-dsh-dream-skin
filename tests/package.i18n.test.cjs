/**
 * dsh-dream-skin — DSH plugin-list display metadata guard (PR #57).
 *
 * The host localises the plugin-list row (title / description / icon) from
 * `locale/*.json`, and reaches every one of those files through the package
 * `exports` map. An unrelated edit to package.json can break that with zero
 * coverage — the row silently loses its localised text and its icon. PR #57
 * added the locale files; this file is the canary that keeps them reachable.
 * It guards only the plugin-list metadata, not the 8-language settings
 * dictionary (registered at runtime in lib/client.js) or docs/i18n.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

// Display languages for the plugin list.
const DISPLAY_LOCALES = ['en', 'zh'];

function readMeta(locale) {
	const file = path.join(ROOT, 'locale', `${locale}.json`);
	assert.ok(
		fs.existsSync(file),
		`locale/${locale}.json must exist: without locale/en.json the host never reads any language file`
	);
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('i18n: every display locale ships a non-empty meta.title and meta.description', () => {
	for (const locale of DISPLAY_LOCALES) {
		const doc = readMeta(locale);
		assert.ok(doc.meta && typeof doc.meta === 'object', `locale/${locale}.json needs a "meta" object`);
		for (const key of ['title', 'description']) {
			const value = doc.meta[key];
			assert.equal(typeof value, 'string', `locale/${locale}.json meta.${key} must be a string`);
			assert.ok(
				value.trim().length > 0,
				`locale/${locale}.json meta.${key} must not be empty — an empty meta can blank the entry out on the other UI language`
			);
		}
	}
});

/**
 * What the host does, measured by calling `readPluginMeta()` on the installed
 * `@deepseek-ai/dsh` (boot 0.2.0-rc.1): 14 staged manifests + 11 filename probes
 * = 25 host calls, committed as `tests/fixtures/plugin_meta_readings.json`
 * (regenerate: `node scripts/gen-plugin-meta-readings.cjs`). The agreement test
 * below checks this file's mirror against that witness, not against my reading
 * of the host source.
 *
 *   - `locale/en.json` is resolved OPTIONALLY (`optionalResourcePath`), but
 *     "optional" only covers a MISSING resource: no English file, no export for
 *     it, or an export whose target is absent ⇒ no dictionaries, and the row
 *     falls back to manifest name/description without throwing. A target that is
 *     a DIRECTORY is not a missing resource — `ERR_UNSUPPORTED_DIR_IMPORT`
 *     propagates and the row loses everything (measured twice: on a secondary
 *     locale, and on English itself).
 *   - once English resolves, `dictionariesOf()` `readdir`s the directory and, per
 *     file, FIRST tests the stem against its own `LANGUAGE_ID` (rejected: `a`,
 *     `abcdefghi`, `e2`, `zh-CCCCCCCCC`, `zh_CN` — measured one stem at a time),
 *     THEN resolves it through the THROWING `resolvePluginResource`.
 *   - resolution happens per SUBPATH, so an `exports` entry that exists as a KEY
 *     but points somewhere unusable is fatal in four separately measured ways —
 *     and a model that reads only key names calls every one of them fine:
 *       target absent from the package      → `ERR_MODULE_NOT_FOUND`
 *       target in another directory         → "must share the English locale directory"
 *       target behind a `require` condition → `ERR_PACKAGE_PATH_NOT_EXPORTED`
 *       target explicitly `null`            → `ERR_PACKAGE_PATH_NOT_EXPORTED`
 *     That hole is `BLUE-10150` BL-01/BL-02: the first version of this mirror read
 *     only key names, and the review built a manifest that passed the gate 6/6
 *     while the host destroyed the row. `resolveTarget()` + `esmTarget()` + those
 *     four witness cases are the fix, not a comment telling people to be careful.
 *   - the manifest itself is read through `./package.json`, so dropping that
 *     export leaves the localised text and silently loses the icon
 *     (`package-json-export-removed`: `outcome: localized`, `hasIcon: false`).
 *   - an export KEY naming a file that is not on disk is never resolved (readdir
 *     drives the loop) — measured harmless, so that half of the enumeration is
 *     hygiene, not behaviour. Same for a wildcard: the host resolves through it happily.
 *   - NOT modelled, because it is not witnessable here: the duplicate-locale
 *     branch needs two filenames differing only in case (`EN.json` beside
 *     `en.json`), which a case-insensitive filesystem cannot hold.
 *
 * The reason the wildcard is gone at all is auditability, not a host bug: a
 * pattern is not enumerable by a human or automated source reviewer, which is
 * what the third-party catalog's report line said (DSH-Store #1411). Whether an
 * explicit list satisfies them is not something their policy text lets us claim —
 * CHANGELOG §四 refuses to promise it.
 *
 * SUPERSEDED (10.15.0): the assertion this replaced claimed "dropping the
 * ./locale/*.json pattern makes the host throw ERR_PACKAGE_PATH_NOT_EXPORTED".
 * Measured: that throw is not a host failure — the host catches it, and THIS row
 * degrades. 10.14.3 wrote the same wrong causality into shipped docs; the
 * correction is recorded in CHANGELOG, README and `docs/publishing-to-npm.md` §十一.
 */
function resolveTarget(exportsMap, key) {
	if (Object.prototype.hasOwnProperty.call(exportsMap || {}, key)) return { value: exportsMap[key], via: 'exact' };
	for (const pattern of Object.keys(exportsMap || {})) {
		const star = pattern.indexOf('*');
		if (star === -1) continue;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (!key.startsWith(prefix) || !key.slice(prefix.length).endsWith(suffix)) continue;
		const target = exportsMap[pattern];
		if (typeof target !== 'string' || target.indexOf('*') === -1) continue;
		return { value: target.replace('*', key.slice(prefix.length, key.length - suffix.length)), via: 'pattern' };
	}
	return { value: undefined, via: null };
}

// What Node's ESM resolution would hand back for that value: a bare string, or the
// first `default` / `import` condition. Anything else (`require`-only, `null`,
// absent) means the subpath is not exported to the host's loader.
function esmTarget(value) {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		for (const condition of ['default', 'import']) {
			if (typeof value[condition] === 'string') return value[condition];
		}
	}
	return null;
}

// Mirror of the host's `LANGUAGE_ID`, which `dictionariesOf()` applies to each
// filename stem BEFORE resolving anything. The witness' corpus bounds this
// pattern; this file's own opinion about the boundary is not evidence.
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const languageIdOk = (stem) => LANGUAGE_ID.test(stem);

const localePathOf = (target) => (target || '').replace(/^\.\//, '');
const dirOf = (rel) => rel.slice(0, rel.lastIndexOf('/') + 1);

/**
 * Mirror of the host's behaviour, validated case by case against the witness.
 * `staged` describes the package as it sits on disk (which relative paths are
 * files, which are directories); it defaults to "every listed locale is a file".
 * Returns what the plugin-list row looks like: 'localized', 'manifest-fallback'
 * or 'error' (title, description and icon gone together).
 */
function hostOutcome(diskFiles, exportsMap, staged = {}) {
	const files = new Set(staged.files || diskFiles.map((f) => `locale/${f}`));
	const dirs = new Set(staged.dirs || []);
	const resolve = (file) => {
		const found = resolveTarget(exportsMap, `./locale/${file}`);
		if (found.via === null) return { state: 'absent' };
		const target = esmTarget(found.value);
		if (target === null) return { state: 'unresolvable' };
		const rel = localePathOf(target);
		if (dirs.has(rel)) return { state: 'directory' };
		if (!files.has(rel)) return { state: 'missing' };
		return { state: 'ok', rel };
	};
	// English first: it is the gate for entering the directory loop at all, and
	// only a MISSING English resource degrades — a broken-but-present one throws.
	if (!diskFiles.includes('en.json')) return 'manifest-fallback';
	const english = resolve('en.json');
	if (english.state === 'absent' || english.state === 'missing') return 'manifest-fallback';
	if (english.state !== 'ok') return 'error';
	for (const file of diskFiles) {
		if (!languageIdOk(file.slice(0, -5))) return 'error';
		const here = resolve(file);
		if (here.state !== 'ok') return 'error';
		if (dirOf(here.rel) !== dirOf(english.rel)) return 'error';
	}
	return 'localized';
}

// The icon rides on a different export than the text, so it is modelled apart:
// the host reads the manifest (and therefore `icon`) through `./package.json`.
const iconResolvable = (exportsMap) => esmTarget(resolveTarget(exportsMap, './package.json').value) === './package.json';

/**
 * The audit-facing view: is the enumeration complete, explicit and identity-
 * mapped? Not every problem here is a host problem (the bullet above names the
 * hygiene half), but every host problem here has to be named.
 */
function localeProblems(diskFiles, exportsMap, staged = {}) {
	const problems = [];
	const files = new Set(staged.files || diskFiles.map((f) => `locale/${f}`));
	const dirs = new Set(staged.dirs || []);
	const declared = Object.keys(exportsMap || {}).filter((k) => k.startsWith('./locale/'));
	for (const key of declared.filter((k) => k.includes('*'))) {
		problems.push(`wildcard exports entry ${key} — the host resolves it fine, but a source reviewer cannot enumerate it`);
	}
	if (!iconResolvable(exportsMap)) {
		problems.push('exports must keep "./package.json": "./package.json" — the host reads the manifest through it, so without that entry the row keeps its text and silently loses its icon');
	}
	for (const file of diskFiles) {
		const key = `./locale/${file}`;
		if (!languageIdOk(file.slice(0, -5))) {
			problems.push(`locale/${file} is not a language id the host accepts — dictionariesOf() throws on the filename alone, and the row loses title, description and icon`);
			continue;
		}
		const found = resolveTarget(exportsMap, key);
		if (found.via === null) {
			problems.push(`locale/${file} exists but ${key} is not exported — ${file === 'en.json' ? 'the host silently drops all localisation' : 'the host throws ERR_PACKAGE_PATH_NOT_EXPORTED and the row loses title, description AND icon'}`);
			continue;
		}
		const target = esmTarget(found.value);
		if (target === null) {
			problems.push(`${key} has no ESM-resolvable target (${found.value === null ? 'null' : 'a conditions object without a default/import string'}) — the host sees the subpath as not exported and the row loses title, description and icon`);
			continue;
		}
		const rel = localePathOf(target);
		if (dirs.has(rel)) {
			problems.push(`${key} resolves to ${rel}, which is a DIRECTORY — the host throws ERR_UNSUPPORTED_DIR_IMPORT and the row loses title, description and icon`);
			continue;
		}
		if (!files.has(rel)) {
			problems.push(`${key} points at ${rel}, which is not in the package — the host throws ERR_MODULE_NOT_FOUND and the row loses title, description and icon`);
			continue;
		}
		if (rel !== `locale/${file}`) {
			problems.push(`${key} points at ${rel} instead of locale/${file} — the host requires every locale file to sit beside the English one ("must share the English locale directory")`);
		}
	}
	for (const key of declared) {
		if (key.includes('*')) continue;
		const name = key.slice('./locale/'.length);
		if (!diskFiles.includes(name)) problems.push(`${key} is exported but locale/${name} does not exist — hygiene only: readdir drives the host's loop, so it never resolves that entry`);
	}
	return problems;
}

// The staged package as the host will see it: which paths exist, which are
// directories. `locale/` is small and fixed, so reading it beats inferring shape
// from `exports` — inferring is exactly what this round had to retire.
function liveStaged() {
	const entries = fs.readdirSync(path.join(ROOT, 'locale'), { withFileTypes: true });
	return {
		files: entries.filter((e) => e.isFile()).map((e) => `locale/${e.name}`).concat(['package.json', 'icon.svg']).sort(),
		dirs: entries.filter((e) => e.isDirectory()).map((e) => `locale/${e.name}`).sort(),
	};
}

function loadWitness() {
	const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plugin_meta_readings.json'), 'utf8'));
	// The witness is only a witness if it says who measured it: a table without
	// provenance is indistinguishable from one typed by hand to agree with the
	// mirror. This does not make the file unforgeable — it makes forging a
	// deliberate act with a name on it, and keeps `BLUE-10150` BL-04 honest in
	// print rather than "solved".
	assert.match(
		String(fixture.generated_from || ''),
		/^@deepseek-ai\/dsh-app-boot readPluginMeta\(\) of @deepseek-ai\/dsh@\d+\.\d+\.\d+/,
		'the witness must record which host answered it, or it is not a witness'
	);
	assert.equal(fixture.generated_by, 'scripts/gen-plugin-meta-readings.cjs', 'the witness must name the generator that produced it');
	assert.ok(fs.existsSync(path.join(ROOT, fixture.generated_by)), `the witness names ${fixture.generated_by}, which is not in this repository`);
	assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 14, `the witness must keep every measured manifest shape, got ${fixture.cases && fixture.cases.length}`);
	assert.ok(Array.isArray(fixture.filenameCorpus) && fixture.filenameCorpus.length >= 8, 'the witness must carry a filename corpus, or the language-id branch is modelled from memory');
	return fixture;
}

test('i18n: every locale file on disk is exported by identity, and every export has a file', () => {
	const diskFiles = fs.readdirSync(path.join(ROOT, 'locale')).filter((f) => f.endsWith('.json')).sort();
	const staged = liveStaged();
	assert.deepEqual(diskFiles, DISPLAY_LOCALES.map((l) => `${l}.json`).sort(), 'the on-disk locale set drifted from DISPLAY_LOCALES — update both on purpose');
	assert.deepEqual(localeProblems(diskFiles, pkg.exports, staged), [], 'locale exports must be a complete, explicit, identity-mapped enumeration (see the host mechanism in the comment above)');
	assert.equal(hostOutcome(diskFiles, pkg.exports, staged), 'localized', 'the manifest must predict a localised plugin-list row, not a fallback or a throw');
	assert.deepEqual(staged.dirs, [], `every entry under locale/ must be a file — the host refuses to import a directory named *.json: ${staged.dirs.join(', ')}`);
	assert.ok(pkg.files.includes('locale'), 'locale/ must stay in the files allowlist or it never ships in the tarball');
});

test('i18n: the static mirror agrees with what the real host returned, case by case', () => {
	const fixture = loadWitness();
	for (const c of fixture.cases) {
		assert.equal(
			hostOutcome(c.disk, c.exports, c.staged), c.reading.outcome,
			`${c.id}: mirror predicts ${hostOutcome(c.disk, c.exports, c.staged)} but the host returned ${c.reading.outcome}${c.reading.errorCause ? ` (${c.reading.errorCause})` : ''} — the mirror or the witness is stale (regenerate with \`node scripts/gen-plugin-meta-readings.cjs\`)`
		);
		// The icon rides on a different export than the text, so it is compared apart.
		if (c.reading.outcome === 'localized' || c.reading.outcome === 'manifest-fallback') {
			assert.equal(iconResolvable(c.exports), c.reading.hasIcon, `${c.id}: mirror predicts icon=${iconResolvable(c.exports)} but the host reported hasIcon=${c.reading.hasIcon}`);
		}
	}
	// Not an all-green self-confirmation: the shapes that make a row silently die
	// have to stay in the witness, or agreement proves nothing.
	const outcomes = fixture.cases.map((c) => c.reading.outcome);
	const causes = fixture.cases.map((c) => c.reading.errorCause).filter(Boolean);
	assert.ok(outcomes.includes('error') && outcomes.includes('manifest-fallback'), 'the witness must keep both degradation shapes');
	for (const cause of ['not-exported', 'language-id', 'target-missing', 'cross-directory', 'directory-import']) {
		assert.ok(causes.includes(cause), `the witness must keep the "${cause}" shape — that is the branch the mirror would otherwise invent`);
	}
	// One case must be text-ok-but-icon-gone, or the two contracts merge back into one.
	assert.ok(
		fixture.cases.some((c) => c.reading.outcome === 'localized' && c.reading.hasIcon === false),
		'the witness must keep the package-json-export-removed shape: localised text with no icon'
	);
	// The real-tree row, and the risk of trusting a stale reading.
	const real = fixture.cases.find((c) => c.id === 'real-working-tree');
	assert.ok(real.reading.localized && real.reading.hasIcon, 'the host must have read a localised title/description and an icon from this package');
	const diskFiles = fs.readdirSync(path.join(ROOT, 'locale')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
	for (const lang of real.reading.languagesSeen) {
		assert.ok(lang === 'en' || diskFiles.includes(lang), `the witness saw locale "${lang}" which this repo no longer ships — the reading is stale`);
	}
});

test('i18n: the filename corpus bounds the mirror\'s own LANGUAGE_ID pattern', () => {
	const fixture = loadWitness();
	const corpus = fixture.filenameCorpus;
	const accepted = corpus.filter((r) => r.outcome === 'localized').map((r) => r.stem);
	const rejected = corpus.filter((r) => r.errorCause === 'language-id').map((r) => r.stem);
	assert.ok(accepted.length >= 3, `the corpus must contain accepted stems, got ${accepted.join(', ') || 'none'}`);
	assert.ok(rejected.length >= 3, `the corpus must contain rejected stems, got ${rejected.join(', ') || 'none'}`);
	for (const row of corpus) {
		assert.equal(
			languageIdOk(row.stem), row.outcome === 'localized',
			`${row.stem}: this file's LANGUAGE_ID mirror says ${languageIdOk(row.stem)}, the host said ${row.outcome}${row.errorCause ? ` (${row.errorCause})` : ''} — the mirror's pattern drifted from the host's, fix the mirror not the witness`
		);
		// Whole-shape replay: a corpus row is a manifest too, not just a stem.
		assert.equal(hostOutcome(row.disk, row.exports, row.staged), row.outcome, `${row.stem}: full manifest replay disagrees with the host`);
	}
	for (const stem of DISPLAY_LOCALES) {
		assert.ok(languageIdOk(stem), `display locale "${stem}" is not a filename the host accepts — every language file would throw`);
	}
	// Precedence, measured: a rejected filename next to an unexported English file
	// is a fallback, not a throw, because English gates the loop.
	const prec = fixture.cases.find((c) => c.id === 'bad-filename-with-english-not-exported');
	assert.ok(prec, 'the witness must keep the precedence case or the mirror\'s ordering is an assumption');
	assert.equal(hostOutcome(prec.disk, prec.exports, prec.staged), prec.reading.outcome, 'mirror must agree on which rule wins when both are broken');
});

test('mutation: the ways this invariant breaks each get named', () => {
	const disk = ['en.json', 'zh.json'];
	const staged = { files: ['icon.svg', 'locale/en.json', 'locale/zh.json', 'package.json'], dirs: [] };
	const identity = { './locale/en.json': './locale/en.json', './locale/zh.json': './locale/zh.json' };
	const withManifest = { './package.json': './package.json', ...identity };
	const named = (problems) => problems.join(' / ');
	const plus = (list, ...extra) => ({ ...list, files: list.files.concat(extra).sort() });

	// 1) a new locale file without an export — the silent-metadata-loss case
	const ja = plus(staged, 'locale/ja.json');
	assert.match(named(localeProblems([...disk, 'ja.json'], withManifest, ja)), /locale\/ja\.json exists but .* is not exported/);
	assert.equal(hostOutcome([...disk, 'ja.json'], withManifest, ja), 'error', 'an unexported non-English file must be predicted as a throw');
	// 2) English specifically — a different host shape: silent fallback, no throw
	const zhOnly = { './package.json': './package.json', './locale/zh.json': './locale/zh.json' };
	assert.match(named(localeProblems(disk, zhOnly, staged)), /locale\/en\.json exists but/);
	assert.equal(hostOutcome(disk, zhOnly, staged), 'manifest-fallback', 'losing the English export must be predicted as fallback, not an error');
	// 3) the key is intact, the target is not — BLUE-10150 BL-01's hole
	const dangling = { './package.json': './package.json', './locale/en.json': './locale/en.json', './locale/zh.json': './locale/gone.json' };
	assert.match(named(localeProblems(disk, dangling, staged)), /points at locale\/gone\.json, which is not in the package/);
	assert.equal(hostOutcome(disk, dangling, staged), 'error', 'a dangling target must be predicted as a throw — this is the shape a key-only model called fine');
	const retargeted = { ...withManifest, './locale/zh.json': './locale/legacy/zh.json' };
	const withLegacy = plus(staged, 'locale/legacy/zh.json');
	assert.match(named(localeProblems(disk, retargeted, withLegacy)), /instead of locale\/zh\.json/);
	assert.equal(hostOutcome(disk, retargeted, withLegacy), 'error', 'a locale file moved next to a subdirectory must be predicted as a throw');
	// 4) conditions and nulls: the key looks exported to anyone who stops at keys
	for (const [label, value] of [['a require-only condition', { require: './locale/zh.json' }], ['null', null]]) {
		const map = { './package.json': './package.json', './locale/en.json': './locale/en.json', './locale/zh.json': value };
		assert.match(named(localeProblems(disk, map, staged)), /no ESM-resolvable target/, label);
		assert.equal(hostOutcome(disk, map, staged), 'error', `${label} must be predicted as a throw`);
	}
	// 5) the icon contract, which is not the text contract
	assert.match(named(localeProblems(disk, identity, staged)), /"\.\/package\.json"/);
	assert.equal(iconResolvable(identity), false, 'the row keeps its text and loses its icon — the mirror must say so');
	assert.equal(hostOutcome(disk, identity, staged), 'localized', 'control: dropping ./package.json must NOT change the text verdict, or the two contracts are being conflated');
	// 6) a directory wearing a locale filename
	const dirStaged = { files: ['icon.svg', 'locale/en.json', 'package.json'], dirs: ['locale/fr.json'] };
	const dirMap = { './package.json': './package.json', './locale/en.json': './locale/en.json', './locale/fr.json': './locale/fr.json' };
	assert.match(named(localeProblems(['en.json', 'fr.json'], dirMap, dirStaged)), /which is a DIRECTORY/);
	assert.equal(hostOutcome(['en.json', 'fr.json'], dirMap, dirStaged), 'error', 'a directory import must be predicted as a throw');
	// 7) a filename the host will not accept, fully exported
	const badName = { ...withManifest, './locale/zh_CN.json': './locale/zh_CN.json' };
	const badNameStaged = plus(staged, 'locale/zh_CN.json');
	assert.match(named(localeProblems([...disk, 'zh_CN.json'], badName, badNameStaged)), /is not a language id the host accepts/);
	assert.equal(hostOutcome([...disk, 'zh_CN.json'], badName, badNameStaged), 'error', 'a rejected filename must be predicted as a throw even when every file is exported');
	// 8) an export left behind after a file was deleted — hygiene, measured harmless
	const stale = { ...withManifest, './locale/ko.json': './locale/ko.json' };
	assert.match(named(localeProblems(disk, stale, staged)), /ko\.json is exported but/);
	assert.equal(hostOutcome(disk, stale, staged), 'localized', 'control: a stale export is hygiene, the host genuinely does not see it — if this flips, the two views have been merged');
	// 9) going back to a wildcard: nothing is enumerable, so the gate names it
	const wild = { ...withManifest, './locale/*.json': './locale/*.json' };
	assert.match(named(localeProblems(disk, wild, staged)), /wildcard exports entry/);
	assert.equal(hostOutcome(disk, wild, staged), 'localized', 'the wildcard was never a host failure — this leg is what keeps that claim from being quietly rewritten');
	// control: the shipped manifest must be clean, or the legs above prove nothing
	assert.deepEqual(localeProblems(disk, withManifest, staged), [], 'control: an identity-mapped manifest must be clean');
	assert.deepEqual(localeProblems(fs.readdirSync(path.join(ROOT, 'locale')).filter((f) => f.endsWith('.json')).sort(), pkg.exports, liveStaged()), []);
});

test('i18n: display copy does not overclaim an instant effect (install needs a DSH restart)', () => {
	const zh = readMeta('zh');
	assert.ok(
		!/装完即生效|立即生效|无需重启|不用重启/.test(zh.meta.description),
		'restart is required after `dsh plugin add` — README says "装完重启 DSH Web 即生效", the plugin list must match'
	);
});
