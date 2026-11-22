export const CODEX_DEFAULT_MAX_RUNS = 20;

const SPEC = {
  arms: { type: 'list', default: 'baseline,distill' },
  repeats: { type: 'int', default: 1, min: 1 },
  tasks: { type: 'string', default: '' },
  agent: { type: 'string', default: 'claude' },
  model: { type: 'string', default: 'sonnet' },
  'codex-model': { type: 'string', default: '' },
  'codex-reasoning': { type: 'string', default: '' },
  'codex-bin': { type: 'string', default: '' },
  'opencode-model': { type: 'string', default: '' },
  'opencode-bin': { type: 'string', default: '' },
  'max-cost-usd': { type: 'number', default: 20 },
  'max-runs': { type: 'int', default: Number.POSITIVE_INFINITY, min: 1 },
  package: { type: 'string', default: 'distill-llm@latest' },
  'distill-repo': { type: 'string', default: '' },
  results: { type: 'string', default: '' },
  scenario: { type: 'string', default: 'dev' },
  resume: { type: 'bool', default: false },
  night: { type: 'string', default: '' },
  seed: { type: 'string', default: '' },
  claude: { type: 'string', default: '' },
  'run-budget-usd': { type: 'number', default: 2 },
  'max-turns': { type: 'int', default: 30, min: 1 },
  'timeout-ms': { type: 'int', default: 15 * 60 * 1000, min: 1 },
  'tasks-file': { type: 'string', default: '' },
  'corpus-file': { type: 'string', default: '' },
  keep: { type: 'bool', default: false },
  'dry-run': { type: 'bool', default: false },
  paired: { type: 'bool', default: false },
  'user-settings': { type: 'bool', default: false },
};

export function parseArgs(argv) {
  const values = {};
  for (const [key, spec] of Object.entries(SPEC)) values[key] = spec.default;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const inline = arg.indexOf('=');
    const key = inline === -1 ? arg.slice(2) : arg.slice(2, inline);
    const spec = SPEC[key];
    if (!spec) throw new Error(`Unknown option --${key}`);
    if (spec.type === 'bool') {
      values[key] = true;
      continue;
    }
    let raw = inline === -1 ? argv[i + 1] : arg.slice(inline + 1);
    if (inline === -1) i += 1;
    if (raw === undefined || (inline === -1 && raw.startsWith('--'))) throw new Error(`--${key} needs a value`);
    raw = String(raw);
    if (spec.type === 'int' || spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n)) || (spec.min !== undefined && n < spec.min) || n < 0) {
        throw new Error(`--${key} must be a valid number, got ${raw}`);
      }
      values[key] = n;
    } else if (spec.type === 'list') {
      values[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      values[key] = raw;
    }
  }
  if (typeof values.arms === 'string') values.arms = values.arms.split(',');
  for (const arm of values.arms) if (arm !== 'baseline' && arm !== 'distill') throw new Error(`Unknown arm ${arm}`);
  if (values.arms.length === 0) throw new Error('--arms needs at least one arm');
  if (!['dev', 'clean', 'both'].includes(values.scenario)) throw new Error(`--scenario must be dev, clean or both, got ${values.scenario}`);
  if (!['claude', 'codex', 'opencode'].includes(values.agent)) throw new Error(`--agent must be claude, codex or opencode, got ${values.agent}`);
  if (values.agent === 'opencode' && values['opencode-model'] === '') throw new Error('--agent opencode needs --opencode-model <provider/model>, for example openrouter/z-ai/glm-5.3');
  if (values['codex-reasoning'] !== '' && !['low', 'medium', 'high'].includes(values['codex-reasoning'])) throw new Error(`--codex-reasoning must be low, medium or high, got ${values['codex-reasoning']}`);
  values['max-runs-defaulted'] = false;
  if (values.agent === 'codex' && values['max-runs'] === Number.POSITIVE_INFINITY) {
    values['max-runs'] = CODEX_DEFAULT_MAX_RUNS;
    values['max-runs-defaulted'] = true;
  }
  return values;
}
