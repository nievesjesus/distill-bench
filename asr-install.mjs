import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { asrInstallCommand } from './lib/asr-install.mjs';

try {
  const plan = asrInstallCommand(process.argv.slice(2));
  mkdirSync(plan.dir, { recursive: true });
  console.log(`Installing speech models into ${plan.dir}`);
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', env: plan.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
