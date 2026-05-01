// USD per 1,000,000 tokens. Best-effort pricing as of 2025.
// Cache write here is the "5-minute write" rate for Anthropic; OpenAI does not bill cache writes.
// If a model is unknown we fall back to a reasonable mid-tier estimate so something shows.

const PRICING = [
  // ---- Anthropic Claude ----
  { match: /opus-4|claude-4-opus|claude-opus-4/i,    input: 15.00, output: 75.00, cacheRead: 1.50,  cacheCreate: 18.75 },
  { match: /sonnet-4|claude-4-sonnet|claude-sonnet-4/i, input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheCreate: 3.75 },
  { match: /haiku-4|claude-4-haiku|claude-haiku-4/i, input: 1.00,  output: 5.00,  cacheRead: 0.10,  cacheCreate: 1.25 },
  { match: /3-?5-sonnet|3\.5-sonnet/i,               input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheCreate: 3.75 },
  { match: /3-?5-haiku|3\.5-haiku/i,                 input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheCreate: 1.00 },
  { match: /3-?opus/i,                                input: 15.00, output: 75.00, cacheRead: 1.50,  cacheCreate: 18.75 },
  { match: /3-?sonnet/i,                              input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheCreate: 3.75 },
  { match: /3-?haiku/i,                               input: 0.25,  output: 1.25,  cacheRead: 0.03,  cacheCreate: 0.30 },

  // ---- OpenAI ----
  { match: /^gpt-5|gpt5/i,                            input: 2.50,  output: 10.00, cacheRead: 0.25,  cacheCreate: 0 },
  { match: /gpt-4\.1-mini/i,                          input: 0.40,  output: 1.60,  cacheRead: 0.10,  cacheCreate: 0 },
  { match: /gpt-4\.1/i,                               input: 2.00,  output: 8.00,  cacheRead: 0.50,  cacheCreate: 0 },
  { match: /gpt-4o-mini/i,                            input: 0.15,  output: 0.60,  cacheRead: 0.075, cacheCreate: 0 },
  { match: /gpt-4o/i,                                 input: 2.50,  output: 10.00, cacheRead: 1.25,  cacheCreate: 0 },
  { match: /o4-mini/i,                                input: 1.10,  output: 4.40,  cacheRead: 0.275, cacheCreate: 0 },
  { match: /o3-mini/i,                                input: 1.10,  output: 4.40,  cacheRead: 0.55,  cacheCreate: 0 },
  { match: /o3/i,                                     input: 2.00,  output: 8.00,  cacheRead: 0.50,  cacheCreate: 0 },
  { match: /o1-mini/i,                                input: 1.10,  output: 4.40,  cacheRead: 0.55,  cacheCreate: 0 },
  { match: /o1/i,                                     input: 15.00, output: 60.00, cacheRead: 7.50,  cacheCreate: 0 },
  { match: /codex-mini/i,                             input: 1.50,  output: 6.00,  cacheRead: 0.375, cacheCreate: 0 },
];

const FALLBACK = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 };

export function getRates(model) {
  if (!model) return { ...FALLBACK, fallback: true, label: 'unknown' };
  for (const p of PRICING) {
    if (p.match.test(model)) return { ...p, fallback: false, label: model };
  }
  return { ...FALLBACK, fallback: true, label: model };
}

export function computeCost({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 }, model) {
  const r = getRates(model);
  const c = {
    input: (input / 1e6) * r.input,
    output: (output / 1e6) * r.output,
    cacheRead: (cacheRead / 1e6) * r.cacheRead,
    cacheCreate: (cacheCreate / 1e6) * r.cacheCreate,
  };
  c.total = c.input + c.output + c.cacheRead + c.cacheCreate;
  return { ...c, fallback: r.fallback, rates: r };
}
