import { parseStream, summarizeResult } from '../parse.mjs';
import { buildEnv } from './env.mjs';

export const DISTILL_MCP_RULE = 'mcp__plugin_distill_distill';

export function buildArgs({ prompt, model, arm, pluginDir, maxTurns, runBudgetUsd, userSettings = false }) {
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--allowedTools',
    arm === 'distill' ? `Read,Grep,Glob,Bash,${DISTILL_MCP_RULE}` : 'Read,Grep,Glob,Bash',
    '--max-budget-usd',
    String(runBudgetUsd),
  ];
  if (userSettings !== true) args.push('--setting-sources', 'project,local');
  if (arm === 'distill') args.push('--plugin-dir', pluginDir);
  return args;
}

export const claudeAgent = {
  name: 'claude',
  hasCost: true,
  resolveBin: (args, env) => args.claude || env.DISTILL_BENCH_CLAUDE || 'claude',
  resolveModel: (args) => ({ model: args.model, reasoning: null }),
  modelLabel: ({ model }) => model,
  buildArgs,
  buildEnv,
  parse(stdout) {
    const parsed = parseStream(stdout);
    return { parsed, summary: summarizeResult(parsed) };
  },
};
