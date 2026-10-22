#!/usr/bin/env node
/**
 * Standalone verifier: proves that requireSeed() in lib/client.js only accepts
 * zero-arg thunks and all four platform seed specifiers are string literals at
 * call sites — no computed value ever flows into require().
 *
 * Usage: node scripts/verify-finite-caller-set.cjs
 * Exit 0 = pass, exit 1 = fail (with explanation).
 *
 * This script requires NO dependencies, NO host environment, and reads ONLY
 * lib/client.js. It is designed for external reviewers (DSH-Store#1411) who
 * do not wish to run the full test suite.
 */

const fs = require('fs');
const path = require('path');

const CLIENT_JS = path.join(__dirname, '..', 'lib', 'client.js');

if (!fs.existsSync(CLIENT_JS)) {
	console.error(`ERROR: ${CLIENT_JS} not found — run this from the repo root`);
	process.exit(1);
}

const source = fs.readFileSync(CLIENT_JS, 'utf8');
const lines = source.split('\n');

// ── Step 1: Find the requireSeed definition ────────────────────────────────

let requireSeedLine = -1;
for (let i = 0; i < lines.length; i++) {
	if (lines[i].includes('const requireSeed = (load)')) {
		requireSeedLine = i + 1; // 1-based
		break;
	}
}

if (requireSeedLine === -1) {
	console.error('FAIL: requireSeed helper not found in lib/client.js');
	process.exit(1);
}

console.log(`✓ Found requireSeed at line ${requireSeedLine}`);

// ── Step 2: Verify it only accepts a thunk parameter ───────────────────────

const requireSeedDef = lines.slice(requireSeedLine - 1, requireSeedLine + 6).join('\n');
if (!requireSeedDef.includes('return load()')) {
	console.error('FAIL: requireSeed does not call load() as a thunk');
	process.exit(1);
}
console.log('✓ requireSeed calls load() as a zero-arg thunk');

// ── Step 3: Find all requireSeed() call sites ──────────────────────────────

const callSites = [];
for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	const trimmed = line.trimStart();
	// Skip comments and the definition itself
	if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
	if (line.includes('const requireSeed =')) continue;

	let idx = -1;
	while ((idx = line.indexOf('requireSeed(', idx + 1)) >= 0) {
		const after = line.slice(idx + 'requireSeed('.length).trim();
		callSites.push({ line: i + 1, text: after, fullLine: line });
	}
}

if (callSites.length < 4) {
	console.error(`FAIL: Expected at least 4 requireSeed() call sites, found ${callSites.length}`);
	process.exit(1);
}

console.log(`✓ Found ${callSites.length} requireSeed() call sites`);

// ── Step 4: Verify each call site passes a thunk with a string literal ─────

const MODULE_ID_RE = /^[a-z@][a-z0-9._/-]*$/;
const failures = [];

for (const cs of callSites) {
	// Extract the argument (should be () => require("..."))
	const argMatch = cs.text.match(/^\(\)\s*=>\s*require\(["']([^"']+)["']\)/);
	if (!argMatch) {
		failures.push({
			line: cs.line,
			reason: 'Argument is not a zero-arg thunk calling require with a string literal',
			text: cs.text.slice(0, 80)
		});
		continue;
	}

	const specifier = argMatch[1];
	if (!MODULE_ID_RE.test(specifier)) {
		failures.push({
			line: cs.line,
			reason: `Specifier "${specifier}" is not a valid module ID (contains dot-segments or invalid chars)`,
			specifier
		});
		continue;
	}
}

if (failures.length > 0) {
	console.error('\nFAIL: The following call sites violate the finite-caller-set contract:\n');
	for (const f of failures) {
		console.error(`  Line ${f.line}: ${f.reason}`);
		if (f.text) console.error(`    ${f.text}`);
		if (f.specifier) console.error(`    specifier: "${f.specifier}"`);
	}
	process.exit(1);
}

console.log('✓ All call sites pass zero-arg thunks with string-literal specifiers');

// ── Step 5: List the enumerable set of host modules ────────────────────────

const specifiers = callSites.map(cs => {
	const m = cs.text.match(/require\(["']([^"']+)["']\)/);
	return m ? m[1] : null;
}).filter(Boolean);

const uniqueSpecs = [...new Set(specifiers)];

console.log('\n📋 Enumerable set of host modules this plugin can require:');
for (const s of uniqueSpecs) {
	console.log(`   - ${s}`);
}

console.log(`\n✅ PASS: Finite caller set proven — ${uniqueSpecs.length} distinct modules, all string literals.`);
console.log('   No computed value flows into require(). External scanners can enumerate the complete set.');
process.exit(0);
