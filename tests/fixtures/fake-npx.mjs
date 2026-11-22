#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_CFG, 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(cfg.npxLog, `${JSON.stringify({ argv, cwd: process.cwd(), cacheDir: process.env.DISTILL_CACHE_DIR ?? null, home: process.env.HOME, npmCache: process.env.npm_config_cache ?? null })}\n`);

if (cfg.npxFail === argv[2]) {
  process.stderr.write('npm error network down\n');
  process.exit(1);
}
if (argv[2] === 'hooks') {
  mkdirSync(join(process.cwd(), '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(process.cwd(), '.opencode', 'plugins', 'distill.js'), '// fake distill plugin\n');
  process.stdout.write('Hook command: npx -y distill-llm@9.9.9\n');
} else if (argv[2] === 'agents') {
  const cwd = process.cwd();
  process.stdout.write(
    [
      'Command: npx -y distill-llm@9.9.9',
      '== OpenCode ==',
      'Manual step: OpenCode 2.x: add the server by hand',
      `File: ${cwd}/opencode.jsonc`,
      '  {',
      '    "mcp": {',
      '      "servers": {',
      '        "distill": { "type": "local", "command": ["/usr/bin/node","/cache/distill-llm/dist/cli.js","mcp"] }',
      '      }',
      '    }',
      '  }',
      `File: ${cwd}/.opencode/plugins/distill.js`,
      '+ import x from "y";',
      '+ ',
      '+ export default {};',
      '== shared skill (~/.agents/skills) ==',
      `File: ${cwd}/.agents/skills/distill-documents/SKILL.md`,
      '+ ---',
      '+ name: distill-documents',
      '+ ---',
      '+ ',
      '+ # Read documents as Markdown',
      '',
    ].join('\n'),
  );
}
