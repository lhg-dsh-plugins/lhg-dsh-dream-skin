/**
 * dsh-dream-skin — wash-cascade probe (issues #96 / #97, adversarial review 10.8.0).
 *
 * WHY THIS EXISTS. Every other check in this repository grades the sheet as TEXT:
 * `scripts/craft-audit.cjs` and `tests/client.smoke.test.cjs` read the CSS string the
 * bundle builds. A string is not a rendering. Issue #97 is the proof — a rule whose
 * selector matched nothing on any host sat in the sheet for four releases while every
 * string-level assertion stayed green. Issue #96 has the same hole from the other side:
 * the fix wins the cascade only on specificity, and "the declaration is present" cannot
 * see whether it reaches the element the host actually rounds. That is exactly what the
 * 10.8.0 review (A9 / B4 / P1-4) said, together with the sharper point that the
 * CHANGELOG claimed sampling in "a real CSS engine" while the shipped tree offered no way
 * to recompute the claim.
 *
 * So this file recomputes it. The HOST page is built from THREE sources, none of them
 * hand-copied:
 *   1. the plugin's own material sheet, taken out of the shipped bundle by
 *      `scripts/craft-audit.cjs` — the same reader the craft gates use;
 *   2. the host's layout CSS, read out of the installed host package;
 *   3. the host's fade rule and the chat package's scroll masks, read the same way.
 * Headless Chrome then reports the COMPUTED values in three states: no wash / wash /
 * wash again. All three host packages are required by name: a fixture that quietly
 * omitted the rule under test would read the same value in every state and "prove" the
 * fix with a check that cannot fail (issue #83's lesson — zero output is a failure).
 *
 * The DESKTOP page (issue #99) is a second, smaller fixture in the same file: the shell
 * is a third-party plugin with no local install to read, so its two sidebar rules are a
 * pinned SNAPSHOT (`DESKTOP_SHELL_SOURCE` names the repo, tag and lines) while the
 * material sheet and the sidebar-token consumer declaration are still read from the
 * bundle and the installed host. It grades the one thing a string test cannot answer:
 * whether our wash-gated `background-color` outranks the shell's opaque `background`
 * shorthand without eating the token path or the shell's own border.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { extractSheets } = require('./craft-audit.cjs');
const { findChrome, CHROME_CANDIDATES } = require('./generate-skin-mockups.cjs');

const REPO = path.join(__dirname, '..');
/**
 * Where the host CSS is read from. `DSH_HOST_ROOT` is the CI override (Roadmap M): the
 * workflow installs `@deepseek-ai/dsh-client-ui-{layout,workspace,chat,sidebar}` into a
 * throwaway directory and points this at that directory's `@deepseek-ai` scope folder.
 * Unset, it stays the maintainer's global npm install, so local behaviour does not change.
 * Pointing it somewhere empty is an ENVIRONMENT skip (see `hostInstallPresent`), never a
 * thin fixture — and under `DSH_WASH_STRICT=1` it is exit 4 naming the host install.
 */
const DEFAULT_HOST_ROOT = process.env.DSH_HOST_ROOT
	|| path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');

/**
 * Issue #102: an error that says "this machine cannot run the check" rather than
 * "the check ran and disagrees". Tagged, not string-matched, so a future wording
 * change cannot quietly turn a red into a skip — and a skip is reported as a skip,
 * never as a pass (this gate's standing rule).
 *
 * `piece` (Roadmap M, the CI gate) names WHICH environment input is absent —
 * `browser` / `host install` / a plugin id — so strict mode can fail with a sentence
 * the reader can act on ("install Chrome", "npm i the three host packages") instead of
 * a generic "could not run". An error with no `piece` is still an environment skip; it
 * just says less when strict mode has to name it.
 */
function environmentError(message, piece) {
	const err = new Error(message);
	err.environment = true;
	if (piece) err.piece = piece;
	return err;
}

/**
 * Roadmap M — is `DSH_WASH_STRICT` on? Parsed explicitly so that `0`, `""`, `false` and
 * unset all mean OFF: a CI variable that turned "0" into strict mode would be a red nobody
 * asked for, and a gate that goes red for the wrong reason is as untrustworthy as one that
 * goes green for the wrong reason.
 */
function strictRequested(env) {
	return /^(1|true|yes|on)$/i.test(String((env || process.env).DSH_WASH_STRICT || '').trim());
}

/**
 * Issue #105 — the OTHER plugin that addresses `_fade`, read out of the install.
 *
 * `#97` replaced a hash anchor with `[class$="_fade"]`, and a third-party theme pack
 * installed in the same document writes `[class*="_fade"]` against the same face. The
 * census counts that (see scripts/lib/fade-owners.cjs); this reads the actual bytes so the
 * ENGINE can say who wins: their `scoped()` helper prefixes three host-level markers onto
 * the selector, so the rule is reconstructed from the scope list + selector argument +
 * declaration block exactly as that bundle composes it. Nothing is retyped: each piece is
 * extracted, and a piece going missing is an error rather than a thinner page.
 *
 * A machine without this plugin gets an ENVIRONMENT skip (issue #102's contract) — "we
 * could not look here" is not "nobody else addresses _fade".
 */
const SKIN_CENTER_PKG = '@linxin666/dsh-client-ui-skin-center';

function skinCenterPaths(env) {
	// `env || process.env` — Roadmap M. The CLI calls `measureCoexist()` with no opts, so
	// without this default `DSH_SKIN_CENTER` was honored by the tests (they pass an env
	// object) and IGNORED by the only caller that CI can reach: the gate read the maintainer's
	// profile copy and a runner with no profile would have skipped for the wrong reason. An
	// explicit env object still wins, so a test that points at a fixture is unaffected.
	const e = env || process.env;
	if (e.DSH_SKIN_CENTER) return [e.DSH_SKIN_CENTER];
	const home = e.HOME || e.USERPROFILE || '';
	return ['web', 'desktop']
		.map((p) => path.join(home, '.dsh', 'profiles', p, 'node_modules', SKIN_CENTER_PKG, 'lib', 'client.js'));
}

/** Extract their `_fade` rule verbatim-ish: scopes × selector + the declaration block. */
function pluginFadeRule(env) {
	const paths = skinCenterPaths(env);
	let file = null;
	for (const p of paths) {
		try { if (fs.statSync(p).isFile()) { file = p; break; } } catch {}
	}
	if (!file) {
		throw environmentError(`${SKIN_CENTER_PKG} is not installed here (looked in ${paths.join(', ')}) — the coexistence half cannot be measured on this machine, and that is NOT evidence that nobody else addresses _fade`, `plugin ${SKIN_CENTER_PKG}`);
	}
	const text = fs.readFileSync(file, 'utf8');
	const av = text.match(/ACTIVE_VISUAL_SELECTOR\s*=\s*\[([\s\S]{0,600}?)\]\s*\.join\(\s*",\s*"\s*\)/);
	if (!av) throw new Error(`${SKIN_CENTER_PKG}: no ACTIVE_VISUAL_SELECTOR join found — their scoped() prefix list is unreadable, so the composed rule would be invented`);
	const scopes = [...av[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
	// Their helper is `scopes.map((scope) => `${scope} ${selector}`).join(",\n")` — three
	// `html[…]` prefixes. A fourth scope or a non-`html` one changes who the rule reaches,
	// so it is refused rather than silently composed.
	if (scopes.length !== 3 || !scopes.every((s) => s.startsWith('html['))) {
		throw new Error(`${SKIN_CENTER_PKG}: ACTIVE_VISUAL_SELECTOR is no longer 3 html[…] scopes (read: ${JSON.stringify(scopes)}) — recompose by hand after re-reading scoped()`);
	}
	let selArg = null;
	let selEnd = -1;
	for (const m of text.matchAll(/scoped\("((?:[^"\\]|\\.)*)"\)/g)) {
		const un = JSON.parse(`"${m[1]}"`);
		if (!un.includes('_fade')) continue;
		if (selArg !== null) throw new Error(`${SKIN_CENTER_PKG}: TWO scoped rules mention _fade (${JSON.stringify(selArg)} and ${JSON.stringify(un)}) — the census counted ${1}, so re-read before measuring`);
		selArg = un;
		selEnd = m.index + m[0].length;
	}
	if (selArg === null) throw new Error(`${SKIN_CENTER_PKG}: no scoped() selector mentions _fade any more — their rule moved, and this fixture would be measuring a face that no longer exists`);
	if (!/\[class\*="_fade"\]/.test(selArg) || !/\[data-slot="sidebar\.workspaces"\]/.test(selArg)) {
		throw new Error(`${SKIN_CENTER_PKG}: the _fade selector changed shape (${JSON.stringify(selArg)}) — the coexistence claim needs re-reading`);
	}
	const open = text.indexOf('{', selEnd);
	// The `}` that closes the template interpolation `${scoped("…")}` sits BEFORE the rule's
	// own brace, so searching for a closing brace has to start after the opening one.
	const close = open < 0 ? -1 : text.indexOf('}', open);
	if (open < 0 || close < 0) throw new Error(`${SKIN_CENTER_PKG}: no declaration block after the _fade scoped() call`);
	const block = text.slice(open + 1, close).trim();
	if (!/!important/.test(block)) {
		throw new Error(`${SKIN_CENTER_PKG}: their _fade rule lost !important (${JSON.stringify(block)}) — the cascade answer changes, re-measure before restating it`);
	}
	let version = null;
	try {
		version = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8')).version;
	} catch {}
	return {
		file,
		version,
		scopes,
		selector: selArg,
		block,
		css: scopes.map((s) => `${s} ${selArg}`).join(',\n') + ` {\n${block}\n}`
	};
}

/** The three host packages the fixture needs, and the token that identifies each one. */
const HOST_PACKAGES = [
	{ key: 'layout', pkg: 'dsh-client-ui-layout', must: '--dsh-windows-content-radius', why: 'the AppFrame fill and the content corner' },
	{ key: 'fade', pkg: 'dsh-client-ui-workspace', must: '_fade', why: 'the session-list foot fade the wash must neutralise' },
	{ key: 'chat', pkg: 'dsh-client-ui-chat', must: '_fadeTop', why: 'the chat scroll masks that must NOT be touched' },
	{ key: 'sidebar', pkg: 'dsh-client-ui-sidebar', must: '_footArea', why: 'the sidebar foot plane Roadmap A1 re-anchored onto the class suffix' }
];

/**
 * Read a package's CSS out of the install. Host CSS ships as one stringified literal in
 * the package's `lib/client.js`, so the quoted literal is parsed rather than grepped.
 * @returns {string|null} the CSS text, or null when the package or token is absent.
 */
function hostCss(root, pkg, contains) {
	const file = path.join(root, pkg, 'lib', 'client.js');
	if (!fs.existsSync(file)) return null;
	const src = fs.readFileSync(file, 'utf8');
	const re = /"(?:[^"\\]|\\.)*"/g;
	let m;
	while ((m = re.exec(src))) {
		if (!m[0].includes(contains)) continue;
		let blob;
		try { blob = JSON.parse(m[0]); } catch { continue; }
		if (blob.includes('{') && blob.includes(contains)) return blob;
	}
	return null;
}

/**
 * Remove ONE declaration (property and its value) from a CSS text, leaving the rest of
 * its rule intact. Used by the mutation half of the gate: if the readings do not change
 * when exactly this declaration goes away, the readings were never caused by it.
 */
function stripDeclaration(css, prop) {
	const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp('\\n?\\s*' + escaped + '\\s*:[^;}]*;', 'g');
	const out = css.replace(re, ';');
	if (out === css) throw new Error(`declaration ${prop} not found in the sheet — nothing was mutated`);
	return out;
}

/**
 * Issue #105 — the fade / chat class names are DERIVED from the host CSS that was just
 * read, not copied from a note. Boundary ⑤ of `docs/desktop-support.md` used to say the
 * fixture hands-writes `bhn1Oq_fade` / `O_Ebla_fadeTop`: a hash re-roll would then leave
 * the page measuring a class nobody renders while every reading still "passed". Deriving
 * them means a re-roll breaks the fixture LOUDLY (no rule to derive from) instead of
 * quietly.
 */
function hostFadeClasses(parts) {
	const fade = parts.fade.match(/(?:^|[},])\.([A-Za-z0-9_-]*_fade)\s*\{/);
	if (!fade) {
		throw new Error('the host fade CSS carries no `.<token>_fade {` rule — the fixture would have to INVENT the class it claims to measure');
	}
	const chat = parts.chat.match(/(?:^|[},])\.([A-Za-z0-9_-]*_fadeTop)\s*\{/);
	if (!chat) {
		throw new Error('the host chat CSS carries no `.<token>_fadeTop {` rule — the collateral half of the check would be protecting nothing');
	}
	return { fadeClass: fade[1], chatClass: chat[1] };
}

/**
 * 10.9.1 — the three AppFrame names, derived the same way, and this half is not cosmetic.
 * Our own rule reaches the frame STRUCTURALLY (`div:has(> [data-shell-overlay])`), so a
 * stale hand-copied class would not break OUR rule — it would break the HOST's, and the
 * page would then measure "our declaration cleared nothing" while still reading
 * `rgba(0, 0, 0, 0)` and calling that a pass. That is issue #97's shape one level up: a
 * fixture whose target quietly vanished. `docs/desktop-support.md` boundary ⑤ used to name
 * these two (`pI_x6G_frame` / `pI_x6G_centerCol`) as the last hand-writes in the page.
 */
function hostLayoutClasses(parts) {
	if (!parts.layout) throw new Error('no host layout CSS to read the AppFrame classes from — build the fixture through buildFixture()');
	const pick = (suffix, what) => {
		// The boundary class is `}` / `,` / START / whitespace: the host ships both
		// `.<h>_frame{…}` and `[data-windows-titlebar] .<h>_frame{…}`, and either one proves
		// the class exists. Requiring the unprefixed form alone (the first version) meant a
		// host that ever moved the declaration behind its platform prefix would stop the
		// build for no reason — a false red is still a red, and this gate has to be trusted
		// when it speaks.
		const hit = parts.layout.match(new RegExp('(?:^|[},\\s])\\.([A-Za-z0-9_-]*)_' + suffix + '\\s*\\{'));
		if (!hit) {
			throw new Error(`the host layout CSS carries no \`.<token>_${suffix} {\` rule — the fixture would have to INVENT the ${what} it claims to measure`);
		}
		return hit[1] + '_' + suffix;
	};
	return {
		frameClass: pick('frame', 'frame whose ::before paints the caption row'),
		centerColClass: pick('centerCol', 'content corner issue #96 flattens'),
		sidebarColClass: pick('sidebarCol', 'sidebar column that must survive untouched')
	};
}

/**
 * The sidebar foot classes, derived from the host's own CSS (Roadmap A1).
 *
 * This is the reading that string assertions cannot give: `[class$="_footArea"]` matching a
 * selector in OUR sheet says nothing about whether it matches an ELEMENT. If the host ever
 * composes a second class token onto that div (`class="hHd-Xa_footArea hHd-Xa_fading"`), the
 * `$=` form stops matching while every text gate in this repository stays green — the same
 * "declared equal is not pixels equal" shape 10.9.3 was corrected for. So the fixture is
 * built from the base the host actually ships, and the checks below read computed style off
 * a box.
 */
function hostSideFootClasses(parts) {
	if (!parts.sidebar) throw new Error('no host sidebar CSS to read the foot plane classes from — build the fixture through buildFixture()');
	const pick = (suffix, what) => {
		// Selector POSITION, not `token{`: the host declares the two nested surfaces inside a
		// selector LIST (`.hHd-Xa_settingsArea,.hHd-Xa_collapsed .hHd-Xa_footerActions{…}`), so
		// requiring the brace after the token made the build refuse a class that is plainly
		// there. The leading `(^|[},\s])\.` still has to hold, which is what keeps this a
		// selector rather than a substring of some other identifier.
		const hit = parts.sidebar.match(new RegExp('(?:^|[},\\s])\\.([A-Za-z0-9_-]*)_' + suffix + '(?![\\w-])'));
		if (!hit) {
			throw new Error(`the host sidebar CSS carries no \`.<token>_${suffix}\` selector — the fixture would have to INVENT the ${what} it claims to measure`);
		}
		return hit[1] + '_' + suffix;
	};
	return {
		footClass: pick('footArea', 'landmark the foot plane is scoped by'),
		settingsClass: pick('settingsArea', 'settings block inside that foot area'),
		actionsClass: pick('footerActions', 'footer actions inside that foot area')
	};
}

/**
 * Every declaration block in a stylesheet, with the one fact the naive
 * `/([^{}]+)\{([^{}]*)\}/` scan cannot tell: whether an `@media` / `@supports` wrapper stands
 * above it. That distinction is the whole difference between "the host writes this rule" and
 * "the host writes this rule WHEN" — and a fixture that cannot express the WHEN must not
 * silently replay the rule as unconditional.
 */
function walkCssBlocks(css) {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	const stack = [];
	let i = 0;
	let seg = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '{') {
			const sel = text.slice(seg, i).replace(/\s+/g, ' ').trim();
			const isAt = /^@/.test(sel);
			stack.push({ sel, isAt, conditional: isAt || stack.some((f) => f.conditional) });
			i++; seg = i; continue;
		}
		if (ch === '}') {
			const frame = stack.pop();
			const body = text.slice(seg, i).trim();
			i++; seg = i;
			if (frame && !frame.isAt) out.push({ sel: frame.sel, body, conditional: frame.conditional });
			continue;
		}
		i++;
	}
	return out;
}

/** The properties the `side` group actually reads off the plane. */
const SIDE_WATCHED_PROPS = ['margin-left', 'margin-right', 'padding-left', 'padding-right',
	'width', 'background', 'box-shadow', 'border', 'display', 'flex-direction'];

/** The declaration names carried by one rule body. */
function declaredProps(body) {
	return body.split(';')
		.map((d) => (d.indexOf(':') >= 0 ? d.slice(0, d.indexOf(':')).trim().toLowerCase() : ''))
		.filter(Boolean);
}

/** Does this property name fall under one of the watched ones (shorthand family included)? */
function watchedFamily(prop) {
	return SIDE_WATCHED_PROPS.some((w) => prop === w || prop.startsWith(`${w}-`));
}

/**
 * The host's OWN declarations for those three boxes, verbatim.
 *
 * Why this exists: the first version of the `side` group put the host's class NAMES in the
 * page and nothing else. Every reading then described our sheet applied to a bare `<div>`,
 * which is not the cascade the user runs in — the host really does write
 * `.<base>_footArea{display:flex}`, `.<base>_settingsArea{width:100%}` and friends, and our
 * landmark branch is (0,1,0) — the SAME specificity as those rules, so the winner is decided
 * by document order, not by anything we control from the bundle. A fixture without the host's
 * own block cannot notice that at all: it would keep reading `transparent` after a host build
 * that paints the foot plane and ships its sheet after ours.
 *
 * Two losses are handled by NAME, not by silence:
 *   - a foot selector that does not look like a rule segment (element-prefixed, or a partial
 *     drop inside a list) REFUSES the build — fewer host declarations in the page is a
 *     different cascade, and a shape check cannot see quantity;
 *   - a rule under `@media` / `@supports` cannot be replayed with its condition, so it is
 *     SKIPPED and recorded. Skipping is only honest while none of its declarations is one the
 *     checks read: today the host's one conditional foot rule is
 *     `@media (prefers-reduced-motion:reduce){… .railIn .footArea{transition:none;animation:none}}`,
 *     which touches nothing the group measures. The day a margin or a fill moves behind a
 *     breakpoint, this REFUSES and the fixture has to grow a real condition.
 *
 * Returns `{ rules, skipped }`.
 */
function hostSideFootRules(sidebarCss, classes) {
	const tokens = [classes.footClass, classes.settingsClass, classes.actionsClass];
	const out = [];
	const skipped = [];
	const unshapeable = [];
	for (const block of walkCssBlocks(sidebarCss)) {
		const touching = block.sel
			.split(',')
			.map((s) => s.replace(/\s+/g, ' ').trim())
			.filter((s) => tokens.some((t) => s.includes('.' + t)));
		if (!touching.length) continue;
		if (block.conditional) {
			const props = declaredProps(block.body);
			const loadBearing = props.filter(watchedFamily);
			if (loadBearing.length) {
				throw new Error('the host writes a foot-plane declaration the side group reads (`' + loadBearing.join(', ')
					+ '`) under an @media/@supports condition the fixture cannot express (selector `'
					+ touching[0].slice(0, 90) + '`) — replaying it unconditionally would measure a page nobody runs');
			}
			skipped.push({ selector: touching[0].slice(0, 120), props });
			continue;
		}
		const kept = touching.filter((s) => /^[.[(]/.test(s));
		if (kept.length !== touching.length) unshapeable.push(...touching.filter((s) => !kept.includes(s)));
		if (!kept.length) continue;
		out.push(kept.join(',') + '{' + block.body + '}');
	}
	if (!out.length) {
		throw new Error('the host sidebar CSS names the foot classes but carries no readable rule for them — '
			+ 'the fixture would measure our sheet against a bare div and call that a cascade');
	}
	if (unshapeable.length) {
		throw new Error('the host writes foot-plane selectors the fixture cannot replay ('
			+ unshapeable.length + ' of them, e.g. `' + unshapeable[0].slice(0, 90) + '`) — refusing instead of building a page '
			+ 'where these declarations are missing while the readings still pass');
	}
	return { rules: out.join('\n'), skipped };
}

/**
 * The host's own INSET convention, read out of the same sidebar CSS.
 *
 * Why this is in the fixture at all: the three numbers our foot-plane rule writes
 * (`margin-left:-4px`, `margin-right:calc(-1 * var(--dsh-sidebar-inline-padding, 12px))`,
 * `padding-left:4px`) are not ours — they are the convention the host itself uses for the
 * region above the foot (`.<base>_regionArea{margin-left:-4px;margin-right:calc(-1 * var(…));
 * padding-left:4px}`), and the variable is declared on `.<base>_root`, together with the
 * `padding:6px var(…)` that makes the bleed necessary. Without those rules in the page, a
 * reading of `-12px` only proves OUR FALLBACK equals OUR FALLBACK: the relational half of the
 * claim ("we follow the host's own inset") had no observation behind it. Loading them turns
 * three typed constants into measurements, and a host that moves the variable now moves both
 * sides of the comparison instead of leaving us silently 4px out of date.
 *
 * Everything here is derived from the host CSS and nothing is remembered: a renamed class or a
 * dropped declaration REFUSES the build rather than falling back to a literal.
 */
function hostSideInsets(sidebarCss) {
	const rules = walkCssBlocks(sidebarCss);

	// The element that DECLARES the variable.
	const varRule = rules.find((r) => /--dsh-sidebar-inline-padding\s*:/.test(r.body));
	if (!varRule) {
		throw new Error('the host sidebar CSS no longer declares --dsh-sidebar-inline-padding anywhere — '
			+ 'the fixture would have to INVENT the inset the alignment rule claims to follow');
	}
	if (varRule.conditional) {
		throw new Error('the host declares --dsh-sidebar-inline-padding only under an @media/@supports condition — '
			+ 'the fixture cannot express that, and a variable that appears at some viewport widths is not the '
			+ 'inset our rule claims to follow everywhere');
	}
	const rootSel = varRule.sel.split(',').map((s) => s.trim()).filter((s) => /^\.[\w-]+$/.test(s))[0];
	if (!rootSel) {
		throw new Error(`the host declares the inset variable on \`${varRule.sel}\`, which is not a single class the fixture can place — `
			+ 'the variable would not reach the foot plane and the relational reading would be about nothing');
	}
	// The host's own bled region, which is the convention we copy.
	const regionMatches = rules.filter((r) => /_regionArea(?![\w-])/.test(r.sel) && /margin-left\s*:/.test(r.body));
	const regionRule = regionMatches.find((r) => !r.conditional);
	if (!regionRule) {
		throw new Error(regionMatches.length
			? 'the host gives `._regionArea` its margin-left only under an @media/@supports condition — the fixture cannot replay a conditional convention'
			: 'the host sidebar CSS carries no `._regionArea` rule with a margin-left — '
				+ 'the `-4px` our foot plane writes would be an unverifiable literal again');
	}
	const regionSel = regionRule.sel.split(',').map((s) => s.trim()).filter((s) => /^\.[\w-]+_regionArea$/.test(s))[0];
	if (!regionSel) {
		throw new Error(`the region rule is declared under \`${regionRule.sel}\`; the fixture cannot name it — refuse rather than guess`);
	}
	return {
		rootClass: rootSel.replace(/^\./, ''),
		rootRule: `${rootSel}{${varRule.body}}`,
		regionClass: regionSel.replace(/^\./, ''),
		regionRule: `${regionSel}{${regionRule.body}}`
	};
}

/**
 * Is there a DSH install to read AT ALL at this root? Blue-team B4: "no host on this
 * machine" and "the host is here but this package is gone" are different facts, and the
 * second one is precisely the drift this gate exists to notice — reporting it as an
 * environment skip would let a renamed host package pass as "nothing to check here".
 */
function hostInstallPresent(root) {
	try {
		return fs.readdirSync(root, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.'));
	} catch {
		return false;
	}
}

/**
 * Parse `#rgb` / `#rrggbb` / `rgb()` / `rgba()` into `{rgb, a}`, or null when the value is
 * anything else (a gradient, a keyword, a nested var()). Refusing is the point: the fixture
 * would otherwise carry `var(--x)` into a `:root` declaration and read back a colour that
 * nothing authored.
 */
function cssColor(value) {
	const s = String(value || '').trim();
	const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
		return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
	}
	const fn = s.match(/^rgba?\(([^)]+)\)$/i);
	if (!fn) return null;
	const parts = fn[1].split(/[,/]/).map((x) => x.trim()).filter(Boolean);
	if (parts.length < 3 || parts.length > 4) return null;
	const rgb = parts.slice(0, 3).map((x) => Number(x));
	if (rgb.some((n) => !Number.isFinite(n))) return null;
	return { rgb, a: parts.length === 4 ? Number(parts[3]) : 1 };
}

/** The skin the caption-band decision was made on (the reporter's own skin, 2026-10-09). */
const CORNER_SKIN = 'nebula';
/**
 * The two slider positions that page was measured at: canvas 0.4, sidebar 0.75.
 * Alphas stay a MODELLED input on purpose — on the live page they are published by the wash
 * from the user's sliders, and reading them here would mean executing the bundle. What must
 * NEVER be typed is the RGB: that is the skin's, and the skin changes.
 */
const CORNER_ALPHA = { '--dsw-alias-bg-base': 0.4, '--dsw-specific-sidebar-fill': 0.75 };

/**
 * The corner fixture's colors, read out of the SHIPPED bundle (issue #93-era debt F14).
 * The desktop group already does this through `skinTokens()`; the corner group was the last
 * place in this file still grading colors somebody typed into a test — which means a skin
 * repainting its canvas or sidebar token would leave the fixture measuring a page nobody
 * ships, while every relational check stayed green.
 */
function cornerTokens(source) {
	const tokens = skinTokens(source, CORNER_SKIN);
	const out = {};
	for (const key of ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill', '--dsw-alias-bg-layer-2']) {
		const color = cssColor(tokens[key]);
		if (!color) {
			throw new Error(`skin ${CORNER_SKIN} ships no readable ${key} in the bundle — the corner fixture would have to INVENT the colour it claims to measure`);
		}
		const alpha = key in CORNER_ALPHA ? CORNER_ALPHA[key] : color.a;
		out[key] = `rgba(${color.rgb.join(', ')}, ${alpha})`;
	}
	return out;
}

/**
 * Roadmap A1, 10.13.0 — what the frosting rule DECLARES, read out of the shipped material sheet.
 *
 * Why a fixture needs this: the pairing gate proves the anchor is in the sheet and in both
 * channels' bytes, which is a claim about TEXT. "The selector reached a box on a page" is a
 * different claim, and this repository has been corrected for confusing the two ("声明不等于像素").
 * The value is taken from the rule rather than typed here for the same reason the corner fixture
 * reads its colours from the bundle: a check that compares the engine against a number copied into
 * this file grades the copy, not the page.
 *
 * Refuses to invent: no rule stamped with the todo-panel anchor, or no blur/saturate inside it,
 * throws. A fixture that could not find what it claims to measure has to say so at build time, not
 * read `none` and call that a result.
 */
function frostExpectation(materialCss) {
	const rule = walkCssBlocks(materialCss).find((b) => /\[data-testid="todo-panel"\]/.test(b.sel));
	if (!rule) {
		throw new Error('the shipped material sheet carries no rule stamped `[data-testid="todo-panel"]` — the frost group would be '
			+ 'measuring a page where the A1 anchor was never published, and every reading below would be a fact about a rule that does not exist');
	}
	const decl = (rule.body.match(/(?:^|[;\s])backdrop-filter\s*:\s*([^;]+)/i) || [])[1];
	if (!decl) {
		throw new Error(`the frost rule ("${rule.sel.slice(0, 60)}…") declares no backdrop-filter — the group would have nothing to reach`);
	}
	const blur = decl.match(/blur\(\s*([0-9.]+)(px|rem|em)?\s*\)/);
	const sat = decl.match(/saturate\(\s*([0-9.]+)(%)?\s*\)/);
	if (!blur || !sat) {
		throw new Error(`the frost rule's backdrop-filter reads "${decl.trim()}", which is not a blur() + saturate() the engine can be graded against`);
	}
	// Chrome serializes `saturate(140%)` as `saturate(1.4)`; the expectation has to be written the
	// way the engine writes it, or the comparison is about syntax rather than about pixels.
	const satValue = sat[2] ? String(Number(sat[1]) / 100) : sat[1];
	return {
		sel: rule.sel,
		raw: decl.trim(),
		blur: `blur(${blur[1]}${blur[2] || 'px'})`,
		saturate: `saturate(${satValue})`,
		// The rule lives inside `@supports (backdrop-filter: …)`. The engine's own answer is what
		// licenses the readings, so the group asks for it (the ref box) instead of assuming the
		// browser qualifies — a browser that cannot compute blur would otherwise read `none` on
		// every box and look like a rule that stopped matching.
		supportsGated: rule.conditional === true
	};
}

/** Assemble the three inputs. Missing inputs are errors, never thin fixtures. */
function buildFixture(opts = {}) {
	const root = opts.root || DEFAULT_HOST_ROOT;
	const source = opts.source || fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8');
	const sheets = extractSheets(source);
	const material = sheets.find((s) => /material/.test(s.id));
	if (!material) throw new Error('the material sheet is not in the bundle — the probe has nothing to measure');
	const parts = { material: material.css, hostRoot: root, corner: opts.corner || cornerTokens(source) };
	// Read from OUR OWN sheet before anything about the host is consulted: a frost rule that went
	// missing from the bundle must not hide behind "this machine has no host".
	parts.frost = frostExpectation(material.css);
	for (const spec of HOST_PACKAGES) {
		// Issue #102 + blue-team B4: three states, three different doors.
		//   no host install at all            -> environment skip
		//   host install, but this package gone -> RED (a rename/removal is the drift)
		//   package present, declaration gone -> RED
		if (!fs.existsSync(path.join(root, spec.pkg, 'lib', 'client.js'))) {
			if (!hostInstallPresent(root)) {
				throw environmentError(`host ${spec.key} CSS (${spec.pkg}) unreadable — no DSH host install at ${root}: `
					+ `the fixture would lose "${spec.why}" and the check could no longer fail`, 'host install');
			}
			throw new Error(`host ${spec.key} CSS (${spec.pkg}) is GONE from ${root} while the rest of the install is there — `
				+ `that is a rename or a removal, not a missing host; the fixture would lose "${spec.why}" and the check could no longer fail`);
		}
		const css = hostCss(root, spec.pkg, spec.must);
		if (!css) {
			throw new Error(`host ${spec.key} CSS (${spec.pkg}, looking for ${spec.must}) no longer declares it in ${root} — `
				+ `the fixture would lose "${spec.why}" and the check could no longer fail`);
		}
		parts[spec.key] = css;
	}
	const classes = hostFadeClasses(parts);
	parts.fadeClass = classes.fadeClass;
	parts.chatClass = classes.chatClass;
	const frame = hostLayoutClasses(parts);
	parts.frameClass = frame.frameClass;
	parts.centerColClass = frame.centerColClass;
	parts.sidebarColClass = frame.sidebarColClass;
	const side = hostSideFootClasses(parts);
	parts.footClass = side.footClass;
	parts.settingsClass = side.settingsClass;
	parts.actionsClass = side.actionsClass;
	const foot = hostSideFootRules(parts.sidebar, side);
	parts.hostFootRules = foot.rules;
	parts.hostFootConditionalSkipped = foot.skipped;
	const inset = hostSideInsets(parts.sidebar);
	parts.insetRootClass = inset.rootClass;
	parts.insetRootRule = inset.rootRule;
	parts.insetRegionClass = inset.regionClass;
	parts.insetRegionRule = inset.regionRule;
	return parts;
}

/** The page: host chrome on top, plugin sheet above it, three samples taken in one task. */
function fixtureHtml(parts) {
	// The fade / chat classes are the ones just read out of the host CSS (issue #105), and so
	// are the three AppFrame names (10.9.1). Deliberately NO remembered fallback: a page
	// built without the derivation would be a page measuring a class nobody renders, and that
	// is the failure this change removes.
	if (!parts.fadeClass || !parts.chatClass) {
		throw new Error('the host fade/chat classes were not derived from the host CSS — build the fixture through buildFixture()');
	}
	if (!parts.frameClass || !parts.centerColClass || !parts.sidebarColClass) {
		throw new Error('the host AppFrame classes were not derived from the host CSS — build the fixture through buildFixture()');
	}
	if (!parts.corner) {
		throw new Error('the corner fixture tokens were not read from the shipped bundle — build the fixture through buildFixture()');
	}
	if (!parts.footClass || !parts.settingsClass || !parts.actionsClass) {
		throw new Error('the host sidebar foot classes were not derived from the host CSS — build the fixture through buildFixture()');
	}
	if (!parts.hostFootRules) {
		throw new Error('the host\'s own foot-plane declarations were not read — without them the side group measures our sheet against a bare div, not against a cascade');
	}
	if (!parts.insetRootRule || !parts.insetRegionRule) {
		throw new Error('the host\'s own inset convention (the rule that DECLARES --dsh-sidebar-inline-padding, plus the region above the foot) was not read — '
			+ 'the -4px / -12px / 4px our alignment rule writes would then be literals compared against nothing');
	}
	if (!parts.frost || !parts.frost.raw) {
		throw new Error('the frosting declaration was not read out of the shipped material sheet — the frost group would have to INVENT '
			+ 'the value it claims the anchors reach (build the fixture through buildFixture())');
	}
	const fadeClass = parts.fadeClass;
	const chatClass = parts.chatClass;
	// Every CSS string below is interpolated into the page inside a `<style>` element, so one
	// `</` in any of them ends the sheet early and the readings come from a DIFFERENT document
	// than the one we think we built — while still looking like values. The host CSS is an
	// external string here (a `content:"…"` value can carry it), so this is a boundary, not a
	// formality. Refuse the page; do not sanitize it into a different document.
	const injected = {
		material: parts.material,
		hostFootRules: parts.hostFootRules,
		insetRootRule: parts.insetRootRule,
		insetRegionRule: parts.insetRegionRule,
	};
	for (const key of Object.keys(injected)) {
		if (String(injected[key] || '').indexOf('</') >= 0) {
			throw new Error(`the fixture cannot inject \`${key}\`: it carries "</", which would close a <style> element `
				+ 'and turn the measured page into a different document from the one the gate believes it built');
		}
	}
	// The frost declaration is interpolated into an ATTRIBUTE (`style="backdrop-filter:…"`), where
	// the hazard is a quote or an angle bracket rather than `</`. A ref box that is not the element
	// the checks think they built would grade a different page — refuse instead of escaping it into
	// something else.
	if (/["'<>]/.test(parts.frost.raw)) {
		throw new Error(`the frost declaration reads "${parts.frost.raw}", which cannot be injected into a style attribute — `
			+ 'the reference box would stop being the element the anchor readings are compared against');
	}
	const inJs = JSON.stringify('.' + fadeClass);
	const inJsChat = JSON.stringify('.' + chatClass);
	const inJsCenter = JSON.stringify('.' + parts.centerColClass);
	const inJsSidebar = JSON.stringify('.' + parts.sidebarColClass);
	const inJsFoot = JSON.stringify('.' + parts.footClass);
	const inJsRegion = JSON.stringify('.' + parts.insetRegionClass);
	const inJsSettings = JSON.stringify('.' + parts.settingsClass);
	const inJsActions = JSON.stringify('.' + parts.actionsClass);
	// THREE fixture choices here are load-bearing for the 10.9.3 judgement, and all were wrong
	// before it. (1) The canvas token is TRANSLUCENT: the real one is whatever the 弹窗透明度
	// slider publishes (measured 0.4 on the desktop profile), and an opaque token composites to
	// itself at any layer count, which would make "the band equals the column" true by accident —
	// a gate that cannot fail is the thing this repository keeps being corrected for. (2) BODY
	// paints the token: on the served page the stack under the columns starts at body, and the
	// strip sits in the frame's padding where the columns' own roots cannot reach, so body is the
	// one layer both stacks share. Without it the fixture's column was two deep while reality is
	// three, and the counts below would have been measuring a page nobody renders. (3) The RGB
	// comes from the SHIPPED bundle (`cornerTokens`), not from this file — until 10.10.0 the two
	// tokens here were typed (`rgba(16,16,24,…)`), so a skin repainting its canvas or sidebar
	// fill would have left this page measuring colours no skin ships while every relational check
	// stayed green. That is F14's shape, one group later than the fix.
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>:root{--dsw-alias-bg-base:${parts.corner['--dsw-alias-bg-base']};--dsw-specific-sidebar-fill:${parts.corner['--dsw-specific-sidebar-fill']};--dsw-alias-bg-layer-2:${parts.corner['--dsw-alias-bg-layer-2']};--dsh-session-list-edge-inset:8px;--dsh-windows-titlebar-height:34px}
body{background:var(--dsw-alias-bg-base)}</style>
<style>${parts.layout}
${parts.fade}
${parts.chat}</style>
<style id="fixture-chrome">#sidebar-fill-ref{position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-specific-sidebar-fill)}
/* THE LAYER THIS FIXTURE USED TO BE MISSING. Measured on the page the official shell
   serves (2026-10-09, desktop profile, nebula): the visible surface of the centre column is
   body + .centerCol + the app root INSIDE the column, three layers of the same canvas token,
   cumulative alpha 0.784 — while the caption strip is body + its own paint, two layers, 0.640.
   Without this element the fixture asserted "strip equals column" against a column that was
   one layer shallower than reality, which is how 10.9.2 passed every gate and still shipped a
   light band. Modelled as a fixture class, not a host hash: the layer is what matters, and its
   name is the host's to rename. */
.fixture-app-root{background:var(--dsw-alias-bg-base)}
/* THE DECOY (Roadmap A1). A second element whose class ALSO ends in "_footerActions", placed
   OUTSIDE the foot area. It stands for the components that really do use that suffix —
   dsh-client-ui-user-questions ships Mbwy4a_footerActions, and the desktop shell's corpus
   has a second base for it too. It carries its own paint and its own margin so that an
   UNSCOPED [class$="_footerActions"] cannot pass: our rule is (0,1,0) like this one and
   comes later in the document, so it would win, and the readings below would move. This is
   the half of the scoping claim a text gate cannot make. */
.fixture-decoy_footerActions{background:rgb(7, 7, 7);border-top:1px solid rgb(51, 51, 51);margin-left:0px;padding-left:0px}</style>
<style id="fixture-host-inset">${parts.insetRootRule}
${parts.insetRegionRule}</style>
<style id="fixture-host-foot">${parts.hostFootRules}</style>
<style id="plugin-material">${parts.material}</style>
</head><body>
<div class="${parts.frameClass}" data-shell-frame>
  <div class="${parts.sidebarColClass}"><div class="fixture-app-root">sidebar column
    <div class="${parts.insetRootClass}">
      <div class="${parts.insetRegionClass}">the region above the foot (the host owns this inset convention)</div>
      <div class="${parts.footClass}">
      <div class="${parts.actionsClass}">footer actions</div>
      <div class="${parts.settingsClass}">settings area</div>
    </div>
    <div class="fixture-decoy_footerActions">another component's footer</div>
    </div>
  </div></div>
  <div class="${parts.centerColClass}">
    <div class="fixture-app-root">
      <span class="${fadeClass}">fade</span>
      <div class="${chatClass}">chat scroll mask</div>
    </div>
  </div>
  <div data-shell-overlay>titlebar</div>
</div>
<i id="sidebar-fill-ref"></i>
<section id="frost-stage">
  <!-- ROADMAP A1, 10.13.0 — the union anchors, read as pixels.
       Both boxes carry a base name this sheet NEVER mentions (fixtureRolled_*), which is what
       "the host re-rolled its CSS-module hashes" looks like from the page's side. So the only way
       either reading can come out frosted is the attribute branch reaching a real element — the
       claim the pairing gate makes about TEXT and cannot make about boxes.
       The third element is the scoping half: its class also ends in "_panel", but it is not the
       dock's child, and the scoped anchor measured 12 distinct _panel bases on npm and 12 on the
       shell. Un-scope that selector and this box starts blurring — which is the issue-L1 failure,
       arriving through a suffix instead of a class. -->
  <div class="fixtureRolled_root" data-testid="todo-panel" id="frost-todo">the todo panel under a re-rolled base name</div>
  <div data-queue-dock id="frost-dock"><div class="fixtureRolled_panel" id="frost-dock-panel">the dock's direct child panel</div></div>
  <div class="fixtureForeign_panel" id="frost-decoy-panel">a _panel that belongs to nobody's dock</div>
</section>
<i id="frost-ref" style="backdrop-filter:${parts.frost.raw}"></i>
<script>
(function () {
  var frame = document.querySelector('[data-shell-frame]');
  var col = document.querySelector(${inJsCenter});
  var sidebarCol = document.querySelector(${inJsSidebar});
  var ref = document.getElementById('sidebar-fill-ref');
  var fade = document.querySelector(${inJs});
  var chat = document.querySelector(${inJsChat});
  var foot = document.querySelector(${inJsFoot});
  // The host's OWN bled region, sitting above the foot plane. It is the comparison this fix is
  // actually about: our rule exists to make the foot plane bleed to exactly the same outer box
  // as the region above it, so the seam between them closes. Measuring our own margin-left
  // against a typed -4px proves the declaration applied; measuring the foot's rect against
  // THIS element's rect proves the two line up on the page — and it needs no literal from us.
  var footRegion = document.querySelector(${inJsRegion});
  var footActions = document.querySelector(${inJsActions});
  var footSettings = document.querySelector(${inJsSettings});
  var footDecoy = document.querySelector('.fixture-decoy_footerActions');
  // The frost boxes (Roadmap A1): two surfaces carrying our hash-free anchors under a base name the
  // sheet never mentions, one _panel that is NOT the dock's child, and the reference box whose
  // inline style is the shipped declaration verbatim — the page's own answer to "what does that
  // text compute to", so no number from this file enters the comparison.
  var frostRef = document.getElementById('frost-ref');
  var frostTodo = document.getElementById('frost-todo');
  var frostDockPanel = document.getElementById('frost-dock-panel');
  var frostPanelDecoy = document.getElementById('frost-decoy-panel');
  var WASH = 'data-dsh-dream-skin-wash';
  var out = [];
  // ── the layer reader ──────────────────────────────────────────────────────
  // What the user compares at the top edge is the COMPOSITED colour, and a page builds that
  // out of every painting layer between the element and the wallpaper. getComputedStyle(el)
  // .backgroundColor — which is all this gate used to compare — sees ONE declaration, so a
  // strip that paints the same token once next to a column that paints it three times read
  // "equal" (measured 2026-10-09: 0.640 vs 0.784 cumulative alpha, and a light band on
  // screen). So: walk, collect every layer, composite over a fixed base.
  function parseColor(c) {
    var m = String(c).match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  }
  function splitTopLevel(s) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }
  // Every layer that paints this box: its own colour, then one per background-image layer.
  // A gradient counts ONLY when all its stops are the same colour — anything else is a band,
  // and a band cannot be composited by arithmetic, so the reading says "bad" and the check
  // reports itself broken rather than guessing.
  function layersOfBox(cs) {
    var list = [];
    var own = parseColor(cs.backgroundColor);
    if (own && own.a > 0) list.push(own);
    var img = cs.backgroundImage;
    if (img && img !== 'none') {
      splitTopLevel(img).forEach(function (layer) {
        var g = layer.match(/linear-gradient\\(([\\s\\S]*)\\)\\s*$/);
        if (!g) { list.push({ bad: true }); return; }
        var stops = splitTopLevel(g[1]).map(parseColor).filter(Boolean);
        if (!stops.length) { list.push({ bad: true }); return; }
        var same = stops.every(function (s) {
          return s.a === stops[0].a && s.rgb[0] === stops[0].rgb[0] && s.rgb[1] === stops[0].rgb[1] && s.rgb[2] === stops[0].rgb[2];
        });
        if (!same) { list.push({ bad: true }); return; }
        if (stops[0].a > 0) list.push(stops[0]);
      });
    }
    return list;
  }
  function stackOf(el, pseudo) {
    var list = [];
    if (pseudo) {
      // The pseudo-element box paints ON TOP of its originating element's own background, so
      // that background is part of the stack a user sees. Skipping it (as the first draft did)
      // made the plain-state band read one layer deep when the page actually paints three.
      list = list.concat(layersOfBox(getComputedStyle(el, pseudo)));
    }
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 30) {
      list = list.concat(layersOfBox(getComputedStyle(cur)));
      cur = cur.parentElement;
    }
    return list;
  }
  // Composited over white, so the reading is a colour a human can compare, not an exponent.
  function composite(list) {
    if (!list.length || list.some(function (l) { return l.bad; })) return null;
    var r = 255, g = 255, b = 255;
    list.forEach(function (l) {
      r = l.rgb[0] * l.a + r * (1 - l.a);
      g = l.rgb[1] * l.a + g * (1 - l.a);
      b = l.rgb[2] * l.a + b * (1 - l.a);
    });
    return 'rgb(' + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) + ')';
  }
  function sample(label) {
    // The caption row is a PSEUDO-ELEMENT of the frame, not the frame: a separate box with
    // its own paint, and a background-color set on the element does not reach it. Reading
    // getComputedStyle(frame) — all this page used to sample — therefore says nothing about
    // the strip across the top of the window.
    var strip = getComputedStyle(frame, '::before');
    var bandList = stackOf(frame, '::before');
    var contentList = stackOf(col.querySelector('.fixture-app-root') || col, null);
    // Every background-image layer on the strip must be OUR token, not a leftover host paint:
    // the reset is a shorthand precisely so a host gradient cannot survive under it, and this
    // is the reading that proves it did not (10.9.3 adds a gradient of its own, so "image is
    // none" is no longer the promise — "every image layer is the canvas token" is).
    var canvas = parseColor(getComputedStyle(col).backgroundColor);
    var imageLayers = strip.backgroundImage && strip.backgroundImage !== 'none' ? splitTopLevel(strip.backgroundImage) : [];
    var imageOnToken = imageLayers.every(function (layer) {
      var g = layer.match(/linear-gradient\\(([\\s\\S]*)\\)\\s*$/);
      if (!g || !canvas) return false;
      return splitTopLevel(g[1]).every(function (stop) {
        var c = parseColor(stop);
        return !!c && c.a === canvas.a && c.rgb.join(',') === canvas.rgb.join(',');
      });
    });
    out.push({
      state: label,
      corner: getComputedStyle(col).borderTopLeftRadius,
      frameFill: getComputedStyle(frame).backgroundColor,
      stripFill: strip.backgroundColor,
      stripImage: strip.backgroundImage,
      stripContent: strip.content,
      stripRegion: strip.webkitAppRegion || strip.getPropertyValue('-webkit-app-region').trim(),
      // GEOMETRY, not just paint. The caption box is the drag surface, and a declaration that
      // moves it (a transform, or an inset rewrite) leaves every reading above untouched: the fill
      // is cleared, the box is still generated, content still reads "", and the COMPUTED
      // -webkit-app-region still reads drag — while the strip the user can actually grab has been
      // dragged off the top of the window (measured: both mutations produce exactly that
      // signature). Adjudication J1 (T1/T6).
      stripTop: strip.top,
      stripHeight: strip.height,
      stripTransform: strip.transform,
      sidebarColFill: getComputedStyle(sidebarCol).backgroundColor,
      // ROADMAP A1 — the sidebar foot plane, read off boxes rather than off text.
      // margin-left is the declaration our alignment rule writes (-4px); the host's own
      // value there is 0px, so a -4px reading proves two things at once: the hash-free
      // [class$="_footArea"] anchor reaches a real element, and it reaches the nested two
      // through the descendant combinator. The decoy is the scoping half: its class ALSO
      // ends in _footerActions but it is not inside the foot area, so it must keep its own
      // margin, paint and border.
      footMarginLeft: foot ? getComputedStyle(foot).marginLeft : 'MISSING',
      footMarginRight: foot ? getComputedStyle(foot).marginRight : 'MISSING',
      footPaddingLeft: foot ? getComputedStyle(foot).paddingLeft : 'MISSING',
      footPaddingRight: foot ? getComputedStyle(foot).paddingRight : 'MISSING',
      footBg: foot ? getComputedStyle(foot).backgroundColor : 'MISSING',
      // Are the HOST's own foot declarations actually in this page? Every reading above would
      // still come out "right" on a fixture where our sheet is applied to a bare div, and that
      // is a different page from the one the user runs. display / flex-direction are the tell:
      // the host writes them for its own footArea class, we never do, so a block/row reading
      // here means the host block went missing and the whole group stopped being a cascade test.
      footDisplay: foot ? getComputedStyle(foot).display : 'MISSING',
      footFlexDirection: foot ? getComputedStyle(foot).flexDirection : 'MISSING',
      footShadow: foot ? getComputedStyle(foot).boxShadow : 'MISSING',
      footBorderTop: foot ? getComputedStyle(foot).borderTopWidth : 'MISSING',
      // GEOMETRY against the host's own bled region (see the lookup above). rect values are
      // floats, so they are rounded to whole pixels here — the claim is "these two edges are the
      // same line on the page", which is a sub-pixel question nobody is making.
      footRectLeft: foot ? Math.round(foot.getBoundingClientRect().left) + 'px' : 'MISSING',
      footRectRight: foot ? Math.round(foot.getBoundingClientRect().right) + 'px' : 'MISSING',
      regionRectLeft: footRegion ? Math.round(footRegion.getBoundingClientRect().left) + 'px' : 'MISSING',
      regionRectRight: footRegion ? Math.round(footRegion.getBoundingClientRect().right) + 'px' : 'MISSING',
      regionMarginLeft: footRegion ? getComputedStyle(footRegion).marginLeft : 'MISSING',
      regionMarginRight: footRegion ? getComputedStyle(footRegion).marginRight : 'MISSING',
      // The variable OUR rule falls back on, read off the foot box: with the host's own root
      // rule in the page this resolves from the HOST, so -12px stops being our fallback
      // agreeing with itself.
      insetVarOnFoot: foot ? getComputedStyle(foot).getPropertyValue('--dsh-sidebar-inline-padding').trim() : 'MISSING',
      settingsWidth: footSettings ? getComputedStyle(footSettings).width : 'MISSING',
      actionsMarginLeft: footActions ? getComputedStyle(footActions).marginLeft : 'MISSING',
      settingsMarginLeft: footSettings ? getComputedStyle(footSettings).marginLeft : 'MISSING',
      decoyMarginLeft: footDecoy ? getComputedStyle(footDecoy).marginLeft : 'MISSING',
      decoyBg: footDecoy ? getComputedStyle(footDecoy).backgroundColor : 'MISSING',
      decoyBorder: footDecoy ? getComputedStyle(footDecoy).borderTopWidth : 'MISSING',
      // ── ROADMAP A1, 10.13.0 — the union anchors as COMPUTED VALUES ──
      // frostRef is an element styled INLINE with the shipped declaration text, so it reports what
      // this engine makes of that text. The two anchor boxes are then graded against it: an anchor
      // that stopped reaching a real element reads 'none' while the ref still blurs, and no number
      // typed into a file is part of that comparison.
      frostRef: frostRef ? (getComputedStyle(frostRef).backdropFilter || 'none') : 'MISSING',
      frostTodoPanel: frostTodo ? (getComputedStyle(frostTodo).backdropFilter || 'none') : 'MISSING',
      frostDockPanel: frostDockPanel ? (getComputedStyle(frostDockPanel).backdropFilter || 'none') : 'MISSING',
      frostPanelDecoy: frostPanelDecoy ? (getComputedStyle(frostPanelDecoy).backdropFilter || 'none') : 'MISSING',
      // The surface the caption band sits above. The band's promise (10.9.2) is "look like the
      // content column", so the comparison target has to be MEASURED, not typed into this file —
      // a hand-copied colour here would keep "passing" after the skin, the slider or the token
      // moved, which is the F14 family of error this gate has been corrected for twice.
      centerColFill: getComputedStyle(col).backgroundColor,
      // WHAT THE PIXELS ACTUALLY DO. Own declarations were the 10.9.2 comparison and it was
      // satisfied while the band read light, because the column paints the token more times than
      // the strip does. These are the composited results over a fixed base, plus how many layers
      // each stack has — the count is what turns "equal" from a coincidence into a claim.
      bandComposite: composite(bandList),
      contentComposite: composite(contentList),
      bandLayers: bandList.length,
      contentLayers: contentList.length,
      stripImageOnToken: imageOnToken,
      refFill: getComputedStyle(ref).backgroundColor,
      fadeBg: fade ? getComputedStyle(fade).backgroundImage : null,
      fadeMask: fade ? getComputedStyle(fade).maskImage : null,
      chatMask: chat ? getComputedStyle(chat).maskImage : null
    });
  }
  document.documentElement.setAttribute('data-windows-titlebar', '');
  sample('plain');
  document.documentElement.setAttribute(WASH, '');
  sample('wash');
  document.documentElement.removeAttribute(WASH);
  document.documentElement.setAttribute(WASH, '');
  document.documentElement.removeAttribute(WASH);
  sample('washed-again');
  document.title = 'DSH_RESULTS' + JSON.stringify(out);
})();
<\/script></body></html>`;
}

/**
 * The COEXISTENCE page (issue #105): the same host fade, our shipped material sheet, and
 * the other plugin's real `_fade` rule composed the way that bundle builds it.
 *
 * Two elements, because the question has two halves:
 *   - `#fade-real`  carries no inline style, so it answers "does the band stay gone when
 *     both plugins are active" — the user-visible question;
 *   - `#fade-probe` carries `background: rgb(1, 2, 3)` INLINE. Inline style outranks a
 *     non-`!important` rule, so it is a cascade LITMUS: where the probe still shows the
 *     sentinel, the winning declaration was not `!important`; where it goes transparent, an
 *     `!important` rule took the element. That is what makes "who covers whom" measurable
 *     rather than argued — both rules paint the same final colour, so the visible result
 *     alone cannot attribute the win.
 */
function coexistFixtureHtml(parts, plugin) {
	// Debt ① was not finished when only `fixtureHtml` learned to read its colours out of the shipped
	// bundle: this page kept two typed rgba values, which is the same自证式探针 shape (the gate
	// measures a colour no skin ships, and a skin repaint cannot make it red). The coexist verdicts
	// are relational, so nothing here depended on the colours being REAL — but "relational" is exactly
	// how the corner group stayed green while measuring nothing, so the refusal is repeated here.
	if (!parts.corner) {
		throw new Error('the coexist fixture tokens were not read from the shipped bundle — build the fixture through buildFixture()');
	}
	const corner = parts.corner;
	const probe = JSON.stringify('#fade-probe');
	const real = JSON.stringify('#fade-real');
	const chat = JSON.stringify('#chat-mask');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>:root{--dsw-alias-bg-base:${corner['--dsw-alias-bg-base']};--dsw-specific-sidebar-fill:${corner['--dsw-specific-sidebar-fill']};--dsh-session-list-edge-inset:8px}</style>
<style>${parts.fade}
${parts.chat}</style>
<style id="plugin-material">${parts.material}</style>
<style id="other-plugin">${plugin.css}</style>
</head><body>
<div data-slot="sidebar.workspaces">
  <span id="fade-real" class="${parts.fadeClass}">fade</span>
  <span id="fade-probe" class="${parts.probeClass}" style="background: rgb(1, 2, 3)">probe</span>
  <div id="chat-mask" class="${parts.chatClass}">chat scroll mask</div>
</div>
<script>
(function () {
  var real = document.querySelector(${real});
  var probe = document.querySelector(${probe});
  var chat = document.querySelector(${chat});
  var WASH = 'data-dsh-dream-skin-wash';
  var THEIR = 'data-dsh-skin';
  var out = [];
  function cs(el, prop) { return el ? getComputedStyle(el)[prop] : null; }
  function sample(label) {
    out.push({
      state: label,
      realBg: cs(real, 'backgroundImage'),
      realColour: cs(real, 'backgroundColor'),
      probeBg: cs(probe, 'backgroundColor'),
      chatMask: cs(chat, 'maskImage'),
      wash: document.documentElement.hasAttribute(WASH),
      theirs: document.documentElement.hasAttribute(THEIR)
    });
  }
  sample('plain');
  document.documentElement.setAttribute(WASH, '');
  sample('wash');
  document.documentElement.setAttribute(THEIR, '');
  sample('coexist');
  document.documentElement.removeAttribute(WASH);
  sample('their-only');
  document.title = 'DSH_RESULTS' + JSON.stringify(out);
})();
<\/script></body></html>`;
}

/** Build the coexistence inputs: the real host CSS + the real plugin rule. */
function buildCoexistFixture(opts = {}) {
	const parts = opts.parts || buildFixture(opts);
	// A probe element needs a class our OWN anchor reaches and the host does not paint:
	// the suffix form is what both plugins address, so `<derived>_fade` shape is reused.
	parts.probeClass = parts.fadeClass;
	return parts;
}

/** Measure the coexistence page. Skips (environment) when the other plugin is not here. */
function measureCoexist(opts = {}) {
	const plugin = opts.plugin || pluginFadeRule(opts.env);
	const parts = buildCoexistFixture(opts);
	const r = runChrome(coexistFixtureHtml(parts, plugin), opts.env);
	if (r.ran) r.provenance = `${SKIN_CENTER_PKG}${plugin.version ? '@' + plugin.version : ''} — ${plugin.selector}`;
	return r;
}

/**
 * What the coexistence page must say. Four states, and the pair that matters is
 * `wash` vs `coexist`: the probe keeps the sentinel colour under OUR rule (not
 * `!important` — inline wins) and loses it once their `!important` rule is on the page,
 * while the real element's band stays neutralised in BOTH. That is the sentence
 * "who covers whom" needed: the stronger lane is theirs on `background`, and the
 * overlap costs the user nothing because both lanes paint the same nothing.
 */
const COEXIST_CHECKS = [
	{ id: 'coexist-host-paints', msg: 'plain: the host must really paint the foot-fade band, or every claim below is vacuous', ok: (r) => /linear-gradient/.test(r.plain.realBg || '') },
	{ id: 'coexist-ours-kills-band', msg: 'wash: our rule neutralises the band on its own', ok: (r) => r.wash.realBg === 'none' },
	{ id: 'coexist-ours-not-important', msg: 'wash: the probe keeps its INLINE sentinel under our rule — ours is a normal declaration, and saying so is the only way the next line means anything', ok: (r) => r.wash.probeBg === 'rgb(1, 2, 3)' },
	{ id: 'coexist-their-lane-stronger', msg: 'coexist: with their rule in the page the probe goes transparent despite the inline style — an !important lane outranks ours on this element, which is the cascade answer #105 asked for', ok: (r) => r.coexist.probeBg === 'rgba(0, 0, 0, 0)' && r.wash.probeBg === 'rgb(1, 2, 3)' },
	{ id: 'coexist-user-result-agrees', msg: 'coexist: the face the USER sees stays neutralised whichever lane wins — the overlap costs nothing', ok: (r) => r.coexist.realBg === 'none' && r.wash.realBg === 'none' },
	{ id: 'coexist-band-gated', msg: 'their-only: with our wash gone, our rule stops applying and their rule alone is what holds the band down — proving our gate is genuinely gated', ok: (r) => r['their-only'].probeBg === 'rgba(0, 0, 0, 0)' && r['their-only'].wash === false },
	{ id: 'coexist-chat-mask-untouched', msg: 'their broader [class*="_fade"] DOES reach the chat scroll masks, so read it: their rule must not change what those masks compute (they paint background, masks paint nothing)', ok: (r) => r.coexist.chatMask === r.plain.chatMask && /linear-gradient/.test(r.plain.chatMask || '') }
];

/** Grade the coexistence readings from the fixed state list, naming any state that is missing. */
function checkCoexistReadings(readings) {
	const states = ['plain', 'wash', 'coexist', 'their-only'];
	const byState = {};
	for (const r of readings || []) byState[r.state] = r;
	const missing = states.filter((s) => !byState[s]);
	if (missing.length) return [`coexist: the page never produced ${missing.join(', ')} — refusing to grade a run with states missing`];
	const problems = [];
	for (const check of COEXIST_CHECKS) {
		let held = false;
		try { held = check.ok(byState); } catch (e) { problems.push(`${check.id}: the check itself threw (${e.message})`); continue; }
		if (!held) problems.push(`${check.id}: ${check.msg} (readings ${JSON.stringify(byState)})`);
	}
	return problems;
}

/**
 * Which browsers to try, in order, and why the list is a list.
 *
 * `findChrome` (the preview gate's helper) stops at the FIRST path that exists, which is the
 * right behaviour for generating PNGs and the wrong one for a check other people have to be
 * able to re-run: the 10.8.1 review round could not run this gate at all on the very machine
 * that ships it — every spawn came back `EBUSY`, a Windows "somebody else is holding that
 * file/profile" error, and a computed-style gate that only runs on one laptop is a claim
 * rather than a check.
 *
 * An explicit `CHROME_PATH` stays authoritative and gets NO fallback (issue #83's rule:
 * being told which engine to use and then quietly using another one is worse than failing).
 */
function browserAttempts(env, candidates = CHROME_CANDIDATES) {
	if (env && env.CHROME_PATH) {
		const one = findChrome(env);
		return { list: one.path ? [one.path] : [], why: one.why };
	}
	const list = candidates.filter((p) => {
		try { return fs.existsSync(p); } catch { return false; }
	});
	return {
		list,
		why: list.length ? 'auto-detected'
			: `no headless browser found; looked at ${candidates.length} known locations`
	};
}

/** Render one page in headless Chrome and read the marker out of its <title>. */
function runChrome(html, env) {
	const attempts = browserAttempts(env || process.env);
	if (!attempts.list.length) return { ran: false, why: attempts.why };
	const failures = [];
	for (const exe of attempts.list) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wash-'));
		const file = path.join(dir, 'fixture.html');
		// A profile of our own, inside the temp dir this call already cleans up. The default
		// profile belongs to the browser somebody is typing into; a second instance aimed at
		// it contends for locks, which is exactly how the EBUSY above arrived.
		const profile = path.join(dir, 'profile');
		try {
			fs.mkdirSync(profile);
			fs.writeFileSync(file, html);
			const dom = execFileSync(exe, [
				'--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
				// Roadmap M (CI): a shared-memory-starved container kills the renderer the moment
				// the page asks for one, and the gate would report "every candidate failed to
				// launch" on a runner that has Chrome. Inert on Windows/macOS, where /dev/shm is
				// not a fixed 64 MB tmpfs.
				'--disable-dev-shm-usage',
				'--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile,
				'--virtual-time-budget=2000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')
			], { encoding: 'utf8', maxBuffer: 32e6, timeout: 90000 });
			// The page publishes into <title>; `--dump-dom` escapes the quotes, so decode
			// before parsing. A page that produced no marker is an error, not an empty pass.
			const raw = dom.match(/DSH_RESULTS([\s\S]*?)<\/title>/);
			if (!raw) return { ran: true, error: `no results marker in the dumped DOM (${path.basename(exe)})`, dom: dom.slice(0, 500) };
			const json = raw[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
			try {
				return { ran: true, readings: JSON.parse(json), via: path.basename(exe) };
			} catch (e) {
				return { ran: true, error: 'readings did not parse: ' + e.message, dom: json.slice(0, 500) };
			}
		} catch (e) {
			// Only a LAUNCH/EXIT failure moves on to the next candidate. A page that ran and
			// read wrong is a fixture problem, and swapping browsers would mask it.
			failures.push(`${path.basename(exe)}: ${e.code || e.message}`.slice(0, 160));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	return {
		ran: false,
		why: `every candidate failed to launch (${failures.join(' | ')}) — tried ${attempts.list.map((p) => path.basename(p)).join(', ')}`
	};
}

/**
 * Run the host fixture through headless Chrome and return the computed readings.
 * @param {{parts?: object, env?: object}} opts `parts` lets a caller probe a MUTATED
 *        sheet; by default the shipped bundle and the installed host are used.
 */
function measure(opts = {}) {
	const parts = opts.parts || buildFixture(opts);
	return runChrome(fixtureHtml(parts), opts.env);
}

/**
 * Issue #102 — can an engine actually be SPAWNED here?
 *
 * "A browser binary exists at a known path" was the only precondition the test file had,
 * and it is not the same fact: on the 10.8.1 review machine every spawn came back EBUSY
 * (the binary is there, the OS refuses to start it), which turned 7 computed-style cases
 * RED — indistinguishable, to whoever reads the output, from the cascade having actually
 * broken. This probe runs one trivial page (no host, no bundle, nothing to disagree
 * about) and reports which of the three states this machine is in, so the caller can skip
 * with a named reason instead of failing with a misleading one. It never throws.
 */
function probeBrowser(env) {
	const attempts = browserAttempts(env || process.env);
	if (!attempts.list.length) return { ran: false, why: attempts.why };
	const r = runChrome('<!doctype html><html><head><title>DSH_RESULTS[]</title></head><body></body></html>', env);
	if (r.ran) return { ran: true, via: r.via, why: '' };
	return { ran: false, why: `${r.why} — the binary is present but cannot be spawned here` };
}

/**
 * The DSH Desktop shell's own rules, copied verbatim from the shell at tag v2.0.17:
 * `dsh-plugin-desktop/src/client/styles.ts:13,14,22,23,24,38` in
 * anywhere-labs/dsh-desktop — :23 the sidebar base (token + `background: transparent`),
 * :24 the `material=off` pair (token AND `background: var(--dsw-alias-bg-layer-1)`),
 * :22 the frame that wraps the sidebar, :38 the Windows rule that makes that aside span
 * both grid rows (so it is also the strip under the title bar), :13/:14 `#root` sizing and
 * the shell's own transparent body.
 *
 * WHY A SNAPSHOT, AND WHAT IT CANNOT CLAIM. The shell is a third-party plugin with no
 * local install to read, so unlike every other input in this file the shell text is
 * copied. It is pinned by tag and re-fetchable — the two sidebar lines are byte-identical
 * at v2.0.5 / v2.0.10 / v2.0.17, which anyone can check with:
 *
 *   for t in v2.0.5 v2.0.10 v2.0.17; do curl -s \
 *     "https://raw.githubusercontent.com/anywhere-labs/dsh-desktop/$t/dsh-plugin-desktop/src/client/styles.ts" \
 *     | grep -h "dshDesktopSidebarSurface { --dsw-specific-sidebar-fill\|material=\"off\"] .dshDesktopSidebarSurface" | md5sum; done
 *     # all three: 0cf2ba653a78ba7c9660a51782dc1131 (the lines sit at :16 and :17 there)
 *
 * What the snapshot CAN prove is the layer stack: whether our declaration beats theirs,
 * whether anything opaque is left between the sidebar content and the wallpaper, and
 * whether our win still depends on `!important`. What it can NEVER prove is that a real
 * user in a real shell sees the wallpaper — there are no pixels in this file, and nobody
 * has run the shell yet. If the shell renames its class the snapshot does not go red by
 * itself; `buildDesktopFixture` therefore guards the exact declarations these checks read
 * (any one of them missing = the fixture refuses to run), and the drift probe keeps
 * watching `.dshDesktopSidebarSurface` on a live shell.
 */
const DESKTOP_SHELL_SOURCE = 'anywhere-labs/dsh-desktop v2.0.17 — dsh-plugin-desktop/src/client/styles.ts:13,14,22,23,24,38 (sidebar pair md5 0cf2ba65… at v2.0.5 / v2.0.10 / v2.0.17)';
const DESKTOP_SHELL_CSS = `
html, body, #root { width: 100%; height: 100%; }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"]) { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"])[data-dsh-desktop-material="off"] .dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1); background: var(--dsw-alias-bg-layer-1); }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
`.trim();

/** The state the shell runs in on Windows (environment.ts:24 admits four markers, :51-53 folds
 *  acrylic/mica to off, and :58+:61 THROW for win32 + transparent — so `off` is not a choice). */
const DESKTOP_SHELL_BODY_ATTRS = 'data-dsh-desktop-mode="advanced" data-dsh-desktop-material="off" data-desktop-platform="win32"';

/**
 * Read one skin's tokens out of the SHIPPED bundle, so the desktop fixture never grades
 * colors somebody typed into a test. Review finding F14 (10.8.1) caught the first version
 * doing exactly that: it asserted `rgba(30,27,44,0.96)`, a value this file invented, so
 * "the shell really paints an underlay" was this file reading back its own handwriting.
 * The real bundle disagrees per skin — `--dsw-alias-bg-layer-1` is an opaque hex for seven
 * skins but `rgba(240, 248, 255, 0.62)` for mist — so the page runs once per skin, every
 * reading carries the inputs it was taken against, and the checks talk about ALPHA, not
 * about colors this file chose.
 */
function skinTokens(source, id) {
	const re = new RegExp('\\{\\s*id: "' + id + '",\\s*colorScheme: "(?:dark|light)",\\s*tokens: \\{([\\s\\S]*?)\\n\\t{4}\\}', '');
	const hit = source.match(re);
	if (!hit) throw new Error(`skin ${JSON.stringify(id)} is not in the shipped bundle — the desktop fixture has no colors to measure`);
	const tokens = {};
	for (const m of hit[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)) tokens[m[1]] = m[2];
	for (const need of ['--dsw-alias-bg-layer-1', '--dsw-alias-border-l1', '--dsw-specific-sidebar-fill']) {
		if (!tokens[need]) throw new Error(`skin ${id} ships no ${need} in the bundle — the fixture would have to invent it`);
	}
	return tokens;
}

/** One skin whose layer-1 is fully opaque and one whose is not: the fix must hold for both. */
const DESKTOP_SKINS = ['abyss', 'mist'];

/**
 * The sentinel the page writes into `--dsw-specific-sidebar-fill` to imitate a slider
 * movement, and the value the checks compare the sweep reading against — ONE constant, so
 * the fixture and the verdict table cannot disagree about what "the token moved" means.
 */
const DESKTOP_SWEEP = 'rgba(7, 7, 7, 0.25)';

/**
 * Find ONE declaration in the installed host that paints from the sidebar token, so the
 * fixture's consumer element uses the host's own form of the read rather than a guess.
 * @returns {string|null} the declaration, or null when no installed host reads the token
 */
function hostSidebarConsumer(root) {
	const css = hostCss(root, 'dsh-client-ui-sidebar', '--dsw-specific-sidebar-fill')
		|| hostCss(root, 'dsh-client-ui-layout', '--dsw-specific-sidebar-fill');
	if (!css) return null;
	// Prefer a FILL property. Taking "the first match" was blue-team dimension #8: if the
	// host's first consumer happened to be `border-color: var(...)`, the fixture's consumer
	// element would have no background to compute and the slider-sweep check would go red —
	// loud rather than silently passing, but a gate whose shape depends on which declaration a
	// bundle happens to list first is not a gate. Non-fill properties stay as the fallback so a
	// host that never paints from the token still produces a fixture that FAILS visibly.
	const hit = css.match(/background(?:-color)?:\s*var\(--dsw-specific-sidebar-fill\)/)
		|| css.match(/[-a-z]+:\s*var\(--dsw-specific-sidebar-fill\)/);
	return hit ? hit[0] : null;
}

/** Assemble the desktop page. Missing inputs are errors, never a thinner fixture. */
function buildDesktopFixture(opts = {}) {
	const root = opts.root || DEFAULT_HOST_ROOT;
	const source = opts.source || fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8');
	const sheets = extractSheets(source);
	const material = sheets.find((s) => /material/.test(s.id));
	if (!material) throw new Error('the material sheet is not in the bundle — the desktop probe has nothing to measure');
	// Every declaration these checks read is guarded by name. Review finding F8 (10.8.1):
	// the first guard only looked for the class and the `off` branch, so deleting the
	// shell's token re-declaration from the copy left a fixture that still claimed to
	// prove the issue #55 half of the story. The guard runs over the text the PAGE will
	// actually carry (`opts.shell` exists so a test can hand it a trimmed copy and watch it
	// refuse — a guard that only ever sees the shipped constant proves nothing about itself).
	const shell = opts.shell === undefined ? DESKTOP_SHELL_CSS : opts.shell;
	for (const [needle, why] of [
		['.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent;', 'the base rule the #55 `inherit` fix has to outrank'],
		['--dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1); background: var(--dsw-alias-bg-layer-1);', 'the material=off pair — token AND paint, which is the whole shape of issue #99'],
		['.dshDesktopFrame { position: relative; display: grid;', 'the frame the paint-order walk passes through on the way to the wallpaper'],
		['[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }', 'the Windows fact that this aside is also the strip under the title bar']
	]) {
		if (!shell.includes(needle)) {
			throw new Error(`the shell snapshot lost ${JSON.stringify(needle)} — that fixture would no longer measure ${why}`);
		}
	}
	const skin = opts.skin || DESKTOP_SKINS[0];
	const tokens = skinTokens(source, skin);
	const consumer = opts.consumer === undefined ? hostSidebarConsumer(root) : opts.consumer;
	if (!consumer) {
		// Same three-way split as above (issue #102 + blue-team B4). A host whose sidebar
		// package was RENAMED is the drift this fixture exists to notice; a machine with no
		// host at all is an environment skip.
		const looked = `(looked in dsh-client-ui-sidebar / -layout under ${root})`;
		const tail = 'the fixture would lose "does the slider path still reach the sidebar", and the desktop check could no longer fail';
		if (!hostInstallPresent(root)) {
			throw environmentError(`installed host has no declaration reading --dsw-specific-sidebar-fill ${looked} — ${tail}`, 'host install');
		}
		throw new Error(`the installed host stopped reading --dsw-specific-sidebar-fill ${looked} — that is a rename or a removal, not a missing host; ${tail}`);
	}
	return { material: material.css, shell, consumer, skin, tokens, hostRoot: root };
}

/**
 * The page. Two things are here that the first version lacked, both from the review:
 * the shell's real ANCESTORS (`#root` > `.dshDesktopFrame` > aside), because a cleared
 * aside still says nothing if an ancestor paints opaque over the wallpaper (F9); and a
 * reference element painted from `--dsw-alias-bg-layer-1` off-screen, so "the aside now
 * shows the skin's own layer-1" is compared against a normalized color the engine
 * produced rather than a string this file wrote.
 */
function desktopFixtureHtml(parts) {
	return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
		+ '<style id="skin-tokens">:root{'
		+ '--dsw-alias-bg-layer-1:' + parts.tokens['--dsw-alias-bg-layer-1'] + ';'
		+ '--dsw-alias-border-l1:' + parts.tokens['--dsw-alias-border-l1'] + ';'
		+ '--dsw-specific-sidebar-fill:' + parts.tokens['--dsw-specific-sidebar-fill'] + ';}</style>'
		+ '<style id="desktop-shell">' + parts.shell + '</style>'
		+ '<style id="fixture-chrome">#layer1-ref{position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-layer-1)}'
		+ '#dsh-wash-layer{position:fixed;inset:0;z-index:-1;background:rgb(1,2,3)}</style>'
		+ '<style id="host-sidebar">#upstream-sidebar{' + parts.consumer + ';height:120px}</style>'
		+ '<style id="plugin-material">' + parts.material + '</style>'
		+ '</head><body ' + DESKTOP_SHELL_BODY_ATTRS + '>'
		+ '<div id="dsh-wash-layer"></div><i id="layer1-ref"></i>'
		+ '<div id="root"><div class="dshDesktopFrame" data-desktop-mode="advanced" data-desktop-platform="win32">'
		+ '<aside class="dshDesktopSidebarSurface"><div id="upstream-sidebar">sidebar</div></aside>'
		+ '</div></div>'
		+ '<script>' + DESKTOP_PAGE_SCRIPT
			.split('__SKIN__').join(JSON.stringify(parts.skin))
			.split('__SWEEP__').join(JSON.stringify(DESKTOP_SWEEP)) + '<\/script></body></html>';
}

/** What the desktop page samples. `blockers` is the answer to "is anything still in the way". */
const DESKTOP_PAGE_SCRIPT = `
(function () {
  var aside = document.querySelector('.dshDesktopSidebarSurface');
  var inner = document.getElementById('upstream-sidebar');
  var ref = document.getElementById('layer1-ref');
  var WASH = 'data-dsh-dream-skin-wash';
  var out = [];
  function alphaOf(value) {
    if (!value || value === 'none' || value === 'transparent') return 0;
    var m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return /^#[0-9a-f]{6}$/i.test(String(value).trim()) ? 1 : 0;
    var p = m[1].split(/[,\\/]/);
    return p.length < 4 ? 1 : Number(p[3].trim());
  }
  // The walk starts at the SHELL surface (the aside), not at the sidebar content: the
  // content's own alpha IS the user's slider position, which is the thing we must not
  // count as an obstacle. Anything opaque from the aside upward is not a user choice — it
  // is the shell, and that is exactly what issue #99 is about. Clearing the aside means
  // nothing if an ancestor (the frame, #root, body) still paints opaque over the
  // wallpaper, so the chain has to be walked rather than a single element sampled.
  function blockers(el) {
    var hits = [];
    for (var cur = el; cur && cur.tagName !== 'HTML'; cur = cur.parentElement) {
      if (alphaOf(getComputedStyle(cur).backgroundColor) >= 0.999) hits.push(cur.id || cur.className);
    }
    return hits;
  }
  // SLIDER SWEEP: the real slider's path (storage → shadeTokens2 → the published token) is
  // covered by tests/client.smoke.test.cjs; what this page can prove, and nothing else in
  // this repository can, is that the token the plugin publishes actually reaches the
  // sidebar's PIXELS in the shell's own DOM. So the fixture writes a sentinel token the way
  // the slider would and reads the consumer element back: if the shell's shadow
  // ('--dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1)') were still winning, the
  // sweep value would not appear and issue #55 would be silently back.
  var SWEEP = __SWEEP__;
  function sample(label) {
    var s = getComputedStyle(aside);
    var box = inner.getBoundingClientRect();
    var hit = document.elementFromPoint(Math.round(box.left + box.width / 2), Math.round(box.top + 12));
    var row = {
      state: label,
      skin: __SKIN__,
      layer1Css: getComputedStyle(ref).backgroundColor,
      surfaceBg: s.backgroundColor,
      surfaceFill: s.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      borderRight: s.borderRightWidth + ' ' + s.borderRightStyle,
      sidebarBg: getComputedStyle(inner).backgroundColor,
      blockers: blockers(aside).join('|'),
      hit: hit ? (hit.id || hit.className) : 'none'
    };
    document.documentElement.style.setProperty('--dsw-specific-sidebar-fill', SWEEP);
    row.sweepBg = getComputedStyle(inner).backgroundColor;
    row.sweepAside = getComputedStyle(aside).backgroundColor;
    document.documentElement.style.removeProperty('--dsw-specific-sidebar-fill');
    out.push(row);
  }
  sample('plain');
  document.documentElement.setAttribute(WASH, '');
  sample('wash');
  document.documentElement.removeAttribute(WASH);
  document.documentElement.setAttribute(WASH, '');
  document.documentElement.removeAttribute(WASH);
  sample('washed-again');
  document.title = 'DSH_RESULTS' + JSON.stringify(out);
})();
`;

/** The desktop page, measured once per skin and concatenated. */
function measureDesktop(opts = {}) {
	if (opts.parts) return runChrome(desktopFixtureHtml(opts.parts), opts.env);
	const readings = [];
	for (const skin of (opts.skins || DESKTOP_SKINS)) {
		const one = runChrome(desktopFixtureHtml(buildDesktopFixture({ ...opts, skin })), opts.env);
		if (!one.ran || one.error) return { ...one, skin };
		readings.push(...one.readings);
	}
	return { ran: true, readings };
}

/**
 * Grade the desktop page PER SKIN. One `measureDesktop()` run produces three states for
 * each skin in `DESKTOP_SKINS`, and a silent loss of one skin would otherwise shrink the
 * whole verdict to "we measured whichever skins happened to survive".
 */
function checkDesktopReadings(readings) {
	const bySkin = new Map();
	for (const r of (readings || [])) {
		if (!bySkin.has(r.skin)) bySkin.set(r.skin, []);
		bySkin.get(r.skin).push(r);
	}
	const problems = [];
	for (const skin of DESKTOP_SKINS) {
		const group = bySkin.get(skin);
		if (!group) {
			problems.push(`desktop: skin ${JSON.stringify(skin)} produced no readings at all — the run measured ${bySkin.size} of ${DESKTOP_SKINS.length} skins`);
			continue;
		}
		for (const p of checkReadings(group, ['desktop'])) problems.push(`desktop[${skin}] ${p}`);
		bySkin.delete(skin);
	}
	for (const skin of bySkin.keys()) {
		problems.push(`desktop: unexpected skin ${JSON.stringify(skin)} in the readings — the check table and the fixture disagree about what is measured`);
	}
	return problems;
}
/**
 * The alpha of a computed color string. Every desktop check is written against ALPHA
 * rather than against a color, because the bundle itself disagrees per skin — seven skins
 * ship an opaque `--dsw-alias-bg-layer-1`, mist ships `rgba(240, 248, 255, 0.62)`.
 */
function cssAlpha(value) {
	if (!value || value === 'none' || value === 'transparent') return 0;
	const m = String(value).match(/rgba?\(([^)]+)\)/);
	if (!m) return /^#[0-9a-f]{6}$/i.test(String(value).trim()) ? 1 : 0;
	const parts = m[1].split(/[,/]/).map((x) => x.trim());
	return parts.length < 4 ? 1 : Number(parts[3]);
}

/**
 * The verdict: what the three states MUST read for #96 and #97 to be satisfied.
 *
 * This lives here rather than inline in the CLI because `tests/wash.cascade.test.cjs`
 * grades the same list — expected values written twice, once for the script and once for
 * the test, means two gates whose numbers can disagree, and only one of them can be seen
 * breaking. Issue #97 is the lesson: a check whose readings were never compared to
 * anything reports success forever.
 *
 * Each check carries a GROUP (`corner` = issue #96, `fade` = issue #97, `desktop` =
 * issue #99) so the named tests can each claim their own half without re-stating the
 * numbers, and so a check cannot fall between the groups: `tests/wash.cascade.test.cjs`
 * asserts the group list is exactly the one declared below.
 *
 * `groups` is REQUIRED. The two fixtures measure different pages with different field
 * names, and a check from one page run against the other's readings would read
 * `undefined` and report a problem that does not exist.
 *
 * Every predicate is called `ok(plain, wash, again)` — the three samples in order — so a
 * check that means to read the wash state must take the SECOND parameter. Writing
 * `ok: (w) => …` against a single-parameter signature silently reads the plain state, and
 * because the first two states differ in every real sample the mistake reports itself as
 * the opposite of the truth.
 */
/**
 * The alpha of a computed color string. Every desktop check is written against ALPHA
 * rather than against a color, because the bundle itself disagrees per skin — seven skins
 * ship an opaque `--dsw-alias-bg-layer-1`, mist ships `rgba(240, 248, 255, 0.62)`.
 */
function cssAlpha(value) {
	if (!value || value === 'none' || value === 'transparent') return 0;
	const m = String(value).match(/rgba?\(([^)]+)\)/);
	if (!m) return /^#[0-9a-f]{6}$/i.test(String(value).trim()) ? 1 : 0;
	const parts = m[1].split(/[,/]/).map((x) => x.trim());
	return parts.length < 4 ? 1 : Number(parts[3]);
}

const WASH_GROUPS = ['corner', 'fade', 'desktop', 'side', 'frost'];

const WASH_CHECKS = [
	{ id: 'corner-host-own', requires: ['corner'], group: 'corner', msg: 'plain: the host corner must stay its own 16px', ok: (plain) => plain.corner === '16px' },
	{ id: 'corner-flattened', requires: ['corner'], group: 'corner', msg: 'wash: issue #96 wants the content corner flattened', ok: (plain, wash) => wash.corner === '0px' },
	{ id: 'corner-restored', requires: ['corner'], group: 'corner', msg: 'washed-again: removing the wash must restore 16px', ok: (plain, wash, again) => again.corner === '16px' },
	{ id: 'frame-fill-dropped', requires: ['frameFill'], group: 'corner', msg: 'wash: the frame fill must be dropped', ok: (plain, wash) => wash.frameFill === 'rgba(0, 0, 0, 0)' },
	{ id: 'frame-fill-kept', requires: ['frameFill'], group: 'corner', msg: 'plain: without a wash the frame must keep its own fill', ok: (plain) => plain.frameFill !== 'rgba(0, 0, 0, 0)' },
	{ id: 'caption-paints', requires: ['stripFill', 'refFill'], group: 'corner', msg: 'plain: the caption row must really paint the sidebar token through the frame’s ::before, or the checks under it are vacuous', ok: (plain) => plain.stripFill === plain.refFill && cssAlpha(plain.stripFill) > 0 },
	// 10.9.2: the promise about the caption band is not "transparent" — it is "the same surface as
	// the content column it spans". 10.9.1 asserted transparency and shipped it; the report came
	// back as a screenshot of a bright photo.
	// 10.9.3: the FIRST version of that promise compared `stripFill` with `centerColFill` — two
	// OWN declarations — and it was true while the band was still light, because the column paints
	// the same token three times (body + column + the app root inside it, cumulative alpha 0.784)
	// and the strip paints it twice (0.640). Declarations are not pixels. This check composites
	// each stack over a fixed base and compares the RESULT, so a layer count that drifts on either
	// side reddens it, which is the only way this promise can be graded without a human looking.
	{ id: 'caption-composites-like-content', requires: ['bandComposite', 'contentComposite'], group: 'corner', msg: 'wash: the caption band must COMPOSITE to what the centre column composites — the host paints that strip in the SIDEBAR token across a window whose content column paints the CANVAS token three times over the body, so matching the column means matching the stacked result, not the declaration', ok: (plain, wash) => wash.bandComposite === wash.contentComposite },
	// The equality above is only as honest as the page it measures: a fixture whose column had
	// forgotten its inner app root would pass with a one-layer strip. This pins the depth to what
	// was measured on the shell's own page on 2026-10-09 (body + column + app root = 3 layers).
	{ id: 'caption-stack-is-column-deep', requires: ['contentLayers'], group: 'corner', msg: 'wash: the centre column must really be painted THREE deep (body + column + app root), as measured on the served page — a shallower fixture would make the composite equality above a comparison against a page nobody renders', ok: (plain, wash) => wash.contentLayers >= 3 },
	// And the equality needs something to be equal ABOUT. With an opaque token every stack
	// composites to the token itself, so one layer and four would agree and this whole check would
	// be decoration. The real slider publishes a translucent canvas token (measured 0.4), so the
	// fixture must too — pinned here because "make the fixture opaque again" is a one-character
	// change that would silently disarm the judgement above.
	{ id: 'caption-comparison-is-alpha-sensitive', requires: ['centerColFill'], group: 'corner', msg: 'wash: the canvas token in the page must stay TRANSLUCENT, or compositing cannot distinguish one layer from three and the equality above stops measuring anything (that the column paints AT ALL is `center-column-paints`, which keeps its own failure mode)', ok: (plain, wash) => cssAlpha(wash.centerColFill) < 0.999 },
	{ id: 'center-column-paints', requires: ['centerColFill'], group: 'corner', msg: 'plain: the centre column must really paint something, or the equality above is a comparison against nothing', ok: (plain) => cssAlpha(plain.centerColFill) > 0 },
	// The image half is its OWN id: `background-color: transparent` clears a flat colour and
	// nothing else, and the fade rule (issue #97) is the proof that a strip can be painted
	// with a gradient. One id per failure mode, so a host upgrade that adds a gradient names
	// itself instead of riding along on the colour claim. 10.9.3 gives the strip a gradient of
	// its OWN (the second token layer), so the promise is no longer "no image" — it is "every
	// image layer here is the canvas token", which is what still catches a host band surviving.
	{ id: 'caption-image-is-our-token', requires: ['stripImageOnToken'], group: 'corner', msg: 'wash: every background-image layer on the caption row must be the canvas token — our own second layer, not a gradient the host left standing under the shorthand', ok: (plain, wash) => wash.stripImageOnToken === true },
	{ id: 'caption-restored', requires: ['stripFill'], group: 'corner', msg: 'washed-again: with no wallpaper the host caption row comes back exactly as it shipped', ok: (plain, wash, again) => again.stripFill === plain.stripFill },
	{ id: 'caption-box-alive', requires: ['stripContent'], group: 'corner', msg: 'both states: the pseudo-element must still GENERATE a box. The drag region lives on the box, and a box that is not generated still reports -webkit-app-region: drag (measured) — without this reading, "the drag survived" is a claim about a value on an element that is no longer painted', ok: (plain, wash) => plain.stripContent !== 'none' && wash.stripContent !== 'none' },
	{ id: 'caption-still-drags', requires: ['stripRegion'], group: 'corner', msg: 'both states: clearing the paint must not clear -webkit-app-region — that strip is how the window is dragged, and a wallpaper may not cost the user the drag. EQUALITY, not "contains drag": the engine normalizes `none` to `no-drag`, which a substring test happily accepts (measured)', ok: (plain, wash) => plain.stripRegion === 'drag' && wash.stripRegion === 'drag' },
	// The two readings above prove the box EXISTS and still says `drag`. Neither proves it is
	// where the user's mouse is. Adjudication J1 (T1/T6): a `transform: translateY(-34px)` or an
	// `inset` rewrite moves the whole caption band off the top of the window and leaves fill,
	// image, content and app-region all reading exactly as documented — so the drag claim would
	// have been a claim about a box that is no longer under the cursor. These two are the
	// GEOMETRY half of the same promise, and they are what the whitelist in `craft-audit` cannot
	// see from the other direction (a string gate reads our declarations; only the engine reads
	// where the box ended up).
	{ id: 'caption-band-shaped', requires: ['stripTop', 'stripHeight', 'stripTransform'], group: 'corner', msg: 'plain: the box being measured must be the caption band — pinned to the top of the window, with real height, and not shifted by a transform. Without this, "the drag region survived" could be true of a zero-area or off-screen artifact', ok: (plain) => plain.stripTop === '0px' && parseFloat(plain.stripHeight) > 0 && plain.stripTransform === 'none' },
	{ id: 'caption-band-anchored', requires: ['stripTop', 'stripHeight', 'stripTransform'], group: 'corner', msg: 'wash: clearing the paint must not MOVE the box — the top strip is the drag surface, and a wallpaper may not cost the user the place where the window is grabbed', ok: (plain, wash) => wash.stripTop === plain.stripTop && wash.stripHeight === plain.stripHeight && wash.stripTransform === plain.stripTransform },
	{ id: 'sidebar-column-paints', requires: ['sidebarColFill', 'refFill'], group: 'corner', msg: 'plain: the sidebar column must really paint the sidebar token, or the non-collateral claim under it is vacuous', ok: (plain) => plain.sidebarColFill === plain.refFill && cssAlpha(plain.sidebarColFill) > 0 },
	{ id: 'sidebar-column-untouched', requires: ['sidebarColFill'], group: 'corner', msg: 'wash: the sidebar column keeps the paint the host gave it (this flattens the frame, not the column) — if this reading moves, the 侧边栏透明度 slider has silently changed meaning between shells', ok: (plain, wash) => wash.sidebarColFill === plain.sidebarColFill },
	{ id: 'fade-paints', requires: ['fadeBg'], group: 'fade', msg: 'plain: the host fade must really paint, else the check below is vacuous', ok: (plain) => /linear-gradient/.test(plain.fadeBg || '') },
	{ id: 'fade-neutralised', requires: ['fadeBg'], group: 'fade', msg: 'wash: issue #97 wants the foot-fade band neutralised', ok: (plain, wash) => wash.fadeBg === 'none' },
	{ id: 'chat-mask-present', requires: ['chatMask'], group: 'fade', msg: 'plain: the chat scroll mask must exist in the page', ok: (plain) => /linear-gradient/.test(plain.chatMask || '') },
	{ id: 'chat-mask-untouched', requires: ['chatMask'], group: 'fade', msg: 'wash: the chat scroll mask is collateral damage', ok: (plain, wash) => wash.chatMask === plain.chatMask },
	{ id: 'desktop-underlay-painted', requires: ['surfaceBg', 'layer1Css'], group: 'desktop', msg: 'plain: the shell must really paint the skin’s own layer-1 over the sidebar column, or every check below is vacuous', ok: (plain) => plain.surfaceBg === plain.layer1Css && cssAlpha(plain.surfaceBg) > 0 },
	{ id: 'desktop-underlay-blocks', requires: ['surfaceBg'], group: 'desktop', msg: 'plain: that underlay has to hide more than half of what is under it — the report is about a slider with no visible effect', ok: (plain) => cssAlpha(plain.surfaceBg) > 0.5 },
	{ id: 'desktop-underlay-cleared', requires: ['surfaceBg'], group: 'desktop', msg: 'wash: issue #99 wants the shell’s own paint gone from that column', ok: (plain, wash) => wash.surfaceBg === 'rgba(0, 0, 0, 0)' },
	{ id: 'desktop-underlay-restored', requires: ['surfaceBg'], group: 'desktop', msg: 'washed-again: the shell gets its paint back when the wallpaper goes', ok: (plain, wash, again) => again.surfaceBg === plain.surfaceBg },
	{ id: 'desktop-no-wash-no-touch', requires: ['surfaceBg'], group: 'desktop', msg: 'plain: without a wash this plugin must not repaint the shell at all', ok: (plain) => cssAlpha(plain.surfaceBg) > 0 },
	{ id: 'desktop-wash-path-clear', requires: ['blockers', 'hit'], group: 'desktop', msg: 'wash: NO opaque shell surface may remain from the shell’s own aside up to the page background, or the slider still has nothing to reveal', ok: (plain, wash) => wash.blockers === '' && wash.hit === 'upstream-sidebar' },
	{ id: 'desktop-chain-walk-correct', requires: ['surfaceBg', 'blockers'], group: 'desktop', msg: 'plain: the paint-order walk must agree with the aside’s own alpha — an opaque aside has to show up as a blocker, otherwise “the chain is clear” below proves nothing', ok: (plain) => cssAlpha(plain.surfaceBg) >= 0.999 ? plain.blockers.includes('dshDesktopSidebarSurface') : cssAlpha(plain.surfaceBg) > 0.5 },
	{ id: 'desktop-token-path-alive', requires: ['surfaceFill', 'layer1Css'], group: 'desktop', msg: 'the sidebar fill must come from our inherited token (not the shell’s shadow) and must not move when the paint goes', ok: (plain, wash) => plain.surfaceFill !== '' && plain.surfaceFill !== plain.layer1Css && wash.surfaceFill === plain.surfaceFill },
	{ id: 'desktop-token-sweeps-slider', requires: ['sweepBg', 'sidebarBg', 'sweepAside', 'surfaceBg'], group: 'desktop', msg: `writing a sentinel --dsw-specific-sidebar-fill must change what the sidebar element COMPUTES, with and without a wash — the reporter's complaint is "the slider moves and no pixel does", and this is that sentence in computed values (the shell's shadow value would leave the reading frozen)`, ok: (plain, wash) => plain.sweepBg === DESKTOP_SWEEP && wash.sweepBg === DESKTOP_SWEEP
		&& plain.sweepBg !== plain.sidebarBg && wash.sweepBg !== wash.sidebarBg && plain.sweepAside === plain.surfaceBg },
	{ id: 'desktop-shell-chrome-kept', requires: ['borderRight'], group: 'desktop', msg: 'the shell’s own border must survive the wash', ok: (plain, wash) => wash.borderRight === plain.borderRight && /1px solid/.test(plain.borderRight || '') },
	// ── Roadmap A1: the sidebar foot plane, measured off boxes ─────────────────────────
	// The host's own baseline is `margin-left: 0px` on `_footArea` (it declares no margin
	// there — read out of dsh-client-ui-sidebar's CSS), so a -4px reading is ONLY explicable
	// by our rule matching a real element. That is the claim the text gates cannot make: an
	// anchor can be present in the sheet, present in the probe list, and still reach nothing
	// if the host ever composes a second class token onto that div.
	{ id: 'side-plane-aligns', requires: ['footMarginLeft'], group: 'side', msg: 'plain: the hash-free foot anchor must reach a real box and move its margin to -4px — "the selector is in the sheet" is not "the selector matched an element"', ok: (plain) => plain.footMarginLeft === '-4px' },
	{ id: 'side-plane-aligns-right', requires: ['footMarginRight', 'insetVarOnFoot'], group: 'side', msg: 'plain: the right edge follows the HOST variable, not our fallback — the reading must equal the negation of whatever --dsh-sidebar-inline-padding resolves to on this box (the host declares it on its own root; the fixture loads that rule, so this is the host answering, not 12px agreeing with 12px)', ok: (plain) => plain.insetVarOnFoot !== '' && plain.insetVarOnFoot !== 'MISSING' && plain.footMarginRight === '-' + plain.insetVarOnFoot },
	// The seam itself, as geometry: our foot plane and the host's own bled region must be the
	// same outer box. No literal from us appears in this comparison.
	{ id: 'side-plane-flush-with-host-region', requires: ['footRectLeft', 'footRectRight', 'regionRectLeft', 'regionRectRight'], group: 'side', msg: 'plain: the foot plane bleeds to exactly the same left and right lines as the host\'s own region above it — which is what "the 断裂 is closed" means on a page, stated without comparing anything to a number we typed', ok: (plain) => plain.footRectLeft !== 'MISSING' && plain.regionRectLeft !== 'MISSING' && plain.footRectLeft === plain.regionRectLeft && plain.footRectRight === plain.regionRectRight && plain.footMarginLeft === plain.regionMarginLeft && plain.footMarginRight === plain.regionMarginRight },
	{ id: 'side-nested-surfaces-align', requires: ['actionsMarginLeft', 'settingsMarginLeft'], group: 'side', msg: 'plain: both nested surfaces are reached THROUGH the foot area, so the descendant combinator resolves in a real engine', ok: (plain) => plain.actionsMarginLeft === '-4px' && plain.settingsMarginLeft === '-4px' },
	// The scoping claim, made as pixels. `_footerActions` is not ours alone — the question
	// card draws `Mbwy4a_footerActions` and the desktop shell's corpus has a second base for
	// the same suffix. This decoy element ends in `_footerActions` but sits outside the foot
	// area; un-scope our anchor and it loses its margin, its fill and its border to us.
	{ id: 'side-decoy-footer-untouched', requires: ['decoyMarginLeft', 'decoyBg', 'decoyBorder'], group: 'side', msg: 'plain: a component whose class ALSO ends in `_footerActions` but that is not inside the foot area keeps its own margin, paint and border — the scoping is load-bearing, not stylistic', ok: (plain) => plain.decoyMarginLeft === '0px' && plain.decoyBg === 'rgb(7, 7, 7)' && plain.decoyBorder === '1px' },
	{ id: 'side-plane-not-wash-gated', requires: ['footMarginLeft', 'decoyBg'], group: 'side', msg: 'wash: the alignment and the erase are deliberately ungated — the seam exists with or without a wallpaper, and a wash may not move the plane or reach the decoy either', ok: (plain, wash) => wash.footMarginLeft === plain.footMarginLeft && wash.decoyBg === plain.decoyBg && wash.decoyMarginLeft === plain.decoyMarginLeft },
	// Anti-hole for the group above: the host's OWN foot declarations must be in the page, or
	// every side reading is our sheet applied to a bare div. These two properties are ones we
	// never write, so they can only come from the host block.
	{ id: 'side-host-foot-css-in-play', requires: ['footDisplay', 'footFlexDirection'], group: 'side', msg: 'plain: the host\'s own `.<base>_footArea{display:flex;flex-direction:column}` really loads in this fixture — without it the side group is our sheet on a div, not a cascade', ok: (plain) => plain.footDisplay === 'flex' && plain.footFlexDirection === 'column' },
	// The compensation pair, as a relation rather than a pair of literals. The rule pulls the
	// plane out by N and pushes its content back in by N; asserting `padding === |margin|` (and
	// that both right-hand numbers equal the host variable the pull is computed from) is what
	// makes the two padding declarations observable — before this leg, deleting either padding
	// declaration changed nothing the gate read.
	{ id: 'side-padding-compensates-inset', requires: ['footMarginLeft', 'footMarginRight', 'footPaddingLeft', 'footPaddingRight', 'insetVarOnFoot'], group: 'side', msg: 'plain: each side pulls the plane out and pads its content back by the SAME amount (right side equals the host variable both ways) — so the bleed cannot widen the seam it exists to close', ok: (plain) => {
		const pullL = Math.abs(parseFloat(plain.footMarginLeft));
		const padL = parseFloat(plain.footPaddingLeft);
		const pullR = Math.abs(parseFloat(plain.footMarginRight));
		const padR = parseFloat(plain.footPaddingRight);
		const hostVar = parseFloat(plain.insetVarOnFoot);
		if ([pullL, padL, pullR, padR, hostVar].some((n) => !Number.isFinite(n))) return false;
		return padL === pullL && padR === pullR && pullR === hostVar;
	} },
	// The erase half, and what it can and CANNOT claim. The host writes no background, box-shadow
	// or border for these three classes (measured, both corpora), so with only today's host CSS
	// this check would read transparent / none / 0px EVEN IF our declarations were deleted —
	// stripping them reddens nothing, and that is recorded rather than hidden (see the
	// documented-non-coverage legs in tests/wash.cascade.test.cjs). What this check DOES own is
	// the outcome under competition: the moment the host paints this plane harder than (0,1,0),
	// it goes red, which is the only reason the erase is in the sheet at all.
	{ id: 'side-erase-wins-over-host-sheet', requires: ['footBg', 'footShadow', 'footBorderTop'], group: 'side', msg: 'plain: with the host sheet loaded, our erase still owns the foot plane (no fill, no shadow, no border) at (0,1,0) vs (0,1,0) — the win comes from being the later sheet. CANARY, not coverage: today nothing competes, so this reads the same with our declarations stripped (recorded); it exists to fail when a host build starts painting this plane', ok: (plain) => plain.footBg === 'rgba(0, 0, 0, 0)' && plain.footShadow === 'none' && plain.footBorderTop === '0px' },
	// ── Roadmap A1, 10.13.0: the union anchors, measured as pixels ────────────
	// The pairing gate proves the anchors are in the sheet and in both channels' bytes. None of
	// that proves a SELECTOR MATCHES: a typo in the attribute form, a `>` that the host's DOM does
	// not honour, or an over-broad suffix all leave the text gates untouched while the shell's
	// frosting is simply gone (or painted somewhere it was never pointed). Every value here is
	// COMPUTED by the engine, and the expectation is the shipped declaration applied to a reference
	// box in the same page — so the comparison is between two boxes, not between a box and a
	// string somebody copied into this file.
	{ id: 'frost-engine-computes-backdrop-filter', requires: ['frostRef'], group: 'frost', msg: 'plain: the reference box must COMPUTE a blur, or the four readings under it are grading a browser that cannot do this and would report "none" for every rule in the sheet', ok: (plain) => /^blur\(/.test(plain.frostRef || '') },
	{ id: 'frost-todo-panel-anchor-reaches', requires: ['frostRef', 'frostTodoPanel'], group: 'frost', msg: 'plain: [data-testid="todo-panel"] must frost a box whose class name this sheet never mentions — that is the whole A1 promise: a host that re-rolls its hashes still gets the frosting, and "the selector is in the sheet" was never "the selector matched"', ok: (plain) => plain.frostTodoPanel === plain.frostRef && plain.frostTodoPanel !== 'none' && plain.frostTodoPanel !== 'MISSING' },
	{ id: 'frost-dock-panel-anchor-reaches', requires: ['frostRef', 'frostDockPanel'], group: 'frost', msg: 'plain: [data-queue-dock] > [class$="_panel"] must reach the dock\'s DIRECT child under a re-rolled base name — the child combinator is the part a text gate cannot check, and the registry claims that shape on both channels', ok: (plain) => plain.frostDockPanel === plain.frostRef && plain.frostDockPanel !== 'none' && plain.frostDockPanel !== 'MISSING' },
	{ id: 'frost-decoy-panel-untouched', requires: ['frostPanelDecoy'], group: 'frost', msg: 'plain: a box whose class also ends in _panel but that is NOT the dock\'s child stays unblurred — measured, _panel has 12 distinct bases on npm and 12 on the shell, so dropping the scope would frost a dozen foreign surfaces (issue L1, arriving through a suffix)', ok: (plain) => plain.frostPanelDecoy === 'none' },
	{ id: 'frost-not-wash-gated', requires: ['frostRef', 'frostTodoPanel', 'frostDockPanel', 'frostPanelDecoy'], group: 'frost', msg: 'wash: the frosting is @supports-gated, never wallpaper-gated — a wash may not move it off the two anchors, and may not reach the decoy either (same discipline as side-plane-not-wash-gated)', ok: (plain, wash) => wash.frostTodoPanel === plain.frostTodoPanel && wash.frostDockPanel === plain.frostDockPanel && wash.frostPanelDecoy === plain.frostPanelDecoy },
];

/**
 * @param {Array<object>} readings the three samples, in order plain / wash / washed-again.
 * @param {string[]} groups which check groups to run (REQUIRED — see the note above).
 * @returns {string[]} problems; empty means the states read as documented.
 */
function checkReadings(readings, groups) {
	const [plain, wash, again] = readings || [];
	if (!plain || !wash || !again) {
		return [`expected the three states plain/wash/washed-again, got ${(readings || []).length}`];
	}
	// Review finding F12 (10.8.1): an empty group list — and the legacy single string —
	// both silently graded NOTHING, and the CLI then printed "wash cascade OK" with exit
	// 0. Zero selected checks is a failure of the CHECKER, not a verdict about the page,
	// so it must be reported as one and it must be the first thing a broken caller sees.
	if (!Array.isArray(groups) || groups.length === 0) {
		return ['checkReadings: groups must be a NON-EMPTY ARRAY of declared groups '
			+ `(got ${JSON.stringify(groups)}); declared groups are ${WASH_GROUPS.join('/')}. `
			+ 'A call that selects no checks would hand a passing grade to a page nobody measured.'];
	}
	for (const g of groups) {
		if (!WASH_GROUPS.includes(g)) return [`unknown check group ${JSON.stringify(g)} (declared: ${WASH_GROUPS.join('/')})`];
	}
	const wanted = groups;
	const problems = [];
	// Adjudication J4 (T2): a check whose sampled field has VANISHED does not fail. It compares
	// `undefined` against `undefined` and passes — `wash.sidebarColFill === plain.sidebarColFill`
	// is a true statement about a page that samples neither. That is issue #97's shape one more
	// level up (a target that quietly stopped existing), and the fix is not more eyeballs: every
	// check declares the fields it reads, and a field the fixture no longer produces is reported
	// as a broken CHECKER, not as a verdict about the page. `tests/wash.cascade.test.cjs` runs the
	// same promise against the fixture SOURCE as a string gate, because on CI the engine group is
	// skipped and this guard would never fire.
	const samples = [plain, wash, again];
	const stateNames = ['plain', 'wash', 'washed-again'];
	for (const check of WASH_CHECKS) {
		if (!wanted.includes(check.group)) continue;
		if (!Array.isArray(check.requires) || check.requires.length === 0) {
			problems.push(`checker: ${check.id} declares no \`requires\` field list — a check with undeclared inputs can pass on a page nobody sampled`);
			continue;
		}
		const absent = [];
		for (const field of check.requires) {
			samples.forEach((r, i) => {
				if (!Object.prototype.hasOwnProperty.call(r, field)) absent.push(`"${field}"@${stateNames[i]}`);
			});
		}
		if (absent.length) {
			problems.push(`checker: ${check.id} reads ${absent.join(', ')} but the fixture does not produce it — the check would compare undefined against undefined and call that a pass. `
				+ 'Either the sample field was renamed/removed (fix the fixture) or this check no longer needs it (drop it from `requires`).');
			continue;
		}
		let held = false;
		try {
			held = check.ok(plain, wash, again);
		} catch (e) {
			problems.push(`${check.id}: the check itself threw (${e.message})`);
			continue;
		}
		if (!held) problems.push(`${check.id}: ${check.msg} (readings ${JSON.stringify([plain, wash, again])})`);
	}
	return problems;
}

module.exports = {
	measure, measureDesktop, measureCoexist, buildFixture, buildDesktopFixture, buildCoexistFixture,
	fixtureHtml, desktopFixtureHtml, coexistFixtureHtml,
	checkDesktopReadings, checkCoexistReadings, COEXIST_CHECKS, cssAlpha, skinTokens, DESKTOP_SKINS,
	cornerTokens, cssColor, CORNER_SKIN, CORNER_ALPHA,
	DESKTOP_SWEEP, browserAttempts, stripDeclaration, checkReadings, WASH_CHECKS, WASH_GROUPS,
	hostCss, hostSidebarConsumer, hostFadeClasses, hostLayoutClasses, pluginFadeRule, SKIN_CENTER_PKG,
	hostSideFootRules, hostSideInsets, walkCssBlocks, SIDE_WATCHED_PROPS,
	DESKTOP_SHELL_CSS, DESKTOP_SHELL_SOURCE, HOST_PACKAGES, DEFAULT_HOST_ROOT,
	probeBrowser, gradeStage, environmentError, runChrome, cliOutcome, strictRequested
};

/**
 * Grade one stage, three-way (issue #102).
 *   ok    — it ran, and the readings agree;
 *   fail  — it ran (or should have) and something is WRONG: a check disagreed, a fixture
 *           lost a declaration it guards, or the engine started but produced garbage;
 *   skip  — this machine could not run it: no browser, or a browser that cannot be
 *           spawned (EBUSY/EPERM/…), or no host install to read.
 * `skip` is never folded into `ok`, and it is printed as a skip, so a laptop without a
 * usable browser reads as "this gate did not check anything here" instead of either a
 * green or a false alarm about the cascade.
 *
 * Roadmap M adds two fields to a skip — `piece` (WHICH environment input is absent) and
 * `reason` (the sentence naming it) — because strict mode has to fail with an actionable
 * name instead of a count. They are additive: the three-state `kind` and the printed line
 * are exactly what issue #102 defined, and nothing here turns an environment skip into a
 * verdict about the page.
 */
function gradeStage(label, groups, run) {
	let r;
	try {
		r = run();
	} catch (e) {
		if (e.environment) {
			return {
				kind: 'skip',
				label,
				piece: e.piece || 'environment',
				reason: e.message,
				lines: [`${label}: SKIPPED (environment) — ${e.message}`]
			};
		}
		return { kind: 'fail', label, lines: [`${label}: the fixture refused to build — ${e.message}`] };
	}
	if (!r.ran) {
		return {
			kind: 'skip',
			label,
			piece: 'browser',
			reason: r.why,
			lines: [`${label}: SKIPPED (environment) — ${r.why} — a skip is not a pass`]
		};
	}
	if (r.error) return { kind: 'fail', label, lines: [`${label}: ${r.error}\n${(r.dom || '').slice(0, 300)}`] };
	for (const x of r.readings) console.log(JSON.stringify(x));
	const problems = label === 'desktop' ? checkDesktopReadings(r.readings)
		: label === 'coexist' ? checkCoexistReadings(r.readings)
			: checkReadings(r.readings, groups);
	return { kind: problems.length ? 'fail' : 'ok', label, lines: problems.map((p) => `${label}: ${p}`) };
}

/**
 * Roadmap M — the CLI's verdict, as a function a test can call.
 *
 * Three exit codes stay exactly as issue #102 defined them, and a fourth is added ONLY for
 * strict mode:
 *   0 ran and agrees · 1 ran and disagrees · 3 could not run (skip, reported as a skip)
 *   4 strict mode was asked for and the environment refused (a missing browser / host /
 *     plugin, each named on its own line).
 * 4 rather than 1 matters: "the machine had no Chrome" and "the cascade broke" are different
 * facts, and folding them into one code is the mistake #102 exists to prevent. Strict mode
 * does not reinterpret the fact — it declines to accept it, because CI provisioned the piece
 * and promised a measurement, so a skip there is a broken pipeline, not a verdict.
 *
 * `lines` are tagged with the stream they belong on, so the printing rule ("skips to stdout,
 * problems to stderr") lives in ONE place and a test can read the same list the terminal does.
 */
function cliOutcome(stages, opts = {}) {
	const strict = opts.strict === undefined ? strictRequested(opts.env) : Boolean(opts.strict);
	const fails = stages.filter((s) => s.kind === 'fail');
	const skips = stages.filter((s) => s.kind === 'skip');
	const lines = [];
	for (const s of stages) for (const line of s.lines) lines.push({ stream: s.kind === 'skip' ? 'log' : 'error', text: line });
	const outcome = { strict, missing: [], exitCode: 0, summary: '', lines };
	if (fails.length > 0) {
		outcome.exitCode = 1;
		outcome.summary = 'wash cascade: FAILED — the engine ran and disagreed (every problem above is named by fixture + check id).';
		return outcome;
	}
	if (strict && skips.length > 0) {
		// Name each missing piece ONCE, with the stages it blocked and the reason the gate gave.
		const byPiece = new Map();
		for (const s of skips) {
			const piece = s.piece || 'environment';
			if (!byPiece.has(piece)) byPiece.set(piece, { stages: [], reason: s.reason || (s.lines[0] || '') });
			const bucket = byPiece.get(piece);
			bucket.stages.push(s.label || '?');
		}
		// A missing browser hides behind a missing host: `buildFixture()` throws before the
		// engine is ever asked, so a runner with neither piece would report "host install" and
		// leave the reader to guess about Chrome. The CLI only pays for this probe once, and
		// only on a strict run that already skipped — a machine that measured everything never
		// spawns it.
		const probe = opts.browserProbe;
		if (probe && !probe.ran && !byPiece.has('browser')) {
			byPiece.set('browser', { stages: ['(precondition)'], reason: probe.why || 'no headless browser could be spawned here' });
		}
		for (const [piece, bucket] of byPiece) {
			outcome.missing.push(piece);
			lines.push({
				stream: 'error',
				text: `wash cascade: MISSING ${piece} — required by the ${bucket.stages.join(' + ')} stage(s) — ${bucket.reason}`
			});
		}
		outcome.exitCode = 4;
		outcome.summary = `wash cascade: STRICT MODE (DSH_WASH_STRICT) — refusing ${skips.length}/${stages.length} environment `
			+ `skip(s): ${outcome.missing.join(', ')} missing here. Nothing was measured on that half, and this run promised it `
			+ 'would; exit 4 — not 0 (no verdict) and not 1 (the engine never got to disagree).';
		return outcome;
	}
	if (skips.length > 0) {
		outcome.exitCode = 3;
		outcome.summary = `wash cascade: NOT RUN on ${skips.length}/${stages.length} stage(s) — no verdict was read there.`;
		return outcome;
	}
	outcome.summary = 'wash cascade OK — graded '
		// The list is read off the stages, not written here, because this sentence used to enumerate
		// what it believed had run while the host stage was only handing two of its groups to the
		// checker. A summary that names more than it graded is the same failure family as a check
		// that reads undefined and calls it agreement.
		+ stages.map((s) => `${s.label}[${(s.groups || []).join('/') || 'NOTHING'}]`).join(' ')
		+ ' — host: corner 16px -> 0px -> 16px, fade gradient -> none -> gradient, chat mask untouched, side foot plane flush with the host region, frost anchors reach their boxes and the scoped _panel does not leak; '
		+ 'desktop: shell paint opaque -> transparent -> opaque on both skins, with nothing opaque left in the way under a wash; '
		+ 'coexist: band gone under either lane, and the inline probe says whose declaration is the stronger one.';
	return outcome;
}

if (require.main === module) {
	// Every group the HOST page feeds must be graded here. `desktop` has its own fixture and its
	// own grader; everything else is sampled by `measure()`, so a group that joins WASH_GROUPS is
	// graded by the CLI in the same step — no list in this block to forget. The reason this is
	// derived rather than typed: `side` was added in 10.10.0 with a CHANGELOG sentence saying a new
	// group "must be added here or the whole group silently does not run", and it never was — the
	// CLI has been printing an OK that did not include the side verdicts since then (the engine legs
	// in `tests/wash.cascade.test.cjs` grade them, which is why nothing was actually unchecked
	// there). A list a human has to remember to extend is the finding; the gate for it is
	// `tests/wash.cascade.test.cjs`'s "the CLI grades every host-page group".
	const hostPageGroups = WASH_GROUPS.filter((g) => g !== 'desktop');
	const stageSpecs = [
		['host', hostPageGroups, () => measure()],
		['desktop', ['desktop'], () => measureDesktop()],
		['coexist', ['coexist'], () => measureCoexist()]
	];
	const stages = stageSpecs.map(([label, groups, run]) => Object.assign(gradeStage(label, groups, run), { label, groups }));
	const strict = strictRequested(process.env);
	// Only a strict run that ALREADY skipped pays for the extra probe: on CI the answer to
	// "what is missing" has to be complete, while off CI nothing about the three states moves.
	const browserProbe = strict && stages.some((s) => s.kind === 'skip') ? probeBrowser(process.env) : null;
	const outcome = cliOutcome(stages, { strict, browserProbe });
	for (const l of outcome.lines) console[l.stream](l.text);
	console[outcome.exitCode === 0 ? 'log' : 'error'](outcome.summary);
	process.exitCode = outcome.exitCode;
}


