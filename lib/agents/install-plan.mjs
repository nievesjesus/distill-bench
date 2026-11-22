import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export const SKILL_FILE = ['.agents', 'skills', 'distill-documents', 'SKILL.md'];

export function parseDryRun(output) {
  const files = {};
  let current = null;
  let command = null;
  for (const line of String(output).split('\n')) {
    const file = /^File: (.+)$/.exec(line);
    if (file !== null) {
      current = file[1].trim();
      files[current] = [];
      continue;
    }
    if (current !== null && (line.startsWith('+ ') || line === '+')) {
      files[current].push(line.slice(2));
      continue;
    }
    const server = /"distill"\s*:\s*\{[^}]*"command"\s*:\s*(\[[^\]]*\])/.exec(line);
    if (server !== null) {
      try {
        const parsed = JSON.parse(server[1]);
        if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) command = parsed;
      } catch {
        command = null;
      }
    }
    if (!line.startsWith('  ')) current = null;
  }
  const skillPath = Object.keys(files).find((path) => path.endsWith('SKILL.md'));
  return { skill: skillPath === undefined ? null : `${files[skillPath].join('\n')}\n`, command };
}

export function defaultExec(command, args, options) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INSTALL_TIMEOUT_MS, ...options });
}

export function failureDetail(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const detail = stderr !== '' ? stderr.split('\n').slice(-3).join(' | ') : error instanceof Error ? error.message.split('\n')[0] : String(error);
  return detail.slice(0, 400);
}

export function readSkill({ agentFlag, packageSpec, cwd, env, exec = defaultExec }) {
  const output = exec('npx', ['-y', packageSpec, 'agents', 'install', agentFlag, '--dry-run'], { cwd, env });
  return parseDryRun(output).skill;
}

export function skillPathIn(root) {
  return join(root, ...SKILL_FILE);
}
