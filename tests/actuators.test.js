import assert from 'node:assert/strict';
import test from 'node:test';

import { previewActuator } from '../actuators.js';

test('unknown LLM recommendation ids are treated as track-only advice', () => {
  const preview = previewActuator('duplicate_expensive_models', '/tmp/project', []);

  assert.equal(preview.actionable, false);
  assert.equal(preview.behavioral, true);
  assert.match(preview.reason, /LLM recommendation/i);
});
