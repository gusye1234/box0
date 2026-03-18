import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('format utilities', () => {
  test('formatDateTime returns YYYY-MM-DD HH:mm:ss in local timezone', () => {
    const { formatDateTime } = require('../lib/format');
    const ts = new Date(2026, 2, 17, 14, 32, 5).getTime(); // March = month 2
    assert.strictEqual(formatDateTime(ts), '2026-03-17 14:32:05');
  });

  test('formatDate returns YYYY-MM-DD in local timezone', () => {
    const { formatDate } = require('../lib/format');
    const ts = new Date(2026, 2, 17, 14, 32, 5).getTime();
    assert.strictEqual(formatDate(ts), '2026-03-17');
  });

  test('formatDateTime zero-pads single-digit values', () => {
    const { formatDateTime } = require('../lib/format');
    const ts = new Date(2026, 0, 5, 1, 2, 3).getTime(); // Jan 5, 01:02:03
    assert.strictEqual(formatDateTime(ts), '2026-01-05 01:02:03');
  });

  test('agentColor wraps claude-code with cyan', () => {
    const { agentColor } = require('../lib/format');
    const result = agentColor('claude-code');
    assert.strictEqual(stripAnsi(result), 'claude-code');
    assert.ok(result.includes('\x1B['), 'Should contain ANSI escape codes');
    assert.notStrictEqual(result, 'claude-code', 'Should be colored');
  });

  test('agentColor wraps openclaw with green', () => {
    const { agentColor } = require('../lib/format');
    const result = agentColor('openclaw');
    assert.strictEqual(stripAnsi(result), 'openclaw');
    assert.notStrictEqual(result, 'openclaw');
  });

  test('agentColor wraps codex with yellow', () => {
    const { agentColor } = require('../lib/format');
    const result = agentColor('codex');
    assert.strictEqual(stripAnsi(result), 'codex');
    assert.notStrictEqual(result, 'codex');
  });

  test('agentColor wraps chatgpt with magenta', () => {
    const { agentColor } = require('../lib/format');
    const result = agentColor('chatgpt');
    assert.strictEqual(stripAnsi(result), 'chatgpt');
    assert.notStrictEqual(result, 'chatgpt');
  });

  test('formatNumber formats with comma separators', () => {
    const { formatNumber } = require('../lib/format');
    assert.strictEqual(formatNumber(1234567), '1,234,567');
  });

  test('formatDelta returns green "+25%" for 0.25', () => {
    const { formatDelta } = require('../lib/format');
    const result = formatDelta(0.25);
    assert.strictEqual(stripAnsi(result), '+25%');
    assert.ok(result.includes('\x1B['), 'Should contain ANSI codes');
  });

  test('formatDelta returns red "-10%" for -0.1', () => {
    const { formatDelta } = require('../lib/format');
    const result = formatDelta(-0.1);
    assert.strictEqual(stripAnsi(result), '-10%');
  });

  test('formatDelta returns "N/A" for null', () => {
    const { formatDelta } = require('../lib/format');
    assert.strictEqual(formatDelta(null), 'N/A');
  });

  test('sectionHeader returns bold underline text', () => {
    const { sectionHeader } = require('../lib/format');
    const result = sectionHeader('Overview');
    assert.strictEqual(stripAnsi(result), 'Overview');
    assert.ok(result.includes('\x1B['), 'Should contain ANSI codes');
  });

  test('dimLabel returns dimmed padded text', () => {
    const { dimLabel } = require('../lib/format');
    const result = dimLabel('Label:', 20);
    const plain = stripAnsi(result);
    assert.ok(plain.startsWith('Label:'));
    assert.strictEqual(plain.length, 20);
  });
});
