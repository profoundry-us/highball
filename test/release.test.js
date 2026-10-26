import { test } from "node:test";
import assert from "node:assert/strict";
import { bumpPluginManifest, cutChangelog, sectionFor } from "../dev/release.js";

const LOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- A thing. (#40)",
  "",
  "### Fixed",
  "",
  "- A bug. (#41)",
  "",
  "## [0.8.0] - 2026-09-17",
  "",
  "### Added",
  "",
  "- Older thing.",
  "",
  "[Unreleased]: https://github.com/profoundry-us/highball/compare/v0.8.0...HEAD",
  "[0.8.0]: https://github.com/profoundry-us/highball/compare/v0.7.1...v0.8.0",
  ""
].join("\n");

test("cutChangelog moves Unreleased under a dated heading and repoints the links", () => {
  const out = cutChangelog(LOG, "0.9.0", "2026-10-01");
  assert.match(out, /^## \[Unreleased\]\n\n## \[0\.9\.0\] - 2026-10-01\n\n### Added\n\n- A thing\. \(#40\)\n\n### Fixed\n\n- A bug\. \(#41\)\n\n## \[0\.8\.0\]/m);
  assert.match(out, /^\[Unreleased\]: https:\/\/github\.com\/profoundry-us\/highball\/compare\/v0\.9\.0\.\.\.HEAD$/m);
  assert.match(out, /^\[0\.9\.0\]: https:\/\/github\.com\/profoundry-us\/highball\/compare\/v0\.8\.0\.\.\.v0\.9\.0$/m);
  assert.match(out, /^\[0\.8\.0\]: .*v0\.7\.1\.\.\.v0\.8\.0$/m, "older links untouched");
  // Cutting again from the result finds an empty Unreleased.
  assert.throws(() => cutChangelog(out, "0.10.0", "2026-10-02"), /Unreleased section is empty/);
});

test("sectionFor returns the released section for the PR body", () => {
  const out = cutChangelog(LOG, "0.9.0", "2026-10-01");
  assert.equal(sectionFor(out, "0.9.0"), "### Added\n\n- A thing. (#40)\n\n### Fixed\n\n- A bug. (#41)");
  assert.equal(sectionFor(out, "0.8.0"), "### Added\n\n- Older thing.");
  assert.equal(sectionFor(out, "1.0.0"), "");
});

test("cutChangelog refuses an empty section, a re-release, and a log without the links", () => {
  const empty = LOG.replace(/### Added\n\n- A thing\. \(#40\)\n\n### Fixed\n\n- A bug\. \(#41\)\n\n/, "");
  assert.throws(() => cutChangelog(empty, "0.9.0", "2026-10-01"), /empty — nothing to release/);
  assert.throws(() => cutChangelog(LOG, "0.8.0", "2026-10-01"), /already released/);
  assert.throws(() => cutChangelog(LOG.replace(/^\[Unreleased\]: .*\n/m, ""), "0.9.0", "2026-10-01"), /no "\[Unreleased\]:/);
  assert.throws(() => cutChangelog("# nothing\n", "0.9.0", "2026-10-01"), /no "## \[Unreleased\]"/);
});

test("bumpPluginManifest sets the version and keeps everything else in order", () => {
  const before = '{\n  "name": "highball",\n  "version": "0.9.0",\n  "description": "x",\n  "keywords": [ "a" ]\n}\n';
  const after = bumpPluginManifest(before, "0.10.0");
  assert.deepEqual(Object.keys(JSON.parse(after)), [ "name", "version", "description", "keywords" ]);
  assert.equal(JSON.parse(after).version, "0.10.0");
  assert.equal(JSON.parse(after).description, "x");
  assert.ok(after.endsWith("}\n"));
});
