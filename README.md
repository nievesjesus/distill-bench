# distill-bench

A benchmark that asks Claude Code the same questions about the same real documents with and without [distill](https://github.com/nievesjesus/distill), and compares what it actually costs: total cost, tokens (including cache reads and writes), turns, time and whether the answer is right.

It exists because token-saving claims are easy to make and hard to trust. A rebuttal of one popular CLI proxy found a median cost increase of about 8% per task, and identical runs of the same task vary by about 22% in cost. So this benchmark repeats runs across nights, reports medians and spread, and reports the cases where distill loses.

## What it measures

- **Two arms.** `baseline` runs headless `claude -p` in a fresh temp folder that contains only the document. `distill` is the same, plus `--plugin-dir` pointing at the distill plugin. Both arms use the same prompt and the same flags (`--output-format stream-json --verbose --max-turns 30 --allowedTools Read,Grep,Glob,Bash --max-budget-usd 2`, stdin closed, 15 minute wall limit).
- **Two scenarios.**
  - `dev`: the agent keeps its normal tools, including any PDF command line tools on the machine. Agents often shell out to `pdftotext`, which never reaches distill.
  - `clean`: a per-run directory goes first on `PATH` with stubs for `pdftotext`, `pdfinfo`, `pdftoppm`, `pdfimages`, `pdftohtml`, `mutool`, `qpdf`, `gs` and `textutil` that print "command not found" and exit 127, and `PYTHONNOUSERSITE=1` hides `pip --user` packages. Nothing on your system is touched. Python libraries from the system interpreter's site-packages are not hidden; runs that use them are labelled `bash-python`.
- **Paths.** Each run is labelled with the paths it took: `read`, `read-pages`, `read-converted` (distill's hook rewrote the read), `mcp-distill`, `skill-distill` (`distill-llm convert` through Bash), `bash-pdftools`, `bash-python` and `bash-other`. The report shows the share of runs per path and the distill-used rate, because a "saving" in runs where distill never ran is noise.
- **Tasks.** `tasks.json` has about 43 questions over 20 public documents (US government reports, NIST publications, CC BY arXiv papers, Office files) tagged `simple`, `deep`, `table`, `table-reasoning`, `chart`, `office`, `multi` and `summary`. Every expected answer was checked against the original document with an independent extractor (`pdftotext`, unzipped XML) and carries a `source` (page and snippet). `corpus.json` lists the documents by URL and SHA-256 only; nothing is redistributed.
- **Statistics.** Medians with the interquartile range per arm. Paired comparison per task (distill cost / baseline cost, and the same for total input tokens), then the median ratio over tasks with a seeded bootstrap 95% confidence interval (2,000 resamples). Every table and every paired comparison is computed inside one scenario.

## Honesty rules

- Failures are recorded, retried once and counted. Nothing is dropped.
- The report always has a "where distill lost" table: tasks where distill cost more, or was wrong while the baseline was right.
- Wrong answers are wrong; no answer counts as not correct.
- Results are published as they come out, including when distill does not help.

## Run it

Requires Node 22.12 or newer and the `claude` CLI logged in. `pdftotext` and friends are optional and only matter for the `dev` scenario.

```bash
npm ci
npm run bench:fetch
npm run bench -- --scenario clean --tasks tag:simple --paired --repeats 1 --max-runs 4 --model haiku --max-cost-usd 1
npm run bench:report
```

**Cost warning.** Every run is a real headless Claude Code call billed to your login. The full task set with two arms and two scenarios can cost tens of dollars on `sonnet`. Use `--max-cost-usd`, `--max-runs`, `--tasks` and a cheaper `--model` to keep it small. A single run is capped by `--run-budget-usd` (default 2).

Useful options of `npm run bench`:

| option | meaning |
| --- | --- |
| `--arms baseline,distill` | which arms to run |
| `--scenario dev\|clean\|both` | `both` splits the budget evenly |
| `--tasks tag:deep,id:foo,doc:bar` | select tasks |
| `--repeats N` | repeats per task, arm and scenario |
| `--paired` | with `--max-runs`, select whole task groups with all arms so a capped run never leaves a task in one arm |
| `--model` | default `sonnet` |
| `--package <spec>` | the distill package: `distill-llm@latest` (default) or a path to a `.tgz` |
| `--distill-repo <path>` | a local distill checkout for the plugin. By default the tag `v<version of --package>` is shallow-cloned into `~/.cache/distill-bench/distill-<version>/` once |
| `--max-cost-usd`, `--max-runs`, `--resume`, `--results <dir>`, `--dry-run` | budget, caps, skip what tonight already did, results folder, print the plan |

Both arms run in a fresh temp folder with a fresh distill cache (`DISTILL_CACHE_DIR`, supported by distill releases that include it, which is newer than 0.7.0; with older packages the cache is not isolated). Both arms run with `--setting-sources project,local`, so the operator's user-level settings, plugins and hooks do not leak in; pass `--user-settings` to turn that isolation off. The distill arm also allows the plugin's MCP server (`mcp__plugin_distill_distill`), since headless mode refuses MCP calls that are not allowed.

## Where things go

Everything lives under `~/.cache/distill-bench/` (override with `DISTILL_BENCH_DIR`):

- `corpus/` downloaded documents, verified by SHA-256 (a mismatch is an error for that document only, 60 second timeout, 50 MB cap).
- `results/runs.jsonl` one JSON line per run, appended immediately, accumulating across nights.
- `results/bench-report.md` and `results/report.json` from `npm run bench:report` (`--results`, `--since YYYY-MM-DD`, `--model`, `--out`).
- `logs/` nightly logs.
- `distill-<version>/` shallow clones of the distill repo used for the plugin.

## Nightly job (macOS, opt in)

Nothing is scheduled automatically. By default the benchmark runs every night at 02:30:

```bash
npm run bench:install-nightly -- --dry-run   # print what it would do
npm run bench:install-nightly                # asks for confirmation first (use --yes to skip the prompt)
npm run bench:uninstall-nightly              # removes it, keeps results and logs
```

The schedule and the budget are configurable:

| Flag | Meaning | Default |
| --- | --- | --- |
| `--weekday <0-6>` | Day of the week, 0 is Sunday | every day |
| `--hour <0-23>` | Hour, local time | 2 |
| `--minute <0-59>` | Minute | 30 |
| `--budget <usd>` | Positive spend cap, written as `DISTILL_BENCH_BUDGET` in the plist | not written, `nightly.sh` uses 15 |

For example, a weekly run on Sundays at 03:00 with a 15 dollar budget:

```bash
npm run bench:install-nightly -- --weekday 0 --hour 3 --minute 0 --budget 15
```

Invalid values make the installer exit with an error before anything is changed.

It writes `~/Library/LaunchAgents/dev.distill-bench.nightly.plist` and loads it with `launchctl bootstrap`. Each night `nightly.sh` fetches the documents, runs `node run.mjs --resume --scenario both --max-cost-usd $DISTILL_BENCH_BUDGET` (default 15 dollars, split between the two scenarios) over every task, including the Office ones, and refreshes the report.

## Tests

```bash
npm test
```

The runner is tested end to end with a fake `claude` executable that prints stream-json; no real calls are made. The runner tests are skipped on Windows; the benchmark is a macOS tool and runs on Linux too.

## License

Apache-2.0, like distill.
