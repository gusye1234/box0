import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('versionCommand prints box0 v<semver>', () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    // Dynamically require so the test file compiles independent of dist layout
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { versionCommand } = require('../commands/version');
    // Invoke the action handler directly without spinning up Commander
    (versionCommand as any)._actionHandler([]);
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1, 'exactly one line printed');
  assert.match(lines[0], /^box0 v\d+\.\d+\.\d+$/, 'output matches box0 v<semver>');
});
