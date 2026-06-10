import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_MODEL,
  buildOpenAIRequest,
  extractImpactCost,
  normalizeLLMFinding,
  responseText,
} from '../llm-analysis.js';

test('uses GPT 5.4 mini for optimization suggestions by default', () => {
  assert.equal(ANALYSIS_MODEL, 'gpt-5.4-mini');
});

test('OpenAI request asks for strict structured findings', () => {
  const body = buildOpenAIRequest('analyze this');

  assert.equal(body.model, 'gpt-5.4-mini');
  assert.equal(body.input, 'analyze this');
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(
    body.text.format.schema.items.properties.id.enum.includes('overpowered-model'),
    true,
  );
});

test('normalizes LLM finding ids and attaches numeric savings metric', () => {
  const finding = normalizeLLMFinding({
    id: 'overpowered_model',
    title: 'Premium model used',
    severity: 'HIGH',
    summary: 'Short tasks used a premium model.',
    impact: 'About $12.50 can be saved.',
    recommendation: 'Pin a smaller model.',
  });

  assert.equal(finding.id, 'overpowered-model');
  assert.equal(finding.severity, 'high');
  assert.deepEqual(finding.metric, { wastedCost: 12.5 });
});

test('rejects unsupported LLM finding ids', () => {
  assert.equal(normalizeLLMFinding({ id: 'made_up', title: 'Nope' }), null);
});

test('extracts the first dollar amount from impact text', () => {
  assert.equal(extractImpactCost('≈ $1,234.56 wasted this week'), 1234.56);
  assert.equal(extractImpactCost('no dollar estimate'), 0);
});

test('extracts text from Responses API payloads', () => {
  assert.equal(responseText({ output_text: '[{"id":"x"}]' }), '[{"id":"x"}]');
  assert.equal(
    responseText({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '[]' }],
        },
      ],
    }),
    '[]',
  );
});
