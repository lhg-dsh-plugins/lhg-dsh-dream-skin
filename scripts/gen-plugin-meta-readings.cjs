/**
 * Regenerate `tests/fixtures/plugin_meta_readings.json`.
 *
 * That fixture is the independent witness behind `tests/package.i18n.test.cjs`:
 * the gate models how the host reaches a plugin's display metadata, and the
 * witness records what the REAL host returned for the same manifests. Without it
 * the gate only agrees with itself.
 *
 * It therefore needs an installed `@deepseek-ai/dsh` to run, and refuses without
 * one: "no host on this machine" is an environment fact, not a pass. CI does not
 * run this script — it reads the committed fixture.
 *
 *   node scripts/gen-plugin-meta-readings.cjs [--host <path to @deepseek-ai/dsh>]
 *
 * `--host` / `DSH_HOST_PKG` are an OVERRIDE, not a hint: if it is given and does
 * not resolve, that is exit 2 rather than a silent fallthrough to a different
 * copy of the host (a mistyped override that "succeeds" is exactly the failure
 * mode `scripts/host-preflight.cjs` refuses).
 *
 * Every case is staged in a throwaway `node_modules` and read by the host itself.
 * Readings are reduced to SHAPE (outcome / throw cause / languagesSeen / hasIcon),
 * never copy text or blobs, so editing a locale string cannot stale-lock the table.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const HOST_PACKAGE = '@deepseek-ai/dsh';
const LIVE_MANIFEST = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PLUGIN_NAME = LIVE_MANIFEST().name;
const OUT = path.join(ROOT, 'tests', 'fixtures', 'plugin_meta_readings.json');

function findHost(explicit) {
	const override = explicit || process.env.DSH_HOST_PKG || null;
	const probe = (dir) => {
		const json = path.join(dir, 'package.json');
		if (!fs.existsSync(json)) return null;
		let manifest;
		try { manifest = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { return null; }
		if (manifest.name !== HOST_PACKAGE || !manifest.version) return null;
		// Resolve app-boot from the host's own tree: another copy on the machine
		// must not get to answer for the loader that will actually read us.
		let boot;
		try { boot = require.resolve('@deepseek-ai/dsh-app-boot', { paths: [dir] }); } catch { return null; }
		return { dshDir: dir, runtimeVersion: manifest.version, appBoot: boot };
	};
	if (override) {
		const hit = probe(override);
		if (hit) return hit;
		return { overrideFailure: override };
	}
	const globalRoots = [
		process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : null,
		'/usr/local/lib/node_modules',
		'/usr/lib/node_modules',
		process.env.HOME ? path.join(process.env.HOME, '.local/share/pnpm/global/5/node_modules') : null,
	].filter(Boolean);
	for (const root of globalRoots) {
		const hit = probe(path.join(root, '@deepseek-ai', 'dsh'));
		if (hit) return hit;
	}
	return null;
}

// `map` keys may be written as bare locale file names (`zh.json`) or as full
// subpaths (`./locale/zh.json`, `./locale/*.json`); both normalise to subpaths so
// no case can accidentally drop the prefix and stage a manifest with no locale
// exports at all (which the first draft of this file did, and which the
// refusal gate below then caught).
const subpathOf = (key) => (key.startsWith('./') ? key : `./locale/${key}`);
const EXP = (map, opts = {}) => Object.fromEntries([
	...(opts.withoutPackageJsonExport ? [] : [['./package.json', './package.json']]),
	...Object.entries(map).map(([k, v]) => [subpathOf(k), v]),
]);
const localeFiles = (bodies) => Object.fromEntries(Object.entries(bodies).map(([f, body]) => [f, body]));

/**
 * Stage one manifest variant and return its resolution base.
 *
 * `extra` is what makes the target-shape cases possible: the locale KEY can stay
 * intact while what it points at is dangling, in another directory, behind a
 * `require` condition, or is a DIRECTORY. The host dies on all four while a model
 * that only reads key names says `localized` — that is the hole the blue team
 * measured (`BLUE-10150` BL-01/BL-02/BL-07) and these cases are its witnesses.
 */
function stageFixture(name, exportsMap, localeBodies, extra = {}) {
	const dir = path.join(os.tmpdir(), 'ds-plugin-meta-fixture', name);
	fs.rmSync(dir, { recursive: true, force: true });
	const pkgDir = path.join(dir, 'node_modules', PLUGIN_NAME);
	fs.mkdirSync(path.join(pkgDir, 'locale'), { recursive: true });
	for (const [file, body] of Object.entries(localeBodies)) {
		if ((extra.dirs || []).includes(file)) {
			fs.mkdirSync(path.join(pkgDir, 'locale', file), { recursive: true });
			continue;
		}
		fs.writeFileSync(path.join(pkgDir, 'locale', file), JSON.stringify(body));
	}
	for (const rel of extra.extraFiles || []) {
		const target = path.join(pkgDir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ meta: { title: 'probe-retargeted', description: 'probe-retargeted-desc' } }));
	}
	if (!extra.withoutIcon) fs.writeFileSync(path.join(pkgDir, 'icon.svg'), iconBytes());
	const live = LIVE_MANIFEST();
	fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
		name: PLUGIN_NAME,
		version: '0.0.0-fixture',
		type: live.type,
		description: live.description,
		main: live.main,
		...(extra.withoutIcon ? {} : { icon: './icon.svg' }),
		exports: exportsMap,
	}, null, 2));
	fs.writeFileSync(path.join(dir, 'anchor.js'), '');
	return pathToFileURL(path.join(dir, 'anchor.js')).href;
}

function iconBytes() {
	return fs.readFileSync(path.join(ROOT, LIVE_MANIFEST().icon));
}

// Reduce a host reading to the facts the gate needs.
function classify(reading) {
	if (reading === undefined) return { outcome: 'absent' };
	if (typeof reading.error === 'string') {
		const subpath = reading.error.match(/Package subpath '([^']+)'/);
		const errorCause = /must use a language id/.test(reading.error) ? 'language-id'
			: /duplicates locale/.test(reading.error) ? 'duplicate-locale'
			: /must share the English locale directory/.test(reading.error) ? 'cross-directory'
			: /ERR_UNSUPPORTED_DIR_IMPORT/.test(reading.error) ? 'directory-import'
			: /ERR_INVALID_PACKAGE_TARGET/.test(reading.error) ? 'invalid-target'
			: /ERR_MODULE_NOT_FOUND/.test(reading.error) ? 'target-missing'
			: /not defined by "exports"/.test(reading.error) ? 'not-exported'
			: 'other';
		return {
			outcome: 'error',
			errorCode: /ERR_PACKAGE_PATH_NOT_EXPORTED/.test(reading.error) ? 'ERR_PACKAGE_PATH_NOT_EXPORTED'
				: /ERR_MODULE_NOT_FOUND/.test(reading.error) ? 'ERR_MODULE_NOT_FOUND'
				: /ERR_UNSUPPORTED_DIR_IMPORT/.test(reading.error) ? 'ERR_UNSUPPORTED_DIR_IMPORT'
				: /ERR_INVALID_PACKAGE_TARGET/.test(reading.error) ? 'ERR_INVALID_PACKAGE_TARGET'
				: 'other',
			errorCause,
			errorSubpath: subpath ? subpath[1] : null,
		};
	}
	const localized = typeof reading.title === 'object' && reading.title !== null;
	return {
		outcome: localized ? 'localized' : 'manifest-fallback',
		localized,
		languagesSeen: localized ? Object.keys(reading.title).sort() : ['<scalar>'],
		hasIcon: typeof reading.icon === 'string' && reading.icon.startsWith('data:image/'),
	};
}

const L = (t, d) => ({ meta: { title: t, description: d } });

async function main() {
	const host = findHost(process.argv[2] === '--host' ? process.argv[3] : undefined);
	if (host && host.overrideFailure) {
		console.error(
			`--host / DSH_HOST_PKG points at "${host.overrideFailure}", which is not an installed ${HOST_PACKAGE} whose tree resolves @deepseek-ai/dsh-app-boot. ` +
			'Treating an explicit override as a hint would let a mistyped path witness a DIFFERENT host, so this is exit 2 and nothing was written.'
		);
		process.exit(2);
	}
	if (!host) {
		console.error(
			`no installed ${HOST_PACKAGE} found (looked at --host, DSH_HOST_PKG, then the global npm/pnpm roots). ` +
			'The witness cannot be regenerated without the real host, and a mirror of our own making is not a witness. Nothing was written.'
		);
		process.exit(2);
	}
	const { readPluginMeta } = await import(pathToFileURL(host.appBoot).href);
	if (typeof readPluginMeta !== 'function') {
		console.error(`${HOST_PACKAGE}@${host.runtimeVersion} does not export readPluginMeta() — this host is too old to witness plugin metadata (needs 0.1.7-alpha.1+). Nothing was written.`);
		process.exit(2);
	}

	const liveManifest = LIVE_MANIFEST();
	const liveLocales = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'locale'))
		.filter((f) => f.endsWith('.json'))
		.map((f) => [f, JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', f), 'utf8'))]));
	const liveDisk = Object.keys(liveLocales).sort();
	const identity = Object.fromEntries(liveDisk.map((f) => [`./locale/${f}`, `./locale/${f}`]));
	// Synthetic locales carry distinct titles only; the fixture records shape,
	// so copy here is irrelevant — and must stay irrelevant.
	const probe = { 'en.json': L('probe-en', 'probe-en-desc'), 'zh.json': L('probe-zh', 'probe-zh-desc') };

	// The filename branch: the host validates each stem BEFORE resolving it, so
	// the boundary is measured stem by stem rather than copied out of a regex.
	// Not witnessable here: `duplicates locale` needs two filenames differing only
	// in case (`EN.json` beside `en.json`), which a case-insensitive filesystem
	// cannot hold — the fixture says so instead of pretending the branch ran.
	const CORPUS = ['ab', 'a', 'abcdefgh', 'abcdefghi', 'e2', 'zh-CN', 'zh-CNA', 'zh-CCCCCCCCC', 'zh_CN', 'zh-Hans-CN', 'en-US'];
	const filenameCorpus = CORPUS.map((stem) => {
		const exportsMap = EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/zh.json', [`${stem}.json`]: `./locale/${stem}.json` });
		const bodies = { ...probe, [`${stem}.json`]: L(`probe-${stem}`, 'probe-desc') };
		const disk = Object.keys(bodies).sort();
		const reading = classify(readPluginMeta(PLUGIN_NAME, stageFixture(`corpus-${stem}`, exportsMap, bodies)));
		return {
			stem,
			outcome: reading.outcome,
			errorCause: reading.errorCause || null,
			exports: exportsMap,
			disk,
			staged: { files: disk.map((f) => `locale/${f}`).concat(['package.json', 'icon.svg']).sort(), dirs: [] },
		};
	});

	const caseDefs = [
		{
			id: 'real-working-tree',
			note: 'this package as it ships: one identity export per locale file',
			exports: EXP(identity),
			disk: liveDisk,
			extra: {},
			localeBodies: liveLocales,
		},
		{
			id: 'wildcard-pattern',
			note: 'the form we dropped — recorded so nobody can rewrite it as a host bug',
			exports: EXP({ './locale/*.json': './locale/*.json' }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'locale-file-without-export',
			note: 'a language shipped without adding its export',
			exports: EXP(identity),
			disk: [...liveDisk, 'ja.json'].sort(),
			extra: {},
			localeBodies: { ...liveLocales, 'ja.json': L('probe-ja', 'probe-ja-desc') },
		},
		{
			id: 'english-not-exported',
			note: 'English is optional to the host, so nothing throws and localisation just stops',
			exports: EXP({ 'zh.json': './locale/zh.json' }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'filename-not-a-language-id',
			note: 'a fully exported locale file whose name is not a language id',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/zh.json', 'zh_CN.json': './locale/zh_CN.json' }),
			disk: ['en.json', 'zh.json', 'zh_CN.json'],
			extra: {},
			localeBodies: { ...probe, 'zh_CN.json': L('probe-zh-cn', 'probe-zh-cn-desc') },
		},
		{
			id: 'bad-filename-with-english-not-exported',
			note: 'precedence: English is checked before the loop is entered, so this degrades rather than throws',
			exports: EXP({ 'zh.json': './locale/zh.json', 'zh_CN.json': './locale/zh_CN.json' }),
			disk: ['en.json', 'zh.json', 'zh_CN.json'],
			extra: {},
			localeBodies: { ...probe, 'zh_CN.json': L('probe-zh-cn', 'probe-zh-cn-desc') },
		},
		// ── the target shapes: the export KEY is intact, the VALUE is not ─────────
		{
			id: 'export-target-dangling',
			note: 'key present, target path does not exist — ERR_MODULE_NOT_FOUND, and a key-only model says localized',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/gone.json' }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'export-target-cross-directory',
			note: 'target retargeted into a subdirectory — the host requires every locale beside the English one',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/legacy/zh.json' }),
			disk: ['en.json', 'zh.json'],
			extra: { extraFiles: ['locale/legacy/zh.json'] },
			localeBodies: probe,
		},
		{
			id: 'export-target-require-condition',
			note: 'value behind a require-only condition — the host resolves through ESM and sees nothing exported',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': { require: './locale/zh.json' } }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'export-target-null',
			note: 'value explicitly nulled — Node treats the subpath as not exported',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': null }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'locale-entry-is-a-directory',
			note: 'mkdir locale/fr.json while adding a language — ERR_UNSUPPORTED_DIR_IMPORT',
			exports: EXP({ 'en.json': './locale/en.json', 'fr.json': './locale/fr.json' }),
			disk: ['en.json', 'fr.json'],
			extra: { dirs: ['fr.json'] },
			localeBodies: { 'en.json': probe['en.json'], 'fr.json': L('probe-fr', 'probe-fr-desc') },
		},
		{
			id: 'english-entry-is-a-directory',
			note: 'the same shape but on the English file, which the host resolves OPTIONALLY — does the swallow cover it?',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/zh.json' }),
			disk: ['en.json', 'zh.json'],
			extra: { dirs: ['en.json'] },
			localeBodies: { ...probe },
		},
		{
			id: 'export-key-without-file',
			note: 'a stale export pointing at nothing: readdir never sees that name, so the host cannot notice it',
			exports: EXP({ 'en.json': './locale/en.json', 'zh.json': './locale/zh.json', 'ko.json': './locale/ko.json' }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
		{
			id: 'package-json-export-removed',
			note: 'the row keeps its text but loses its icon: the host reads the manifest through ./package.json',
			exports: EXP(identity, { withoutPackageJsonExport: true }),
			disk: ['en.json', 'zh.json'],
			extra: {},
			localeBodies: probe,
		},
	];

	const cases = caseDefs.map((c) => {
		// Record the staged filesystem shape alongside the manifest, so the gate can
		// replay the host's resolution instead of guessing which paths existed.
		const stagedDirs = (c.extra.dirs || []).map((f) => `locale/${f}`);
		const stagedFiles = Object.keys(c.localeBodies)
			.filter((f) => !(c.extra.dirs || []).includes(f))
			.map((f) => `locale/${f}`)
			.concat((c.extra.extraFiles || []).map((rel) => rel.replace(/\\/g, '/')))
			.concat(['package.json', 'icon.svg']);
		return {
			id: c.id,
			note: c.note,
			exports: c.exports,
			disk: c.disk,
			staged: { files: stagedFiles.sort(), dirs: stagedDirs.sort() },
			reading: classify(readPluginMeta(PLUGIN_NAME, stageFixture(c.id, c.exports, localeFiles(c.localeBodies), c.extra))),
		};
	});

	const outcome = cases.map((c) => c.reading.outcome);
	const causes = cases.map((c) => c.reading.errorCause).filter(Boolean);
	const required = ['not-exported', 'language-id', 'target-missing', 'cross-directory', 'directory-import'];
	const missing = required.filter((r) => !causes.includes(r));
	if (missing.length || !outcome.includes('error') || !outcome.includes('manifest-fallback')) {
		console.error(
			`the witness did not produce every shape the gate models (outcomes: ${outcome.join(', ')}; causes: ${causes.join(', ')}; missing: ${missing.join(', ') || 'none'}) ` +
			'— refusing to write a fixture that cannot disagree with the gate'
		);
		process.exit(1);
	}
	const accepted = filenameCorpus.filter((r) => r.outcome === 'localized').map((r) => r.stem);
	const rejected = filenameCorpus.filter((r) => r.errorCause === 'language-id').map((r) => r.stem);
	if (accepted.length === 0 || rejected.length === 0) {
		console.error(`the filename corpus must contain both accepted and rejected stems (accepted: ${accepted.join(',') || 'none'}; rejected: ${rejected.join(',') || 'none'}) — a one-sided corpus cannot bound a rule`);
		process.exit(1);
	}

	const fixture = {
		generated_from: `@deepseek-ai/dsh-app-boot readPluginMeta() of ${HOST_PACKAGE}@${host.runtimeVersion}`,
		generated_by: 'scripts/gen-plugin-meta-readings.cjs',
		plugin: PLUGIN_NAME,
		generated_at: new Date().toISOString(),
		host_calls: cases.length + filenameCorpus.length,
		note: 'each case is staged in a throwaway node_modules and read by the host itself; readings are reduced to shape (outcome / errorCause / languagesSeen / hasIcon), never copy text or blobs',
		cases,
		filenameCorpus,
		filenameCorpusNote: 'one probe file at a time, always alongside a valid exported en.json, so the verdict isolates the filename rule; the duplicate-locale branch needs two filenames differing only in case and is unreachable on a case-insensitive filesystem',
	};
	fs.writeFileSync(OUT, JSON.stringify(fixture, null, '\t') + '\n');

	for (const c of cases) {
		console.log(`${c.id.padEnd(36)} → ${c.reading.outcome}${c.reading.errorCause ? ` (${c.reading.errorCause})` : ''}${c.reading.localized === false ? ' [no throw]' : ''}`);
	}
	console.log(`corpus: accepted [${accepted.join(', ')}] rejected [${rejected.join(', ')}]`);
	console.log(`wrote ${path.relative(ROOT, OUT)}: ${cases.length} manifest cases + ${filenameCorpus.length} filename probes = ${fixture.host_calls} host calls, from ${HOST_PACKAGE}@${host.runtimeVersion}`);
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
