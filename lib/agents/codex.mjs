import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { classifyBash } from '../classify.mjs';
import { buildEnv } from './env.mjs';
import { defaultExec, failureDetail, readSkill, skillPathIn } from './install-plan.mjs';

const DISTILL = /distill/i;
const DENIAL = /approv|permission|denied|declined|not allowed|rejected|refused|blocked|cancel/i;
const SHELL_WRAPPER = /^(?:\S*\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/;

export function tomlString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export function codexConfigPath(env = process.env) {
  const home = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== '' ? env.CODEX_HOME.trim() : join(homedir(), '.codex');
  return join(home, 'config.toml');
}

function topLevelString(line, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(line);
  if (match === null) return null;
  const value = match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : match[2];
  return value === '' ? null : value;
}

export function readCodexDefaults(path) {
  const defaults = { model: null, reasoning: null };
  if (typeof path !== 'string' || !existsSync(path)) return defaults;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return defaults;
  }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    defaults.model ??= topLevelString(line, 'model');
    defaults.reasoning ??= topLevelString(line, 'model_reasoning_effort');
  }
  return defaults;
}

export function resolveCodexModel(args, env = process.env) {
  const defaults = readCodexDefaults(codexConfigPath(env));
  return { model: args['codex-model'] || defaults.model, reasoning: args['codex-reasoning'] || defaults.reasoning };
}

export function codexModelLabel({ model, reasoning }) {
  const name = model ?? 'default';
  return reasoning ? `${name}/${reasoning}` : name;
}

function realHome(baseEnv = {}) {
  return typeof baseEnv.HOME === 'string' && baseEnv.HOME !== '' ? baseEnv.HOME : homedir();
}

export function buildCodexEnv({ root, userSettings = false, ...rest }) {
  const env = buildEnv(rest);
  if (userSettings === true || typeof root !== 'string') return env;
  const baseEnv = rest.baseEnv ?? {};
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  env.CODEX_HOME = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.trim() !== '' ? baseEnv.CODEX_HOME.trim() : join(realHome(baseEnv), '.codex');
  env.HOME = home;
  return env;
}

export function mcpOverrides({ pluginDir, packageSpec, cacheDir, baseEnv = {} }) {
  const server = join(pluginDir, 'scripts', 'run.mjs');
  const environment = `{CLAUDE_PLUGIN_ROOT=${tomlString(pluginDir)}, DISTILL_PLUGIN_PACKAGE=${tomlString(packageSpec)}, DISTILL_CACHE_DIR=${tomlString(cacheDir)}, HOME=${tomlString(realHome(baseEnv))}, PATH=${tomlString(baseEnv.PATH ?? '')}}`;
  return [
    'mcp_servers.distill.command="node"',
    `mcp_servers.distill.args=[${tomlString(server)}, "mcp"]`,
    `mcp_servers.distill.env=${environment}`,
    'mcp_servers.distill.startup_timeout_sec=60',
    'mcp_servers.distill.default_tools_approval_mode="approve"',
  ];
}

export function buildArgs({ prompt, model, reasoning, arm, pluginDir, packageSpec, cacheDir, scenario = 'dev', shimDir, baseEnv = {} }) {
  const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only'];
  if (model) args.push('-m', model);
  const overrides = ['shell_environment_policy.inherit=all', 'approval_policy="never"'];
  if (reasoning) overrides.push(`model_reasoning_effort=${tomlString(reasoning)}`);
  if (scenario === 'clean' && shimDir) {
    overrides.push(`shell_environment_policy.set={PATH=${tomlString(`${shimDir}${delimiter}${baseEnv.PATH ?? ''}`)}}`);
    overrides.push('allow_login_shell=false');
  }
  if (arm === 'distill') overrides.push(...mcpOverrides({ pluginDir, packageSpec, cacheDir, baseEnv }));
  for (const override of overrides) args.push('-c', override);
  args.push(prompt);
  return args;
}

export function unwrapShell(command) {
  if (typeof command !== 'string') return command;
  const match = SHELL_WRAPPER.exec(command.trim());
  if (match === null) return command;
  const rest = match[1].trim();
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return rest.slice(1, -1).replace(/'\\''/g, "'");
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return rest;
}

function failureText(item) {
  const error = item.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (error) return JSON.stringify(error);
  if (typeof item.result?.message === 'string') return item.result.message;
  return '';
}

function mcpFailure(item) {
  const failed = item.status === 'failed' || item.status === 'declined' || (item.error !== undefined && item.error !== null);
  if (!failed) return { failed: false, denied: false };
  return { failed: true, denied: item.status === 'declined' || DENIAL.test(failureText(item)) };
}

export function parseCodexStream(raw) {
  let lastText = '';
  let malformed = 0;
  let completedTurns = 0;
  let sawFailure = false;
  let sawError = false;
  let toolItems = 0;
  let any = false;
  const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const toolCalls = {};
  const toolUses = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      malformed += 1;
      continue;
    }
    if (event.type === 'turn.completed') {
      completedTurns += 1;
      any = true;
      const u = event.usage ?? {};
      const total = u.input_tokens ?? 0;
      const cached = u.cached_input_tokens ?? 0;
      const written = u.cache_write_input_tokens ?? 0;
      usage.input += Math.max(0, total - cached - written);
      usage.output += u.output_tokens ?? 0;
      usage.cacheCreation += written;
      usage.cacheRead += cached;
    } else if (event.type === 'turn.failed') {
      sawFailure = true;
      any = true;
    } else if (event.type === 'error') {
      sawError = true;
      any = true;
    } else if (event.type === 'item.completed' && typeof event.item === 'object' && event.item !== null) {
      const item = event.item;
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') lastText = item.text;
      else if (item.type === 'command_execution') {
        toolItems += 1;
        toolCalls.Bash = (toolCalls.Bash ?? 0) + 1;
        toolUses.push({ name: 'Bash', input: { command: unwrapShell(item.command) }, ...(typeof item.id === 'string' ? { id: item.id } : {}) });
      } else if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
        toolItems += 1;
        const name = `mcp__${typeof item.server === 'string' ? item.server : 'unknown'}__${item.tool}`;
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        const use = { name, input: item.arguments ?? {}, ...(typeof item.id === 'string' ? { id: item.id } : {}) };
        if (mcpFailure(item).denied) use.denied = true;
        toolUses.push(use);
      }
    }
  }
  const deniedToolUses = toolUses.filter((use) => use.denied === true).map((use) => use.name);
  const toolSignal = toolUses.some((use) => use.denied !== true && (DISTILL.test(use.name) || (use.name === 'Bash' && classifyBash(use.input.command).has('skill-distill'))));
  const result = any ? { failed: sawFailure || (sawError && completedTurns === 0) } : null;
  return { result, lastText, malformed, toolCalls, toolUses, converted: false, distillUsed: toolSignal, deniedToolUses, permissionDenials: deniedToolUses.length, usage, toolItems };
}

export function summarizeCodex(parsed) {
  const { result } = parsed;
  if (result === null) return null;
  return {
    isError: result.failed,
    subtype: result.failed ? 'turn_failed' : 'success',
    text: parsed.lastText,
    numTurns: parsed.toolItems + 1,
    costUsd: null,
    durationMs: null,
    usage: parsed.usage,
  };
}

export function prepareCodex({ arm, root, env, baseEnv = {}, packageSpec, userSettings = false, exec = defaultExec }) {
  if (arm !== 'distill' || userSettings === true || typeof root !== 'string') return null;
  const npmEnv = { ...env, npm_config_cache: env.npm_config_cache ?? baseEnv.npm_config_cache ?? join(realHome(baseEnv), '.npm') };
  let skill;
  try {
    skill = readSkill({ agentFlag: '--codex', packageSpec, cwd: root, env: npmEnv, exec });
  } catch (error) {
    return `distill agents install --dry-run failed: ${failureDetail(error)}`;
  }
  if (skill === null) return null;
  try {
    const file = skillPathIn(join(root, 'home'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, skill);
  } catch (error) {
    return `could not write the distill skill: ${failureDetail(error)}`;
  }
  return null;
}

export const codexAgent = {
  name: 'codex',
  hasCost: false,
  resolveBin: (args, env) => args['codex-bin'] || env.DISTILL_BENCH_CODEX || 'codex',
  resolveModel: resolveCodexModel,
  modelLabel: codexModelLabel,
  buildArgs,
  buildEnv: buildCodexEnv,
  prepare: prepareCodex,
  parse(stdout) {
    const parsed = parseCodexStream(stdout);
    return { parsed, summary: summarizeCodex(parsed) };
  },
};
