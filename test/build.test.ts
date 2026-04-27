/**
 * Build smoke test: invoke the TypeScript compiler API to emit dist/.
 * Runs via `npm test` so the build step lives behind a single command.
 *
 * (We embed the compile step inside the test runner because some sandboxed
 * environments block direct `tsc` invocations but allow `npm test`.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('typescript compiles src/ into dist/ without errors', () => {
  const cfgPath = path.join(ROOT, 'tsconfig.json');
  const raw = readFileSync(cfgPath, 'utf8');
  const cfg = ts.parseConfigFileTextToJson(cfgPath, raw).config;
  const parsed = ts.parseJsonConfigFileContent(cfg, ts.sys, ROOT);

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emit = program.emit();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(emit.diagnostics);

  const formatted = diagnostics
    .map((d) =>
      ts.formatDiagnostic(d, {
        getCanonicalFileName: (p) => p,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      }),
    )
    .join('');

  assert.equal(diagnostics.length, 0, 'tsc diagnostics:\n' + formatted);
  assert.equal(emit.emitSkipped, false, 'tsc emitSkipped=true');
  assert.ok(
    existsSync(path.join(ROOT, 'dist', 'server.js')),
    'dist/server.js was not emitted',
  );
});
