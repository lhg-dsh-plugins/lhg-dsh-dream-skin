/* Roadmap A (S) — the host release preflight, as one command instead of a ritual.
 *
 * The failure this exists to catch is issue #62, and it is a TIMING failure, not a knowledge
 * failure: since dsh 0.2.0-rc.1 the host's boot stage reads this plugin's `@deepseek-ai/dsh*`
 * peer ranges and skips the whole bundle when one does not include the running version. The host
 * publishes rc/alpha trains continuously, so "is today's newest host inside the window we
 * promise?" is a question that goes stale on its own — and until now answering it meant a human
 * remembering to ask. That is the whole of this script: it asks, prints the table, and can fail.
 *
 * FOUR things it deliberately does not do:
 *
 *   1. It does not trust its own arithmetic where the host is installed. The verdict comes from
 *      the host's OWN `evaluatePluginCompatibility()` when an install is present, and the
 *      dependency-free mirror in `scripts/lib/peer-window.cjs` is only the fallback — and the
 *      fallback is PRINTED as the source, because a table whose author is unknown grades nothing.
 *      When both are available the script requires them to agree on every candidate: a mirror
 *      that has drifted from the host is a broken preflight, not a second opinion.
 *   2. It never writes anything. `--profile-load` calls `loadProfileDirectory()`, which the host
 *      documents as skipping incompatible bundles "without changing the manifest"; the sibling
 *      `loadProfile()` DOES write, which is why this file must never call it.
 *   3. No exemptions are fed to the evaluator. The question is "would a clean install load", not
 *      "does this machine happen to carry a `compatibility.json` key pinned to one exact version".
 *   4. "Environment missing" and "the check failed" are separate exits (issue #102, same shape as
 *      `scripts/wash-cascade.cjs`): 3 names the missing piece, 1 names the version. Strict mode —
 *      the release-runbook form — turns a skip into 4 naming it. Never into green.
 *
 *   0 ran and agrees · 1 ran and disagrees · 3 could not run · 4 strict + could not run
 *
 * Usage:
 *   npm run host:preflight                          # newest published host vs our window
 *   npm run host:preflight -- --profile-load        # also load a real profile, read skippedBundles
 *   npm run host:preflight -- --packument f.json    # offline / CI: judge a captured packument
 *   DSH_PREFLIGHT_STRICT=1 npm run host:preflight   # release-day form: a skip is a failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOST_PACKAGE = "@deepseek-ai/dsh";
const OUR_NAME = require(path.join(ROOT, "package.json")).name;

const { satisfies, gateRange, gatePeers, parse, cmp } = require("./lib/peer-window.cjs");

function environmentError(message, piece) {
	const err = new Error(message);
	err.environment = true;
	if (piece) err.piece = piece;
	return err;
}

/** Same truthy spellings as the wash gate — `0` must never turn a runbook red. */
function strictRequested(env) {
	return /^(1|true|yes|on)$/i.test(String((env || process.env).DSH_PREFLIGHT_STRICT || "").trim());
}

function toFileUrl(p) {
	const resolved = path.resolve(p).replace(/\\/g, "/");
	return "file:///" + (/^[A-Za-z]:/.test(resolved) ? resolved : resolved.replace(/^\//, ""));
}

// ───────────────────────────── the inputs ─────────────────────────────────

/**
 * The installed host, when there is one: the path to its boot module, its own runtime version,
 * and the anchor `loadProfileDirectory()` wants. Resolved from the `dsh` the operator actually
 * runs, so the preflight judges the host that will judge the plugin — never a remembered path.
 */
function findHost(env) {
	const candidates = [];
	const override = (env || process.env).DSH_HOST_PKG;
	if (override) candidates.push(override);
	const globalRoots = [
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null,
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		process.env.HOME ? path.join(process.env.HOME, ".local/share/pnpm/global/5/node_modules") : null
	].filter((p) => p && p.length > 4);
	for (const root of globalRoots) candidates.push(path.join(root, "@deepseek-ai", "dsh"));
	for (const dir of candidates) {
		const json = path.join(dir, "package.json");
		if (!fs.existsSync(json)) continue;
		let manifest;
		try { manifest = JSON.parse(fs.readFileSync(json, "utf8")); } catch { continue; }
		if (manifest.name !== HOST_PACKAGE || !manifest.version) continue;
		// Resolve app-boot from the HOST's own tree: a second copy elsewhere on the machine
		// must not get to answer for the gate that will load (or skip) us.
		let boot;
		try { boot = require.resolve("@deepseek-ai/dsh-app-boot", { paths: [dir] }); } catch { continue; }
		return { dshDir: dir, dshPackageJson: json, runtimeVersion: manifest.version, appBoot: boot };
	}
	throw environmentError(
		`no installed ${HOST_PACKAGE} to read the host's own evaluator from (looked at DSH_HOST_PKG, then the global npm/pnpm roots: ${candidates.join(", ")})`
		+ " — the table can still be built from the mirror, so this is a missing piece, not a verdict",
		"host install");
}

/**
 * The registry's published host versions. `--packument` (a saved `npm view --json` answer) is the
 * offline and CI path; the spawn is the release-day path. A registry that will not answer is an
 * ENVIRONMENT fact — this repository judges its network paths separately, and a machine without a
 * proxy is not a plugin that became incompatible.
 */
function readPackument(opts) {
	if (opts.packument) {
		let data;
		try { data = JSON.parse(fs.readFileSync(opts.packument, "utf8")); }
		catch (e) { throw new Error(`--packument ${opts.packument} could not be read as a packument: ${e.message.split("\n")[0]}`); }
		return { data, source: `file:${opts.packument}` };
	}
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	// Windows resolves `npm.cmd` only through a shell; without this the preflight would report "the
	// registry could not be asked" on every Windows machine — one of our bugs dressed up as an
	// environment fact. The shell form gets ONE string, not an argv array: passing args alongside
	// `shell: true` is Node's DEP0190 (arguments are concatenated, not escaped), and nothing here
	// is operator-controlled except the constant package name below — which is still quoted.
	const run = opts.spawn || ((cmd, args) => spawnSync(
		process.platform === "win32" ? `${cmd} ${args.map((a) => `"${a}"`).join(" ")}` : cmd,
		process.platform === "win32" ? [] : args,
		{
			encoding: "utf8",
			timeout: opts.timeout || 180000,
			maxBuffer: 64 * 1024 * 1024,
			shell: process.platform === "win32"
		}
	));
	let res;
	try { res = run(npmCmd, ["view", HOST_PACKAGE, "--json"]); }
	catch (e) {
		throw environmentError(`the registry could not be asked (${String(e.message || e).split("\n")[0]}) — pass --packument <file> to judge a captured answer`, "registry");
	}
	if (!res || res.status !== 0 || !res.stdout) {
		const why = String((res && (res.stderr || (res.error && res.error.message))) || `exit ${res && res.status}`).split("\n")[0];
		throw environmentError(`the registry could not be asked for ${HOST_PACKAGE} (${why})`
			+ " — ECONNRESET / proxy-off / offline are this machine's facts, not the plugin's; pass --packument <file>", "registry");
	}
	let data;
	try { data = JSON.parse(res.stdout); }
	catch (e) { throw new Error(`npm view answered something that is not a packument for ${HOST_PACKAGE}: ${e.message.split("\n")[0]}`); }
	return { data, source: "registry" };
}

// ───────────────────────────── the judgment ───────────────────────────────

/**
 * The table, as a pure function: `evaluate(version)` answers the way the host does (`undefined`
 * = the bundle would load; an object with `peers` = it would be skipped), and `mirror` is the
 * dependency-free ruler used both as the fallback and, when the host answered, as the thing that
 * must agree with it.
 */
function buildTable({ packument, range, evaluate, mirror, limit = 12 }) {
	const problems = [];
	// `npm view <pkg> --json` answers with `versions` as an ARRAY of version strings, while the
	// registry's own packument answers with it as an OBJECT keyed by version. Both are real inputs
	// to this function (one from the live path, one from a saved packument), and reading the array
	// with Object.keys would hand back ["0","1","2"…] — a table of indices that still prints
	// numbers and still "judges", which is the worst kind of green.
	const raw = packument && packument.versions;
	const versions = Array.isArray(raw) ? raw.slice() : Object.keys(raw || {});
	const time = (packument && packument.time) || {};
	if (!versions.length) {
		return { rows: [], problems: ["preflight could not run: this packument carries no versions at all — a table with no candidates proves nothing"], summary: null };
	}
	const rows = versions.map((version) => {
		let verdict;
		try { verdict = evaluate(version); }
		catch (e) { throw new Error(`the evaluator could not judge ${version}: ${e.message.split("\n")[0]}`); }
		const peers = verdict && verdict.peers ? Object.keys(verdict.peers) : [];
		const ok = peers.length === 0;
		const row = { version, publishedAt: time[version] || null, ok, peers: peers.sort(), exempted: !!(verdict && verdict.exempted) };
		if (mirror) {
			// Two rulers, one question. Agreement is required, because on a machine with no host —
			// CI, a contributor laptop — the mirror is the ONLY ruler, and a mirror that has drifted
			// from the host would be quietly grading release tables nobody checked.
			const mine = satisfies(version, range);
			row.mirror = mine;
			if (mine !== ok) {
				problems.push(`the mirror and the host DISAGREE about ${version} (mirror ${mine}, host ${ok})`
					+ " — regenerate tests/fixtures/host_compat_verdicts.json against the real evaluator before trusting any table printed here");
			}
		}
		return row;
	});

	// "Newest" means newest BY PUBLISH STAMP, because that is what a person installing today gets.
	// Falling back to version order has to be said out loud: `0.2.1-alpha.9` can be published
	// before `0.2.0` and a silent sort by tuple would then call the wrong row the newest.
	const stamped = rows.filter((r) => r.publishedAt);
	let newest = null;
	if (stamped.length === rows.length) {
		newest = stamped.slice().sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : cmp(parse(a.version), parse(b.version))))[rows.length - 1];
	} else if (rows.length) {
		newest = rows.slice().sort((a, b) => cmp(parse(a.version), parse(b.version)))[rows.length - 1];
		problems.push(`preflight could not rank by publish date (${rows.length - stamped.length} of ${rows.length} versions carry no time stamp) and fell back to version order`
			+ " — read the printed date column before treating the row above as \"today's host\"");
	}

	const tags = (packument && packument["dist-tags"]) || {};
	const latest = tags.latest;
	const latestRow = latest ? rows.find((r) => r.version === latest) : null;
	if (latest && !latestRow) {
		problems.push(`dist-tags.latest says ${latest} but the version list has no such entry — the registry answer is internally inconsistent; re-read it instead of judging this one`);
	}

	if (newest && !newest.ok) {
		problems.push(`the NEWEST published ${HOST_PACKAGE} is ${newest.version}${newest.publishedAt ? ` (published ${newest.publishedAt})` : ""} and our peer window ${range} does NOT cover it`
			+ ` — a user installing that host gets a silently absent skin (issue #62's shape). Two honest responses: run this table plus --profile-load against it and widen the window,`
			+ " or write \"不支持\" into the compatibility table in all 8 READMEs. Doing neither is the third response, and it is the one that ships a broken promise.");
	}
	if (latestRow && !latestRow.ok && (!newest || newest.version !== latest)) {
		problems.push(`dist-tags.latest ${latest} is outside our window ${range} — that tag is what most people mean by "the current dsh"`);
	}

	const summary = {
		range,
		ourName: OUR_NAME,
		candidates: rows.length,
		stamped: stamped.length,
		newest: newest ? { version: newest.version, publishedAt: newest.publishedAt, ok: newest.ok } : null,
		latest: latest || null,
		tags: Object.keys(tags).length,
		inWindow: rows.filter((r) => r.ok).length,
		printed: Math.min(limit, rows.length)
	};
	return { rows, problems, summary };
}

/**
 * The second half of the Roadmap item: ONE real profile load. `loadProfileDirectory()` is the
 * read-only sibling; the host documents it as skipping incompatible bundles "without changing the
 * manifest". Reading a real profile is what catches the shapes a version table cannot: a broken
 * `cordis.patch.yml`, an entry the profile never installed, an exemption we accidentally rely on.
 */
async function profileLoad({ host, profileName, env }) {
	const home = (env || process.env).DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
	const dir = path.join(home, "profiles", profileName);
	if (!fs.existsSync(dir)) {
		throw environmentError(`no profile directory at ${dir} — nothing to load, which is not the same as "the plugin is incompatible"`, "profile");
	}
	const boot = await import(toFileUrl(host.appBoot));
	if (typeof boot.loadProfileDirectory !== "function") {
		throw new Error(`${host.appBoot} exports no loadProfileDirectory() — the host's boot API moved; re-read this script against it rather than guessing at the new shape`);
	}
	const profile = boot.loadProfileDirectory("dsh-preflight", dir, host.dshPackageJson);
	const skipped = (profile && profile.skippedBundles) || [];
	const layers = (profile && profile.layers) || [];
	const mine = skipped.find((s) => s && s.packageName === OUR_NAME);
	const problems = [];
	if (mine) {
		problems.push(`the real profile load SKIPPED us at ${dir}: ${String(mine.reason).split("\n")[0]}`
			+ " — this is exactly what a user reports as \"the skin vanished after the host updated\"");
	}
	return {
		profileName,
		profileDir: dir,
		bundles: layers.length,
		skipped: skipped.map((s) => `${s.packageName}: ${String(s.reason).split("\n")[0].slice(0, 140)}`),
		oursMounted: !mine,
		problems
	};
}

// ───────────────────────────── the CLI ────────────────────────────────────

function parseArgs(argv) {
	const opts = { limit: 12, profileLoad: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--packument") opts.packument = argv[++i];
		else if (a === "--profile-load") opts.profileLoad = true;
		else if (a === "--profile") { opts.profileName = argv[++i]; opts.profileLoad = true; }
		else if (a === "--limit") opts.limit = Number(argv[++i]);
		else if (a === "--json") opts.json = true;
		else if (a === "--strict") opts.strict = true;
		else throw new Error(`unknown argument ${a} (known: --packument <file> | --profile-load | --profile <name> | --limit N | --json | --strict)`);
	}
	if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer");
	return opts;
}

async function runTable(opts, env, deps) {
	const manifest = require(path.join(ROOT, "package.json"));
	const range = gateRange(manifest);
	const { data, source } = readPackument(Object.assign({}, opts, deps && deps.spawn ? { spawn: deps.spawn } : {}));

	// The host's own evaluator is preferred; the mirror is both the fallback and the cross-check.
	let host = null, hostSkip = null;
	const discover = (deps && deps.findHost) || findHost;
	try { host = discover(env); }
	catch (e) { if (!e.environment) throw e; hostSkip = e; }

	let boot = null;
	if (host) {
		boot = await import(toFileUrl(host.appBoot));
		if (typeof boot.evaluatePluginCompatibility !== "function") {
			throw new Error(`${host.appBoot} exports no evaluatePluginCompatibility() — the host's gate moved; re-read this script against it`);
		}
	}
	const evaluate = host
		? (version) => boot.evaluatePluginCompatibility(manifest, {}, version)
		: (version) => (satisfies(version, range) ? undefined : { peers: { [`${range}`]: range } });

	const table = buildTable({ packument: data, range, evaluate, mirror: !!host, limit: opts.limit });

	const lines = [];
	lines.push(`preflight input: ${source} | evaluator: ${host
		? `the host's own evaluatePluginCompatibility() (${host.dshDir} @ ${host.runtimeVersion})`
		: `MIRROR scripts/lib/peer-window.cjs — no host install here (${hostSkip ? hostSkip.message.split("\n")[0] : "not looked for"})`} | our window: ${range}`);
	if (table.summary) {
		lines.push(`candidates ${table.summary.candidates} (publish stamps on ${table.summary.stamped}) | in window ${table.summary.inWindow} | dist-tags ${table.summary.latest || "?"} (${table.summary.tags} tags)`
			+ ` | newest by stamp: ${table.summary.newest ? `${table.summary.newest.version}${table.summary.newest.publishedAt ? ` @ ${table.summary.newest.publishedAt}` : ""} — ${table.summary.newest.ok ? "INSIDE" : "OUTSIDE"} the window` : "?"}`);
	}
	const shown = table.rows.slice().sort((a, b) => (a.publishedAt && b.publishedAt ? (a.publishedAt > b.publishedAt ? -1 : 1) : 0)).slice(0, table.summary ? table.summary.printed : 0);
	for (const r of shown) {
		lines.push(`  ${(r.version || "").padEnd(16)} ${(r.publishedAt || "-").padEnd(26)} ${r.ok ? "loads" : `SKIPPED (peers: ${r.peers.join(", ") || "?"})`}`);
	}
	return { ...table, lines, evaluator: host ? "host" : "mirror", host, hostSkip };
}

async function main(argv, env, deps) {
	let opts;
	try { opts = parseArgs(argv); }
	catch (e) { return { exitCode: 1, lines: [String(e.message)], outcome: "usage" }; }
	const strict = opts.strict === true || strictRequested(env);
	let table;
	try {
		table = await runTable(opts, env, deps);
	} catch (e) {
		if (e.environment) {
			return {
				exitCode: strict ? 4 : 3,
				outcome: "skip",
				lines: [`${e.piece || "environment"}: SKIPPED — ${e.message}`
					+ (strict ? " (strict mode was asked for: a skip in the runbook is a broken pipeline, not a verdict)" : " — a skip is not a pass")]
			};
		}
		return { exitCode: 1, outcome: "fail", lines: [`preflight could not run: ${e.message}`] };
	}

	const problems = [...table.problems];
	const lines = [...table.lines];
	let loaded = null;
	if (opts.profileLoad) {
		if (!table.host) {
			// The load half needs the host's own loader; without it the table above is already
			// printed, so say which half did not run instead of pretending the answer is complete.
			lines.push(`  profile load SKIPPED — ${table.hostSkip ? table.hostSkip.message.split("\n")[0] : "no host install"}`);
			if (strict) return { exitCode: 4, outcome: "skip", lines: [...lines, "strict mode: --profile-load was asked for and could not run"], problems, table, loaded };
		} else {
			try {
				loaded = await profileLoad({ host: table.host, profileName: opts.profileName || "web", env });
				problems.push(...loaded.problems);
				lines.push(`  profile ${loaded.profileName} (${loaded.profileDir}): ${loaded.bundles} bundle layers loaded, ${loaded.skipped.length} skipped`);
				for (const s of loaded.skipped) lines.push(`    skipped: ${s}`);
				lines.push(`    ${OUR_NAME}: ${loaded.oursMounted ? "mounted" : "SKIPPED BY THE HOST"}`);
			} catch (e) {
				if (e.environment) {
					lines.push(`  profile load SKIPPED — ${e.message}`);
					if (strict) return { exitCode: 4, outcome: "skip", lines: [...lines, "strict mode: --profile-load was asked for and could not run"], problems, table, loaded };
				} else {
					return { exitCode: 1, outcome: "fail", lines: [...lines, `profile load failed: ${e.message}`], problems, table };
				}
			}
		}
	}

	if (problems.length) {
		for (const p of problems) lines.push(`PROBLEM: ${p}`);
		return { exitCode: 1, outcome: "fail", lines, problems, table, loaded };
	}
	lines.push(`preflight OK — the newest published ${HOST_PACKAGE} is inside our window (evaluator: ${table.evaluator})`
		+ (loaded && loaded.oursMounted ? `, and the real profile load mounted us at ${loaded.profileDir}` : "") + ".");
	const out = { exitCode: 0, outcome: "ok", lines, problems, table, loaded };
	if (opts.json) out.json = JSON.stringify({ summary: table.summary, problems, loaded: loaded || null, evaluator: table.evaluator }, null, 1);
	return out;
}

if (require.main === module) {
	main(process.argv.slice(2), process.env).then((r) => {
		const print = r.outcome === "fail" || r.outcome === "usage" ? console.error : console.log;
		if (r.json) console.log(r.json);
		else for (const line of r.lines) print(line);
		process.exitCode = r.exitCode;
	}, (e) => {
		console.error(`preflight crashed: ${e && e.stack ? e.stack : e}`);
		process.exitCode = 1;
	});
}

module.exports = { buildTable, runTable, main, parseArgs, readPackument, findHost, profileLoad, strictRequested, environmentError, toFileUrl, HOST_PACKAGE, OUR_NAME };
