import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '..');
const load = () => import(/* @vite-ignore */ pathToFileURL(join(repo, 'lib', 'launchd.mjs')).href);
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

describe.skipIf(process.platform === 'win32')('nightly.sh', () => {
  const script = read('nightly.sh');

  it('is valid bash and executable', () => {
    expect(spawnSync('bash', ['-n', join(repo, 'nightly.sh')]).status).toBe(0);
    expect(statSync(join(repo, 'nightly.sh')).mode & 0o111).not.toBe(0);
  });

  it('fetches, runs with resume and the budget, then reports, logging per date', () => {
    expect(script).toContain('node fetch.mjs');
    expect(script).toContain('node run.mjs --resume --scenario both --max-cost-usd "${DISTILL_BENCH_BUDGET:-15}"');
    expect(script).not.toContain('--tasks');
    expect(script).toContain('node report.mjs');
    expect(script).toContain('logs');
    expect(script).toContain('$(date +%F).log');
    expect(script.indexOf('fetch.mjs')).toBeLessThan(script.indexOf('run.mjs'));
    expect(script.indexOf('run.mjs')).toBeLessThan(script.indexOf('report.mjs'));
  });
});

describe('launchd plist', () => {
  it('renders every placeholder with escaped values', async () => {
    const { renderPlist, escapeXml } = await load();
    expect(escapeXml('a&b<c>"d\'')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const xml = renderPlist(read('launchd/dev.distill-bench.nightly.plist.template'), { SCRIPT: '/r/a&b/nightly.sh', ROOT: '/r/a&b', HOME: '/Users/x', LOG_DIR: '/Users/x/logs', CALENDAR_XML: '<key>Hour</key>', ENV_XML: '' });
    expect(xml).not.toMatch(/\{\{/);
    expect(xml).toContain('/r/a&amp;b/nightly.sh');
    expect(xml).toContain('<key>Label</key>\n  <string>dev.distill-bench.nightly</string>');
  });

  it('schedules 02:30 with RunAtLoad off and lints as a plist', async () => {
    const { plistFor, launchdPaths } = await load();
    const xml = plistFor(launchdPaths());
    expect(xml).toMatch(/<key>Hour<\/key>\s*<integer>2<\/integer>/);
    expect(xml).toMatch(/<key>Minute<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    const dir = mkdtempSync(join(tmpdir(), 'distill-bench-plist-'));
    try {
      const file = join(dir, 'x.plist');
      writeFileSync(file, xml);
      const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
      if (!lint.error) expect(lint.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the default plist daily at 02:30 with no weekday and no budget key', async () => {
    const { plistFor, launchdPaths } = await load();
    const xml = plistFor(launchdPaths());
    expect(xml).not.toContain('<key>Weekday</key>');
    expect(xml).not.toContain('DISTILL_BENCH_BUDGET');
    expect(xml).toContain('<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>2</integer>\n    <key>Minute</key>\n    <integer>30</integer>\n  </dict>');
    expect(xml).toContain('<key>HOME</key>');
    expect(plistFor(launchdPaths(), {})).toBe(xml);
  });

  it('renders weekday, hour, minute and budget', async () => {
    const { plistFor, launchdPaths } = await load();
    const xml = plistFor(launchdPaths(), { weekday: 0, hour: 3, minute: 5, budget: 12.5 });
    expect(xml).toMatch(/<key>Weekday<\/key>\s*<integer>0<\/integer>\s*<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>5<\/integer>/);
    expect(xml).toMatch(/<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*<key>DISTILL_BENCH_BUDGET<\/key>\s*<string>12.5<\/string>[\s\S]*<\/dict>/);
    expect(xml).not.toMatch(/\{\{/);
  });

  it('describes the schedule', async () => {
    const { describeSchedule } = await load();
    expect(describeSchedule({ hour: 2, minute: 30 })).toBe('every day at 02:30');
    expect(describeSchedule({ weekday: 0, hour: 3, minute: 0 })).toBe('every Sunday at 03:00');
  });

  it('parses the schedule flags with defaults', async () => {
    const { parseScheduleArgs } = await load();
    expect(parseScheduleArgs([]).options).toEqual({ hour: 2, minute: 30 });
    const { options, switches } = parseScheduleArgs(['--weekday', '0', '--hour=3', '--minute', '0', '--budget', '15', '--dry-run']);
    expect(options).toEqual({ weekday: 0, hour: 3, minute: 0, budget: 15 });
    expect(switches.has('dry-run')).toBe(true);
  });

  it.each([
    [['--weekday', '7']],
    [['--weekday', '-1']],
    [['--hour', '24']],
    [['--hour', 'x']],
    [['--minute', '60']],
    [['--minute', '1.5']],
    [['--budget', '0']],
    [['--budget', '-3']],
    [['--budget', 'abc']],
    [['--budget']],
    [['--nope', '1']],
  ])('rejects invalid flags %j', async (argv) => {
    const { parseScheduleArgs } = await load();
    expect(() => parseScheduleArgs(argv)).toThrow();
  });

  it('rejects a template with an unknown placeholder', async () => {
    const { renderPlist } = await load();
    expect(() => renderPlist('{{NOPE}}', {})).toThrow('Missing plist value NOPE');
  });
});

describe('install and uninstall scripts', () => {
  const run = (file: string, args: string[]) => spawnSync(process.execPath, [join(repo, file), ...args], { encoding: 'utf8', input: '' });

  it.each(['install-nightly.mjs', 'uninstall-nightly.mjs'])('%s dry run changes nothing and says what it would do', (file) => {
    const out = run(file, ['--dry-run']);
    if (process.platform !== 'darwin') {
      expect(out.status).toBe(1);
      return;
    }
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('This will:');
    expect(out.stdout).toContain('Dry run: nothing was changed.');
    expect(out.stdout).toContain('dev.distill-bench.nightly.plist');
  });

  it('install dry run prints the real schedule and budget', () => {
    if (process.platform !== 'darwin') return;
    const out = run('install-nightly.mjs', ['--dry-run', '--weekday', '0', '--hour', '3', '--minute', '0', '--budget', '15']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('every Sunday at 03:00');
    expect(out.stdout).toContain('up to $15 (DISTILL_BENCH_BUDGET in the plist)');
    const defaults = run('install-nightly.mjs', ['--dry-run']);
    expect(defaults.stdout).toContain('every day at 02:30');
    expect(defaults.stdout).toContain('up to $15 (the nightly.sh default');
  });

  it.each([['--weekday', '9'], ['--hour', '25'], ['--minute', '99'], ['--budget', '0'], ['--budget', 'free']])('install rejects %s %s with exit 1', (flag, value) => {
    const out = run('install-nightly.mjs', ['--dry-run', flag, value]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(flag);
    expect(out.stdout).not.toContain('This will:');
  });

  it.each(['install-nightly.mjs', 'uninstall-nightly.mjs'])('%s cancels without a terminal or --yes', (file) => {
    if (process.platform !== 'darwin') return;
    const out = run(file, []);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Cancelled, nothing was changed.');
  });
});

describe('package.json scripts', () => {
  const pkg = JSON.parse(read('package.json'));

  it('defines the bench scripts and runs from the repository root', () => {
    for (const name of ['bench', 'bench:fetch', 'bench:report', 'bench:install-nightly', 'bench:uninstall-nightly']) expect(pkg.scripts[name]).toMatch(/^node [a-z-]+\.mjs$/);
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('Apache-2.0');
  });
});
