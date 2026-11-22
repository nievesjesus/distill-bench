import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_TAGS } from './tasks.mjs';

export const ASR_SUBDIRS = ['asr', 'asr-models'];

export function taskNeedsAsr(task) {
  return (task.tags ?? []).some((tag) => MEDIA_TAGS.includes(tag));
}

export function asrModelsInstalled(asrDir) {
  try {
    return existsSync(join(asrDir, 'asr', 'node_modules')) && readdirSync(join(asrDir, 'asr-models')).length > 0;
  } catch {
    return false;
  }
}

export function linkSharedAsr(cacheDir, asrDir) {
  for (const name of ASR_SUBDIRS) {
    const shared = join(asrDir, name);
    mkdirSync(shared, { recursive: true });
    symlinkSync(shared, join(cacheDir, name), 'dir');
  }
}

export function asrWarning(asrDir) {
  return `Warning: speech models are not installed in ${asrDir}. Audio and video tasks will report asr_unavailable for the distill arm. Run "npm run bench:asr-install" once (about 700 MB).`;
}
