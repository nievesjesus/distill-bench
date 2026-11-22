import { asrDir } from './paths.mjs';

export function asrInstallCommand(argv, env = process.env) {
  let packageSpec = 'distill-llm@latest';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--package') {
      packageSpec = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--package=')) packageSpec = arg.slice('--package='.length);
    else throw new Error(`Unknown option ${arg}`);
    if (typeof packageSpec !== 'string' || packageSpec === '' || packageSpec.startsWith('--')) throw new Error('--package needs a value');
  }
  const dir = asrDir(env);
  return { command: 'npx', args: ['-y', packageSpec, 'asr', 'install'], dir, env: { ...env, DISTILL_CACHE_DIR: dir } };
}
