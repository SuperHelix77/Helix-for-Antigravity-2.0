export const ACCOUNTING_POLICY = 'exclude-confirmed-provider-overloads-v1';

export function isProviderOverload(row) {
  return row.completed === false && typeof row.error === 'string' &&
    row.error.trim() === 'Our servers are currently overloaded. Please try again later.';
}

export function summarizeUsage(rows) {
  const known = key => rows.reduce((sum, row) => sum +
    (Number.isSafeInteger(row.usage?.[key]) && row.usage[key] >= 0 ? row.usage[key] : 0), 0);
  const unknown = key => rows.filter(row => !Number.isSafeInteger(row.usage?.[key]) || row.usage[key] < 0).length;
  return {
    requests: rows.length,
    failed_requests: rows.filter(row => row.status !== 200 || !row.completed).length,
    known_input: known('input_tokens'), known_output: known('output_tokens'),
    known_reasoning: known('reasoning_tokens'), known_tokens: known('total_tokens'),
    unknown_usage: unknown('total_tokens'), unknown_output: unknown('output_tokens'),
  };
}

function compare(vanilla, modified) {
  return {
    vanilla, modified, known_tokens_saved: vanilla.known_tokens - modified.known_tokens,
    known_savings_percent: vanilla.known_tokens ? 100 * (vanilla.known_tokens - modified.known_tokens) / vanilla.known_tokens : null,
    known_output_savings_percent: vanilla.known_output ? 100 * (vanilla.known_output - modified.known_output) / vanilla.known_output : null,
  };
}

export function compareBenchmarkUsage(vanillaRows, modifiedRows) {
  const included = rows => summarizeUsage(rows.filter(row => !isProviderOverload(row)));
  return {
    ...compare(included(vanillaRows), included(modifiedRows)),
    excluded_provider_overloads: {
      vanilla: summarizeUsage(vanillaRows.filter(isProviderOverload)),
      modified: summarizeUsage(modifiedRows.filter(isProviderOverload)),
    },
    all_attempts: compare(summarizeUsage(vanillaRows), summarizeUsage(modifiedRows)),
  };
}
