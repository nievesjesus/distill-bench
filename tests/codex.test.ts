import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const repo = resolve(__dirname, '..');
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', name)).href);
const sha = 'a'.repeat(64);

interface Rec {
  [key: string]: unknown;
}
const lines = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const shell = (id: string, inner: string, output = '') => [
  { type: 'item.started', item: { id, type: 'command_execution', command: `/bin/zsh -lc '${inner}'`, aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id, type: 'command_execution', command: `/bin/zsh -lc '${inner}'`, aggregated_output: output, exit_code: 0, status: 'completed' } },
];
const message = (text: string, id = 'item_msg') => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const completed = (extra: object = {}) => ({ type: 'turn.completed', usage: { input_tokens: 35708, cached_input_tokens: 29824, cache_write_input_tokens: 0, output_tokens: 43, reasoning_output_tokens: 0, ...extra } });
const mcpCall = (status: string, extra: object = {}) => ({ type: 'item.completed', item: { id: 'item_mcp', type: 'mcp_tool_call', server: 'distill', tool: 'convert', arguments: { path: 'a.pdf' }, status, ...extra } });

const trivial = lines([
  { type: 'thread.started', thread_id: 'abc' },
  { type: 'turn.started' },
  ...shell('item_0', 'head -n 1 a.txt', 'hello file\n'),
  message('hello'),
  completed(),
]);

describe('parseCodexStream', () => {
  it('parses the trivial real run', async () => {
    const { parseCodexStream, summarizeCodex } = await load('agents/codex.mjs');
    const parsed = parseCodexStream(trivial);
    expect(parsed.malformed).toBe(0);
    expect(parsed.toolCalls).toEqual({ Bash: 1 });
    expect(parsed.toolUses).toEqual([{ name: 'Bash', input: { command: 'head -n 1 a.txt' }, id: 'item_0' }]);
    expect(parsed.distillUsed).toBe(false);
    expect(summarizeCodex(parsed)).toEqual({
      isError: false,
      subtype: 'success',
      text: 'hello',
      numTurns: 2,
      costUsd: null,
      durationMs: null,
      usage: { input: 5884, output: 43, cacheCreation: 0, cacheRead: 29824 },
    });
  });

  it('counts a distill MCP call that succeeded', async () => {
    const { parseCodexStream } = await load('agents/codex.mjs');
    const { classifyPaths } = await load('classify.mjs');
    const parsed = parseCodexStream(lines([mcpCall('completed', { result: { content: [{ type: 'text', text: 'ok' }] } }), message('ANSWER: 1'), completed()]));
    expect(parsed.toolUses).toEqual([{ name: 'mcp__distill__convert', input: { path: 'a.pdf' }, id: 'item_mcp' }]);
    expect(parsed.toolCalls).toEqual({ mcp__distill__convert: 1 });
    expect(parsed.distillUsed).toBe(true);
    expect(parsed.permissionDenials).toBe(0);
    expect(classifyPaths(parsed)).toEqual(['mcp-distill']);
  });

  it('flags a refused MCP call as denied and does not count it as use', async () => {
    const { parseCodexStream } = await load('agents/codex.mjs');
    const { classifyPaths } = await load('classify.mjs');
    const parsed = parseCodexStream(lines([mcpCall('failed', { error: { message: 'user cancelled MCP tool call' } }), message('ANSWER: 1'), completed()]));
    expect(parsed.toolUses[0].denied).toBe(true);
    expect(parsed.permissionDenials).toBe(1);
    expect(parsed.deniedToolUses).toEqual(['mcp__distill__convert']);
    expect(parsed.distillUsed).toBe(false);
    expect(classifyPaths(parsed)).toEqual(['mcp-denied']);
  });

  it('treats a generic MCP failure as use, not as a denial', async () => {
    const { parseCodexStream } = await load('agents/codex.mjs');
    const { classifyPaths } = await load('classify.mjs');
    for (const failure of [{ status: 'failed', error: { message: 'conversion crashed' } }, { status: 'completed', error: 'conversion crashed' }]) {
      const parsed = parseCodexStream(lines([mcpCall(failure.status, { error: failure.error }), completed()]));
      expect(parsed.toolUses[0].denied).toBeUndefined();
      expect(parsed.permissionDenials).toBe(0);
      expect(parsed.distillUsed).toBe(true);
      expect(classifyPaths(parsed)).toEqual(['mcp-distill']);
    }
  });

  it('sums usage over several turns and keeps the last message', async () => {
    const { parseCodexStream, summarizeCodex } = await load('agents/codex.mjs');
    const summary = summarizeCodex(parseCodexStream(lines([message('first', 'm1'), completed(), message('second', 'm2'), completed({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 7 })])));
    expect(summary.text).toBe('second');
    expect(summary.usage).toEqual({ input: 5884 + 50, output: 50, cacheCreation: 10, cacheRead: 29864 });
  });

  it('flags failed turns and error-only runs, and survives garbage', async () => {
    const { parseCodexStream, summarizeCodex } = await load('agents/codex.mjs');
    expect(summarizeCodex(parseCodexStream(lines([{ type: 'turn.failed', error: { message: 'x' } }])))).toMatchObject({ isError: true, subtype: 'turn_failed' });
    expect(summarizeCodex(parseCodexStream(lines([{ type: 'error', message: 'x' }])))?.isError).toBe(true);
    expect(summarizeCodex(parseCodexStream(lines([{ type: 'error', message: 'Reconnecting 1/5' }, message('a'), completed()])))?.isError).toBe(false);
    const garbage = parseCodexStream('garbage\n{"type":\n[1]\n');
    expect(garbage.malformed).toBe(3);
    expect(summarizeCodex(garbage)).toBeNull();
  });

  it('counts each item once', async () => {
    const { parseCodexStream } = await load('agents/codex.mjs');
    const parsed = parseCodexStream(lines([...shell('a', 'ls'), ...shell('a', 'ls'), completed()]));
    expect(parsed.toolCalls).toEqual({ Bash: 1 });
  });
});

describe('shell unwrapping and classification', () => {
  it('unwraps login shell wrappers', async () => {
    const { unwrapShell } = await load('agents/codex.mjs');
    expect(unwrapShell("/bin/zsh -lc 'head -n 1 a.txt'")).toBe('head -n 1 a.txt');
    expect(unwrapShell('/bin/bash -c "echo \\"hi\\" | wc -l"')).toBe('echo "hi" | wc -l');
    expect(unwrapShell("zsh -lc 'echo '\\''x'\\'''")).toBe("echo 'x'");
    expect(unwrapShell('pdftotext a.pdf -')).toBe('pdftotext a.pdf -');
  });

  it('classifies an unwrapped pdftotext command as bash-pdftools', async () => {
    const { parseCodexStream } = await load('agents/codex.mjs');
    const { classifyPaths } = await load('classify.mjs');
    expect(classifyPaths(parseCodexStream(lines([...shell('i', 'pdftotext -layout a.pdf -'), completed()])))).toEqual(['bash-pdftools']);
    expect(classifyPaths(parseCodexStream(lines([...shell('i', 'python3 -c "import pypdf"'), completed()])))).toEqual(['bash-python']);
    expect(classifyPaths(parseCodexStream(lines([...shell('i', 'head -n 1 a.txt'), completed()])))).toEqual(['bash-other']);
    expect(classifyPaths(parseCodexStream(lines([...shell('i', 'npx distill-llm convert a.pdf'), completed()])))).toEqual(['skill-distill']);
  });
});

describe('codex buildArgs', () => {
  const base = { prompt: 'PROMPT', model: 'gpt-x', reasoning: 'high', pluginDir: '/p/plugins/distill', packageSpec: 'distill-llm@1.2.3', cacheDir: '/c/cache', shimDir: '/s/shims', baseEnv: { PATH: '/usr/bin', HOME: '/real/home' } };
  const overrides = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-c');

  it('has the isolation flags on both arms and the prompt last', async () => {
    const { buildArgs } = await load('agents/codex.mjs');
    for (const arm of ['baseline', 'distill']) {
      const argv = buildArgs({ ...base, arm });
      expect(argv.slice(0, 7)).toEqual(['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only']);
      expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-x');
      expect(overrides(argv)).toContain('model_reasoning_effort="high"');
      expect(overrides(argv)).toContain('shell_environment_policy.inherit=all');
      expect(argv[argv.length - 1]).toBe('PROMPT');
    }
  });

  it('adds no MCP overrides on baseline and all of them on distill', async () => {
    const { buildArgs } = await load('agents/codex.mjs');
    expect(overrides(buildArgs({ ...base, arm: 'baseline' })).filter((o: string) => o.startsWith('mcp_servers'))).toEqual([]);
    expect(overrides(buildArgs({ ...base, arm: 'distill' })).filter((o: string) => o.startsWith('mcp_servers'))).toEqual([
      'mcp_servers.distill.command="node"',
      'mcp_servers.distill.args=["/p/plugins/distill/scripts/run.mjs", "mcp"]',
      'mcp_servers.distill.env={CLAUDE_PLUGIN_ROOT="/p/plugins/distill", DISTILL_PLUGIN_PACKAGE="distill-llm@1.2.3", DISTILL_CACHE_DIR="/c/cache", HOME="/real/home", PATH="/usr/bin"}',
      'mcp_servers.distill.startup_timeout_sec=60',
      'mcp_servers.distill.default_tools_approval_mode="approve"',
    ]);
  });

  it('omits -m and reasoning when unset and escapes TOML strings', async () => {
    const { buildArgs, tomlString } = await load('agents/codex.mjs');
    const argv = buildArgs({ ...base, model: null, reasoning: null, arm: 'distill', pluginDir: '/p/"q"\\x', packageSpec: 'a"b' });
    expect(argv).not.toContain('-m');
    expect(overrides(argv).some((o: string) => o.startsWith('model_reasoning_effort'))).toBe(false);
    expect(overrides(argv).join('\n')).toContain('CLAUDE_PLUGIN_ROOT="/p/\\"q\\"\\\\x"');
    expect(overrides(argv).join('\n')).toContain('DISTILL_PLUGIN_PACKAGE="a\\"b"');
    expect(tomlString('a\\b"c\nd')).toBe('"a\\\\b\\"c\\nd"');
  });

  it('puts the shim dir in the shell environment only for the clean scenario', async () => {
    const { buildArgs } = await load('agents/codex.mjs');
    const clean = overrides(buildArgs({ ...base, arm: 'baseline', scenario: 'clean' }));
    expect(clean).toContain('shell_environment_policy.set={PATH="/s/shims:/usr/bin"}');
    expect(clean).toContain('allow_login_shell=false');
    const dev = overrides(buildArgs({ ...base, arm: 'baseline', scenario: 'dev' }));
    expect(dev.some((o: string) => o.includes('shims') || o.startsWith('allow_login_shell'))).toBe(false);
  });
});

describe('codex env isolation', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'distill-bench-codexenv-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const spec = (over: Rec = {}) => ({ arm: 'baseline', packageSpec: 'p@1', cacheDir: '/c/cache', scenario: 'dev', baseEnv: { PATH: '/usr/bin', HOME: '/real/home' }, ...over });

  it('gives codex a per-run HOME under the run root and pins CODEX_HOME', async () => {
    const { codexAgent } = await load('agents/codex.mjs');
    const env = codexAgent.buildEnv(spec({ root }));
    expect(env.HOME).toBe(join(root, 'home'));
    expect(existsSync(env.HOME)).toBe(true);
    expect(env.CODEX_HOME).toBe('/real/home/.codex');
    const pinned = codexAgent.buildEnv(spec({ root, baseEnv: { PATH: '/usr/bin', HOME: '/real/home', CODEX_HOME: '/custom/codex' } }));
    expect(pinned.CODEX_HOME).toBe('/custom/codex');
    expect(pinned.HOME).toBe(join(root, 'home'));
  });

  it('keeps the real HOME with userSettings', async () => {
    const { codexAgent } = await load('agents/codex.mjs');
    const env = codexAgent.buildEnv(spec({ root, userSettings: true }));
    expect(env.HOME).toBe('/real/home');
    expect(env.CODEX_HOME).toBeUndefined();
    expect(existsSync(join(root, 'home'))).toBe(false);
  });

  it('passes the real HOME and the pre-shim PATH to the distill MCP server', async () => {
    const { buildArgs } = await load('agents/codex.mjs');
    const argv = buildArgs({ prompt: 'P', arm: 'distill', pluginDir: '/p', packageSpec: 'p@1', cacheDir: '/c', scenario: 'clean', shimDir: '/s/shims', baseEnv: { PATH: '/usr/bin', HOME: '/real/home' } });
    const mcpEnv = argv.filter((a: string, i: number) => argv[i - 1] === '-c' && a.startsWith('mcp_servers.distill.env='))[0];
    expect(mcpEnv).toContain('HOME="/real/home"');
    expect(mcpEnv).toContain('PATH="/usr/bin"');
    expect(mcpEnv).not.toContain('shims');
  });
});

describe('codex model defaults', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-bench-codexcfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the top-level model and reasoning only', async () => {
    const { readCodexDefaults } = await load('agents/codex.mjs');
    const file = join(dir, 'config.toml');
    writeFileSync(file, '# comment\nmodel_provider = "x"\npersonality = "pragmatic"\nmodel = "gpt-6-astra" # note\nmodel_reasoning_effort = \'high\'\n\n[profiles.fast]\nmodel = "other"\nmodel_reasoning_effort = "low"\n');
    expect(readCodexDefaults(file)).toEqual({ model: 'gpt-6-astra', reasoning: 'high' });
  });

  it('returns nulls for a missing file or missing keys', async () => {
    const { readCodexDefaults } = await load('agents/codex.mjs');
    expect(readCodexDefaults(join(dir, 'nope.toml'))).toEqual({ model: null, reasoning: null });
    writeFileSync(join(dir, 'config.toml'), '[projects."/x"]\nmodel = "hidden"\n');
    expect(readCodexDefaults(join(dir, 'config.toml'))).toEqual({ model: null, reasoning: null });
  });

  it('prefers the command line and builds the record label', async () => {
    const { resolveCodexModel, codexModelLabel, codexConfigPath } = await load('agents/codex.mjs');
    writeFileSync(join(dir, 'config.toml'), 'model = "from-config"\nmodel_reasoning_effort = "medium"\n');
    const env = { CODEX_HOME: dir };
    expect(codexConfigPath(env)).toBe(join(dir, 'config.toml'));
    expect(resolveCodexModel({ 'codex-model': '', 'codex-reasoning': '' }, env)).toEqual({ model: 'from-config', reasoning: 'medium' });
    expect(resolveCodexModel({ 'codex-model': 'cli', 'codex-reasoning': 'low' }, env)).toEqual({ model: 'cli', reasoning: 'low' });
    expect(codexModelLabel({ model: 'cli', reasoning: 'low' })).toBe('cli/low');
    expect(codexModelLabel({ model: null, reasoning: null })).toBe('default');
  });
});

describe('codex options', () => {
  it('validates --agent and --codex-reasoning and defaults --max-runs to 20 for codex only', async () => {
    const { parseArgs } = await load('args.mjs');
    expect(parseArgs([])).toMatchObject({ agent: 'claude', 'max-runs': Number.POSITIVE_INFINITY, 'max-runs-defaulted': false });
    expect(parseArgs(['--agent', 'codex'])).toMatchObject({ agent: 'codex', 'max-runs': 20, 'max-runs-defaulted': true });
    expect(parseArgs(['--agent', 'codex', '--max-runs', '5'])).toMatchObject({ 'max-runs': 5, 'max-runs-defaulted': false });
    expect(() => parseArgs(['--agent', 'gemini'])).toThrow('--agent must be claude or codex');
    expect(() => parseArgs(['--codex-reasoning', 'extreme'])).toThrow('--codex-reasoning');
    expect(parseArgs(['--codex-model', 'm', '--codex-reasoning', 'low', '--codex-bin', '/x'])).toMatchObject({ 'codex-model': 'm', 'codex-reasoning': 'low', 'codex-bin': '/x' });
  });

  it('keeps agents apart in resume keys and nightly cost', async () => {
    const { unitKey, finishedKeys, nightCost } = await load('plan.mjs');
    const base = { night: 'n', task: 't', arm: 'baseline', repeat: 1, model: 'm', ok: true };
    const keys = finishedKeys([{ ...base, agent: 'codex' }]);
    expect(keys.has(unitKey('n', 't', 'baseline', 1, 'm', 'dev', 'codex'))).toBe(true);
    expect(keys.has(unitKey('n', 't', 'baseline', 1, 'm', 'dev', 'claude'))).toBe(false);
    expect(finishedKeys([base]).has(unitKey('n', 't', 'baseline', 1, 'm'))).toBe(true);
    expect(nightCost([{ night: 'n', costUsd: 2 }, { night: 'n', costUsd: 3, agent: 'codex' }], 'n', undefined, 'claude')).toBe(2);
  });
});

const rec =(over: Rec = {}): Rec => ({
  night: '2026-11-19',
  task: 't1',
  doc: 'd1',
  arm: 'baseline',
  agent: 'codex',
  model: 'gpt-x/high',
  package: null,
  repeat: 1,
  attempt: 1,
  ok: true,
  costUsd: null,
  usage: { input: 1000, output: 50, cacheCreation: 0, cacheRead: 9000 },
  numTurns: 3,
  durationMs: 20_000,
  distillUsed: false,
  correct: true,
  ...over,
});
const tasks = [{ id: 't1', doc: 'd1', tags: ['simple'] }];

describe('codex in aggregate and report', () => {
  it('groups by agent so claude and codex are never mixed or paired together', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const claude = (over: Rec = {}) => rec({ agent: 'claude', model: 'sonnet', costUsd: 1, ...over });
    const data = aggregate([claude(), claude({ arm: 'distill', package: 'distill-llm@1', distillUsed: true, costUsd: 0.5 }), rec(), rec({ arm: 'distill', package: 'distill-llm@1', distillUsed: true, usage: { input: 500, output: 50, cacheCreation: 0, cacheRead: 4500 } })], tasks);
    expect(data.header.agents).toEqual(['claude', 'codex']);
    expect(data.agents.claude.scenarios.dev.pairs[0].costRatio).toBeCloseTo(0.5);
    expect(data.agents.codex.scenarios.dev.pairs[0].costRatio).toBeNull();
    expect(data.agents.codex.scenarios.dev.pairs[0].tokenRatio).toBeCloseTo(0.5);
    expect(data.agents.codex.scenarios.dev.arms.baseline.runs).toBe(1);
    expect(data.agents.codex.header).toMatchObject({ spentUsd: null, models: ['gpt-x/high'] });
    expect(data.agents.claude.header.spentUsd).toBeCloseTo(1.5);
    expect(data.scenarios.dev.arms.baseline.runs).toBe(1);
  });

  it('keeps retries of different agents as separate units', async () => {
    const { finalRecords } = await load('aggregate.mjs');
    expect(finalRecords([rec({ agent: 'claude' }), rec()])).toHaveLength(2);
  });

  it('renders codex rows with n/a cost and never $0.00', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    const records = [rec(), rec({ arm: 'distill', package: 'distill-llm@1', distillUsed: true, paths: ['mcp-distill', 'bash-other'], usage: { input: 500, output: 50, cacheCreation: 0, cacheRead: 4500 } })];
    const md = renderReport(aggregate(records, tasks));
    expect(md).toContain('## Agent codex');
    expect(md).toContain('### Scenario dev');
    expect(md).toContain('| baseline | 1 | 0% (0) | 100% | n/a | 10,000 (10,000-10,000) | 3.0 (3.0-3.0) | 20s (20s-20s) | n/a |');
    expect(md).toContain('- Cost: n/a, Codex does not report cost in USD');
    expect(md).toContain('0.50x');
    expect(md).toContain('cost n/a');
    expect(md).not.toContain('$0.00');
    expect(md).not.toContain('## Agent claude');
  });

  it('renders one section per agent with their own numbers', async () => {
    const { aggregate } = await load('aggregate.mjs');
    const { renderReport } = await load('render.mjs');
    const claude = (over: Rec = {}) => rec({ agent: 'claude', model: 'sonnet', costUsd: 2, ...over });
    const md = renderReport(aggregate([claude(), claude({ arm: 'distill', package: 'distill-llm@1', distillUsed: true, costUsd: 3 }), rec()], tasks));
    const claudeAt = md.indexOf('## Agent claude');
    const codexAt = md.indexOf('## Agent codex');
    expect(claudeAt).toBeGreaterThan(-1);
    expect(codexAt).toBeGreaterThan(claudeAt);
    expect(md.slice(claudeAt, codexAt)).toContain('1.50x');
    expect(md.slice(codexAt)).not.toContain('1.50x');
  });

  it('report CLI filters by --agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-report-agent-'));
    try {
      const results = join(dir, 'results');
      mkdirSync(results);
      const all = [rec({ agent: 'claude', model: 'sonnet', costUsd: 1 }), rec()].map((r) => JSON.stringify(r));
      writeFileSync(join(results, 'runs.jsonl'), `${all.join('\n')}\n`);
      const run = (args: string[]) => spawnSync(process.execPath, [join(repo, 'report.mjs'), '--results', results, ...args], { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'home') } });
      expect(run(['--agent', 'codex']).status).toBe(0);
      const json = JSON.parse(readFileSync(join(results, 'report.json'), 'utf8'));
      expect(json.header.agents).toEqual(['codex']);
      expect(run(['--agent', 'nope']).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('bench runner with a fake codex', () => {
  let dir: string;
  let results: string;
  let log: string;
  let fake: string;
  let home: string;

  const task = (id: string, doc: string, value: number) => ({ id, doc, question: `What is ${id}?`, expected: { type: 'number', value }, tags: ['simple'], source: 'test' });
  const docEntry = (id: string) => ({ id, url: `https://example.com/${id}.pdf`, sha256: sha, ext: 'pdf', license: 'test', title: id });

  function setup(behaviors: Record<string, unknown[]>, tasksList = [task('t1', 'd1', 5), task('t2', 'd2', 7)]) {
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(['d1', 'd2'].map(docEntry)));
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasksList));
    writeFileSync(join(dir, 'cfg.json'), JSON.stringify({ log, counter: join(dir, 'counter'), behaviors }));
  }

  function bench(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      [join(repo, 'run.mjs'), '--agent', 'codex', '--tasks-file', join(dir, 'tasks.json'), '--corpus-file', join(dir, 'corpus.json'), '--results', results, '--distill-repo', join(dir, 'distill'), '--codex-bin', fake, '--package', 'distill-llm@9.9.9', '--night', '2026-11-19', ...args],
      { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'bench'), FAKE_CODEX_CFG: join(dir, 'cfg.json'), CODEX_HOME: home, ...extraEnv }, timeout: 60_000 },
    );
  }

  const records = () =>
    readFileSync(join(results, 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const overrides = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-c');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'distill-bench-codex-'));
    results = join(dir, 'results');
    log = join(dir, 'calls.jsonl');
    fake = join(dir, 'fake-codex.mjs');
    home = join(dir, 'codex-home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-test"\nmodel_reasoning_effort = "high"\n');
    copyFileSync(join(repo, 'tests', 'fixtures', 'fake-codex.mjs'), fake);
    chmodSync(fake, 0o755);
    mkdirSync(join(dir, 'distill', 'plugins', 'distill'), { recursive: true });
    const corpus = join(dir, 'bench', 'corpus');
    mkdirSync(corpus, { recursive: true });
    for (const id of ['d1', 'd2']) writeFileSync(join(corpus, `${id}.pdf`), `%PDF fake ${id}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs both arms end to end, tagging records with the agent and a null cost', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }], 'd2.pdf|distill': [{ kind: 'ok', answer: '7', mcp: 'ok', commands: ['ls'] }] });
    const out = bench([]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('codex reports no cost in USD');
    expect(out.stdout).toContain('--max-runs 20 (default for this agent)');
    const recs = records();
    expect(recs).toHaveLength(4);
    expect(recs.every((r) => r.agent === 'codex' && r.model === 'gpt-test/high' && r.costUsd === null && r.ok === true && r.night === '2026-11-19')).toBe(true);
    expect(recs.find((r) => r.task === 't1' && r.arm === 'baseline')).toMatchObject({
      correct: true,
      answer: '5',
      package: null,
      numTurns: 2,
      usage: { input: 5884, output: 43, cacheCreation: 0, cacheRead: 29824 },
      toolCalls: { Bash: 1 },
      paths: ['bash-other'],
      distillUsed: false,
    });
    expect(recs.find((r) => r.task === 't2' && r.arm === 'distill')).toMatchObject({ correct: true, package: 'distill-llm@9.9.9', distillUsed: true, paths: ['mcp-distill', 'bash-other'], permissionDenials: 0 });
    const c = calls();
    expect(c).toHaveLength(4);
    for (const x of c) {
      expect(x.argv.slice(0, 7)).toEqual(['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only']);
      expect(x.argv[x.argv.indexOf('-m') + 1]).toBe('gpt-test');
      expect(overrides(x.argv)).toContain('model_reasoning_effort="high"');
      expect(x.files).toHaveLength(1);
      expect(existsSync(x.cwd)).toBe(false);
    }
    expect(c.filter((x) => x.key.endsWith('baseline')).every((x) => !overrides(x.argv).some((o: string) => o.startsWith('mcp_servers')))).toBe(true);
    const distill = c.filter((x) => x.key.endsWith('distill'));
    expect(distill.every((x) => overrides(x.argv).filter((o: string) => o.startsWith('mcp_servers')).length === 5)).toBe(true);
    expect(distill.every((x) => overrides(x.argv).join('\n').includes(`DISTILL_CACHE_DIR="${x.cacheDir}"`))).toBe(true);
    expect(existsSync(join(results, '.lock-codex'))).toBe(false);
    expect(existsSync(join(results, '.lock'))).toBe(false);
  });

  it('records a refused MCP call as mcp-denied and a generic failure as use', () => {
    setup({ 'd1.pdf|distill': [{ kind: 'ok', answer: '5', mcp: 'denied' }], 'd2.pdf|distill': [{ kind: 'ok', answer: '7', mcp: 'failed' }] });
    bench(['--arms', 'distill']);
    const recs = records();
    expect(recs.find((r) => r.task === 't1')).toMatchObject({ distillUsed: false, permissionDenials: 1, paths: ['mcp-denied', 'bash-other'] });
    expect(recs.find((r) => r.task === 't2')).toMatchObject({ distillUsed: true, permissionDenials: 0, paths: ['mcp-distill', 'bash-other'] });
  });

  it('retries a failed turn once and records both attempts', () => {
    setup({ 'd1.pdf|baseline': [{ kind: 'fail' }, { kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline']);
    const recs = records();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: false, attempt: 1, error: 'codex reported turn_failed', correct: null });
    expect(recs[1]).toMatchObject({ ok: true, attempt: 2, correct: true });
  });

  it('adds the clean scenario shims to the shell environment', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    bench(['--arms', 'baseline,distill', '--scenario', 'clean']);
    const c = calls();
    expect(c).toHaveLength(2);
    for (const x of c) {
      expect(x.pathHead).toMatch(/shims$/);
      expect(overrides(x.argv).find((o: string) => o.startsWith('shell_environment_policy.set='))).toMatch(/^shell_environment_policy\.set=\{PATH="[^"]+\/shims:/);
      expect(overrides(x.argv)).toContain('allow_login_shell=false');
    }
    expect(records().every((r) => r.scenario === 'clean')).toBe(true);
  });

  it('resumes per agent, so claude records never count as codex runs', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5)]);
    mkdirSync(results, { recursive: true });
    const old = { night: '2026-11-19', task: 't1', arm: 'baseline', repeat: 1, model: 'gpt-test/high', scenario: 'dev', ok: true, attempt: 1, costUsd: 5 };
    writeFileSync(join(results, 'runs.jsonl'), `${JSON.stringify(old)}\n`);
    const out = bench(['--arms', 'baseline', '--resume']);
    expect(out.stdout).toContain('Resume: 0 of 1 runs already done');
    expect(records()).toHaveLength(2);
    const again = bench(['--arms', 'baseline', '--resume']);
    expect(again.stdout).toContain('Resume: 1 of 1 runs already done');
    expect(records()).toHaveLength(2);
  });

  it('is not stopped by claude spending and honours --max-runs', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] }, [task('t1', 'd1', 5), task('t2', 'd2', 5)]);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'runs.jsonl'), `${JSON.stringify({ night: '2026-11-19', task: 'old', arm: 'baseline', repeat: 1, model: 'sonnet', scenario: 'dev', ok: true, attempt: 1, costUsd: 999 })}\n`);
    const out = bench(['--arms', 'baseline', '--max-cost-usd', '1', '--max-runs', '1']);
    expect(out.stdout).toContain('Stopping: reached --max-runs 1');
    expect(out.stdout).not.toContain('(default for this agent)');
    expect(records().filter((r) => r.agent === 'codex')).toHaveLength(1);
  });

  it('refuses to start while another codex runner holds its lock', () => {
    setup({ default: [{ kind: 'ok', answer: '5' }] });
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, '.lock-codex'), String(process.pid));
    const out = bench([]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Another benchmark runner');
  });

  it('caps the dry-run plan at the default max-runs of 20, and not for claude', () => {
    const many = Array.from({ length: 11 }, (_, i) => task(`t${i}`, 'd1', 5));
    setup({ default: [{ kind: 'ok', answer: '5' }] }, many);
    const codex = bench(['--dry-run']);
    expect(codex.stdout).toContain('20 runs planned');
    expect(codex.stdout).toContain('(default for this agent)');
    expect(bench(['--dry-run', '--max-runs', '5']).stdout).toContain('5 runs planned');
    const claude = spawnSync(process.execPath, [join(repo, 'run.mjs'), '--dry-run', '--tasks-file', join(dir, 'tasks.json'), '--corpus-file', join(dir, 'corpus.json'), '--night', '2026-11-19'], { encoding: 'utf8', env: { ...process.env, DISTILL_BENCH_DIR: join(dir, 'bench') } });
    expect(claude.stdout).toContain('22 runs planned');
    expect(claude.stdout).not.toContain('reports no cost');
    expect(calls()).toHaveLength(0);
  });
});
