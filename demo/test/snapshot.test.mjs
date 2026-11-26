// Snapshot test: every example and corpus footprint still builds the model and
// the automatic marks recorded in demo/test/fixtures/models.jsonl.
// Run: node --test demo/test/*.test.mjs
//
// To see every difference: node demo/tools/snapshot.mjs
// To record a deliberate change: node demo/tools/snapshot.mjs --write
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAll, readFixture, compare } from '../tools/snapshot.mjs';

test('models and automatic marks match the snapshot', () => {
  const d = compare(readFixture(), recordAll());
  const lines = [
    ...d.missing.map((k) => `missing: ${k}`),
    ...d.added.map((k) => `new: ${k}`),
    ...d.changed.map((c) => `changed: ${c.key}\n  ${c.diffs.slice(0, 6).join('\n  ')}`),
  ];
  assert.equal(lines.length, 0, `${lines.length} footprints differ from the snapshot. Run node demo/tools/snapshot.mjs to list them.\n${lines.slice(0, 8).join('\n')}`);
});
