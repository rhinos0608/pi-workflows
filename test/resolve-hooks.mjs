/**
 * Test-only ESM resolution hooks (node --import ./test/resolve-hooks.mjs).
 *
 * Maps the bare specifiers the extension uses to the exact installed global
 * copies inside Pi 0.84.1's own node_modules. This is the SAME resolution Pi
 * provides at runtime via its jiti alias table (dist/core/extensions/loader.js:
 * typebox → require.resolve('typebox'), @earendil-works/* → workspace entries).
 * Plain-node type stripping has no such table, so tests re-create it here.
 * No packages are installed or fetched; these are existing on-disk modules.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

// Isolate all pi-workflows disk state (registry, saved workflows, run history)
// into a per-run temp dir BEFORE any module imports evaluate path constants.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "piwf-agent-"));

const ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";

const ALIASES = new Map([
  ["typebox", path.join(ROOT, "typebox", "build", "index.mjs")],
  ["typebox/compile", path.join(ROOT, "typebox", "build", "compile", "index.mjs")],
  ["typebox/value", path.join(ROOT, "typebox", "build", "value", "index.mjs")],
  ["@earendil-works/pi-coding-agent", "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"],
  ["@earendil-works/pi-agent-core", path.join(ROOT, "@earendil-works", "pi-agent-core", "dist", "index.js")],
  ["@earendil-works/pi-ai", path.join(ROOT, "@earendil-works", "pi-ai", "dist", "index.js")],
  ["@earendil-works/pi-tui", path.join(ROOT, "@earendil-works", "pi-tui", "dist", "index.js")],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const hit = ALIASES.get(specifier);
    if (hit) {
      return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});