import { claudeAgent } from './claude.mjs';
import { codexAgent } from './codex.mjs';
import { opencodeAgent } from './opencode.mjs';

export const AGENTS = { claude: claudeAgent, codex: codexAgent, opencode: opencodeAgent };

export function getAgent(name = 'claude') {
  const agent = AGENTS[name];
  if (!agent) throw new Error(`Unknown agent ${name}`);
  return agent;
}
