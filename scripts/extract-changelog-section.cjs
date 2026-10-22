#!/usr/bin/env node
/**
 * Print one CHANGELOG release block as release notes.
 *
 * Usage: node scripts/extract-changelog-section.cjs v10.21.1 > notes.md
 *
 * The release workflow runs this on a tag push. It is deliberately strict:
 * a tag with no matching block exits 1 instead of publishing an empty release,
 * because "the release exists but says nothing" is the failure this repository
 * keeps writing gates against. The heading itself is dropped (the release title
 * carries the version), and the remaining body must be non-empty.
 */
const fs = require("node:fs");
const path = require("node:path");

const raw = process.argv[2];
if (!raw) {
	console.error("usage: extract-changelog-section.cjs <version|vversion>");
	process.exit(2);
}
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`not a version: ${JSON.stringify(raw)}`);
	process.exit(2);
}

const file = path.join(__dirname, "..", "CHANGELOG.md");
const lines = fs.readFileSync(file, "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
	console.error(`CHANGELOG.md has no ## [${version}] block — refusing to publish empty notes`);
	process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
	if (lines[i].startsWith("## [")) { end = i; break; }
}
const body = lines.slice(start + 1, end).join("\n").trim();
if (body === "") {
	console.error(`the ## [${version}] block is empty — refusing to publish empty notes`);
	process.exit(1);
}
process.stdout.write(body + "\n");
