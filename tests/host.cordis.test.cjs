/**
 * The host-half test that runs against the REAL cordis, not a model of it.
 *
 * Why this file exists: v10.20.0 shipped a `trustedAuthorities()` that read
 * `ctx.webStartup` / `ctx.webRuntime` as properties. Every test stayed green,
 * because the fake ctx was a plain object — and on a real host the plugin
 * fiber throws `cannot get property "…" without inject` for any service not
 * named in `inject`, so every persistence request would 500 while the plugin
 * looked mounted. The synthetic harness in `host.persistence.test.cjs` now
 * models that rule; this file goes one step further and mounts the plugin in
 * the host's own framework, so "the model is wrong" cannot hide the defect
 * again.
 *
 * It runs only where a host install is readable (this repo's local machines).
 * CI without a host takes the NAMED skip below — the synthetic contract legs
 * still run there, so the skip is not a hole in CI's coverage of the rule.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

/**
 * Locate the host's own cordis; null when this machine has no host install.
 *
 * Deliberately LAZY (called from inside a test, never at module load): the
 * docs/numbers gate loads every test file twelve times to count declarations,
 * and a module-level host lookup that shells out to `npm root -g` made that
 * gate wait on npm (measured: the gate went from ~20 s to a timeout, because
 * each of those loads can block for the exec timeout). The common locations
 * are checked without spawning anything; npm is the last resort, and even
 * then only on a real test run.
 */
let cordisCache;
function findCordis() {
	if (cordisCache !== undefined) return cordisCache;
	const usable = (dir) => {
		try { return fs.statSync(path.join(dir, 'lib', 'index.js')).isFile(); } catch { return false; }
	};
	const cands = [];
	const addHost = (base) => {
		if (!base) return;
		cands.push(path.join(base, 'cordis'));
		cands.push(path.join(base, '@deepseek-ai', 'cordis'));
		cands.push(path.join(base, 'node_modules', '@deepseek-ai', 'cordis'));
	};
	addHost(process.env.DSH_HOST_ROOT);
	// npm's global prefix, derived from well-known locations — no child process.
	if (process.env.APPDATA) {
		cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis'));
	}
	cands.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis'));
	cands.push(path.join('/usr/local/lib/node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis'));
	const profile = path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai');
	cands.push(path.join(profile, 'dsh', 'node_modules', '@deepseek-ai', 'cordis'));
	cands.push(path.join(profile, 'cordis'));
	let found = cands.find(usable) || null;
	if (found === null) {
		// Last resort: ask npm. Only reached on machines whose layout none of the
		// paths above match.
		try {
			const g = execSync('npm root -g', { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			const cand = path.join(g, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis');
			if (usable(cand)) found = cand;
		} catch {}
	}
	cordisCache = found;
	return found;
}

function makeReq({ method = 'POST', body = null, headers = {} }) {
	const events = {};
	return {
		method,
		headers,
		on(ev, fn) { events[ev] = fn; },
		destroy() {},
		push() {
			if (body != null && events.data) events.data(Buffer.from(body));
			if (events.end) events.end();
			if (events.error) events.error();
		}
	};
}
function makeRes() {
	return {
		status: 0, payload: null,
		writeHead(s) { this.status = s; },
		end(b) { this.payload = b != null ? JSON.parse(b.toString()) : null; }
	};
}
async function call(handler, opts) {
	const req = makeReq(opts);
	const res = makeRes();
	const p = handler(req, res);
	req.push();
	await p;
	return res;
}

const J = { 'content-type': 'application/json' };
const GET = JSON.stringify({ method: 'get' });
const SKIP_REASON = 'no host cordis readable here (set DSH_HOST_ROOT) — the synthetic cordis-contract harness in host.persistence.test.cjs still ran';
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/**
 * Mount the plugin into a fresh real cordis app whose webServer (and optional
 * trust service) come from a sibling fiber, exactly as the host composition
 * does. Returns the captured route plus a teardown.
 */
async function mount(CORDIS, services) {
	const { Context } = await import(pathToFileURL(path.join(CORDIS, 'lib', 'index.js')).href);
	const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
	const app = new Context();
	let captured = null;
	app.plugin({
		name: 'test-provider',
		apply(ctx) {
			ctx.provide('webServer', { register(route) { captured = route; return () => {}; } });
			for (const [name, value] of Object.entries(services)) ctx.provide(name, value);
		}
	});
	await tick();
	app.plugin(mod);
	await tick(60);
	return { captured, mod, app };
}

test('real cordis: a non-injected service is unreadable as a property, readable through ctx.get', async (t) => {
	const CORDIS = findCordis();
	if (!CORDIS) return t.skip(SKIP_REASON);
	const { Context } = await import(pathToFileURL(path.join(CORDIS, 'lib', 'index.js')).href);
	const app = new Context();
	const readings = {};
	app.plugin({ name: 'provider', apply(ctx) { ctx.provide('webStartup', { trustedHosts: ['a.example'] }); } });
	await tick();
	app.plugin({
		name: 'consumer',
		inject: ['webServer'],
		apply(ctx) {
			try { readings.property = ctx.webStartup; } catch (e) { readings.property = `THREW: ${e.message}`; }
			readings.get = ctx.get('webStartup');
			readings.getMissing = ctx.get('webRuntime');
		}
	});
	// webServer must exist for the consumer's inject gate to pass.
	app.plugin({ name: 'server', apply(ctx) { ctx.provide('webServer', { register() { return () => {}; } }); } });
	await tick(60);
	assert.match(String(readings.property), /cannot get property "webStartup" without inject/,
		'the rule this file exists for: property access to a non-injected service must throw');
	assert.deepEqual(readings.get, { trustedHosts: ['a.example'] }, 'ctx.get returns the provided service');
	assert.equal(readings.getMissing, undefined, 'ctx.get returns undefined for an absent service');
});

test('real cordis: 0.2.1-shaped host (webStartup, no webRuntime) serves the API', async (t) => {
	const CORDIS = findCordis();
	if (!CORDIS) return t.skip(SKIP_REASON);
	const { captured } = await mount(CORDIS, { webStartup: { trustedHosts: ['trusted.example'] } });
	assert.ok(captured && captured.handler, 'the host half must register its route');
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-'));
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const loop = await call(captured.handler, { headers: { ...J, host: '127.0.0.1:19387' }, body: GET });
		assert.equal(loop.status, 200, 'loopback request must succeed on a webStartup host');
		assert.deepEqual(loop.payload, { ok: true, value: {} });
		const trusted = await call(captured.handler, { headers: { ...J, host: 'trusted.example' }, body: GET });
		assert.equal(trusted.status, 200, 'the webStartup trusted authority must be honoured');
		const foreign = await call(captured.handler, { headers: { ...J, host: 'evil.example' }, body: GET });
		assert.equal(foreign.status, 403, 'an unlisted authority must still be refused');
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
		try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
	}
});

test('real cordis: 0.2.0-shaped host (webRuntime only) still honours its trusted authority', async (t) => {
	const CORDIS = findCordis();
	if (!CORDIS) return t.skip(SKIP_REASON);
	const { captured } = await mount(CORDIS, { webRuntime: { trustedHosts: ['legacy.example'] } });
	assert.ok(captured && captured.handler, 'the host half must register its route');
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-'));
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const res = await call(captured.handler, { headers: { ...J, host: 'legacy.example' }, body: GET });
		assert.equal(res.status, 200, 'the webRuntime fallback must still be read');
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
		try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
	}
});

test('real cordis: no trust service at all — the host half mounts, loopback works', async (t) => {
	const CORDIS = findCordis();
	if (!CORDIS) return t.skip(SKIP_REASON);
	const { captured } = await mount(CORDIS, {});
	assert.ok(captured && captured.handler, 'issue #109: a missing optional service must not keep the entry pending');
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cordis-'));
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const loop = await call(captured.handler, { headers: { ...J, host: 'localhost' }, body: GET });
		assert.equal(loop.status, 200, 'loopback is the whole grant when no service provides more');
		const foreign = await call(captured.handler, { headers: { ...J, host: 'evil.example' }, body: GET });
		assert.equal(foreign.status, 403);
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
		try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
	}
});
