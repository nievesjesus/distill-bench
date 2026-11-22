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

Both arms run in a fresh temp folder with a fresh distill cache (`DISTILL_CACHE_DIR`, supported by distill releases that include it, which is newer than 0.7.0; with older packages the cache is not isolated). Both arms run with `--setting-sources project,local`, so the operator's user-level settings, plugins and hooks do not leak in; pass `--user-settings` to turn that isolation off. Claude runs also get `ENABLE_CLAUDEAI_MCP_SERVERS=false` (unless `--user-settings`): any run with an MCP server, the distill arm, would otherwise load the operator's claude.ai account connectors, which adds hundreds of tools, varies from run to run and defeats the prompt cache, so the distill arm looked about twice as expensive for reasons unrelated to distill. The distill arm also allows the plugin's MCP server (`mcp__plugin_distill_distill`), since headless mode refuses MCP calls that are not allowed.

## Codex

The same tasks, arms, scenarios, grading and report also run against the OpenAI Codex CLI. Pass `--agent codex` (default `claude`):

```bash
npm run bench -- --agent codex --scenario clean --tasks tag:simple --paired --repeats 1 --max-runs 4
npm run bench:report -- --agent codex
```

Each run is `codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check -s read-only [-m MODEL] -c ... "<prompt>"` with stdin closed, in a fresh folder with only the document. `--ignore-user-config` skips `~/.codex/config.toml` but keeps your login, so the operator's own config, MCP servers and plugins do not leak in (the Codex counterpart of `--setting-sources project,local`). Everything else is set per run with `-c` overrides; `~/.codex` is never written. The same 15 minute wall limit applies.

| option | meaning |
| --- | --- |
| `--agent claude\|codex` | which agent to run, default `claude` |
| `--codex-model <name>` | default: top-level `model` of `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`); if absent, `-m` is omitted |
| `--codex-reasoning low\|medium\|high` | default: top-level `model_reasoning_effort` of the same file; passed as `-c model_reasoning_effort="..."` |
| `--codex-bin <path>` | the `codex` executable, default `codex` on `PATH` (or `DISTILL_BENCH_CODEX`) |

The model and reasoning are recorded together as `model`, for example `gpt-6-astra/high`. `--model`, `--max-turns` and `--run-budget-usd` are Claude-only and ignored for Codex (Codex has no verified equivalent of `--max-turns`). `--user-settings` applies to both agents: for Codex it keeps the real `HOME`, so user skills come back.

**Cost and usage.** Codex prints no cost in USD, and with a ChatGPT login its usage counts against plan limits, not dollars. Records carry `costUsd: null` and the report shows `n/a` in every cost column; the comparison is on total input tokens, turns and duration. `--max-cost-usd` does not apply, so for `--agent codex` the runner caps the run with `--max-runs`, defaulting to 20 when you did not pass one, and prints a note.

**What the distill arm means for Codex.** Codex has no Read tool; it reads files through the shell, so distill's Read hook never applies. The distill arm only adds distill's MCP server (`mcp_servers.distill.*` overrides pointing at the plugin's `scripts/run.mjs mcp`, with `DISTILL_PLUGIN_PACKAGE`, `DISTILL_CACHE_DIR` and `CLAUDE_PLUGIN_ROOT` in the server's `env` table, because Codex sanitizes the MCP environment) and sets `default_tools_approval_mode="approve"` for it. The baseline arm has no MCP overrides at all. The `read`, `read-pages` and `read-converted` paths therefore never occur for Codex; shell reads show up as `bash-other` (or `bash-pdftools`, `bash-python`), MCP calls as `mcp-distill`, and an MCP call Codex refused for approval or permission as `mcp-denied`, so a refusal is never counted as use. A generic MCP failure counts as use.

**Skill isolation.** Codex ignores `--ignore-user-config` for user skills (it reads `~/.agents/skills`), so each Codex run gets its own `HOME` under the run directory with `CODEX_HOME` pinned to the real Codex home (auth keeps working) and the distill MCP server gets the real `HOME` and `PATH`; `--user-settings` keeps the real `HOME` for Codex too.

**Clean scenario caveat.** Codex runs shell commands through a login shell (`/bin/zsh -lc`), which can reset `PATH` and defeat the stubs. The runner passes `shell_environment_policy.inherit=all`, prepends the stub directory again through `shell_environment_policy.set`, and sets `allow_login_shell=false`, but the clean scenario is best effort for Codex. Check the `bash-pdftools` share in the clean section: a non-zero share there means the stubs were bypassed.

**Token mapping.** Codex reports `input_tokens` with `cached_input_tokens` as a subset of it. The record keeps the Claude definition (`input` excludes cache, total input tokens is `input + cacheCreation + cacheRead`):

| record field | Codex usage field |
| --- | --- |
| `input` | `input_tokens - cached_input_tokens - cache_write_input_tokens` |
| `output` | `output_tokens` (reasoning tokens are already inside it) |
| `cacheCreation` | `cache_write_input_tokens` |
| `cacheRead` | `cached_input_tokens` |

So total input tokens equals Codex's `input_tokens`. Usage from several `turn.completed` events is summed. `numTurns` is the number of shell and MCP tool calls plus one for the final answer, an approximation of model calls; Claude's `num_turns` is not the same measure, so compare turns within one agent only.

Records are tagged `agent: "claude"|"codex"|"opencode"` (older records without the field are Claude). Resume keys, the lock file (`.lock-codex` for Codex, `.lock` for Claude), the report sections and every paired comparison are per agent, so the two never mix. Running both agents at the same time on one machine works but perturbs durations.

## OpenCode

The same tasks, arms, scenarios, grading and report also run against OpenCode (v2.x). Pass `--agent opencode` and a model:

```bash
npm run bench -- --agent opencode --opencode-model openrouter/z-ai/glm-5.3 --scenario clean --tasks tag:simple --paired --repeats 1 --max-runs 4
npm run bench:report -- --agent opencode
```

Each run is `opencode run --standalone --auto --archived --format json -m <provider/model> "<prompt>"` with stdin closed and the working directory set to the run's project folder. `--standalone` uses a private server instead of your background service (which has your config loaded), `--auto` approves permissions and `--archived` keeps scripted sessions out of your session list.

| option | meaning |
| --- | --- |
| `--opencode-model <provider/model>` | required with `--agent opencode`; recorded as `model` |
| `--opencode-bin <path>` | the `opencode` executable, default `opencode` on `PATH` (or `DISTILL_BENCH_OPENCODE`) |

`--model`, `--max-turns` and `--run-budget-usd` are Claude-only and ignored.

**Isolation.** Your `~/.config/opencode` (MCP servers, plugins, skills, permissions) and `~/.agents/skills` would leak into both arms, so unless `--user-settings` is set each run gets `HOME=<run>/home` and `XDG_CONFIG_HOME=<run>/xdg-config`, both empty. `XDG_DATA_HOME` stays the real data home so your provider credentials (`auth.json`) keep working, `XDG_CACHE_HOME` stays real so OpenCode does not re-download its model catalogue and provider packages on every run, and `npm_config_cache` is the real `~/.npm` so `npx` does not re-download. `opencode debug config` with these variables lists no user config. Sessions are still written to the real OpenCode database, archived.

**The distill arm.** Before the agent starts, in the project folder and with the run environment, the runner does what distill's installer would do for a project:

1. `npx -y <package> hooks install --opencode --project --yes` writes `.opencode/plugins/distill.js`, the plugin that rewrites a `read` of a document to its converted Markdown.
2. `npx -y <package> agents install --opencode --project --dry-run` is parsed for the shared skill (`.agents/skills/distill-documents/SKILL.md`) and the MCP launch command. The real `agents install` is refused under `npx` (it only runs from a global install), and for OpenCode 2.x it only prints the MCP server as a manual step; the runner writes the skill and `opencode.jsonc` itself from that output.
3. `opencode.jsonc` registers the `distill` MCP server with `environment.DISTILL_CACHE_DIR` set to the run's cache folder. The plugin runs in OpenCode's process, so it inherits the same variable.

The baseline arm does none of this. A failed install is recorded as a run error (`error: "distill hook install failed: ..."`) and OpenCode is not started. distill's MCP tools appear as `distill_<tool>` (for example `distill_distill_search`) and count as `mcp-distill`; one OpenCode refused counts as `mcp-denied`. A `read` whose path or output points into the run's cache folder, or carries a `[distill]` marker, counts as `read-converted` (together with `read`).

**Cost and usage.** OpenCode reports the cost in USD per step from the provider; the record sums `cost` over all `step_finish` events, so `--max-cost-usd` and `--max-runs` work as for Claude (the budget is per agent and night, across OpenCode models). Usage maps as `input = tokens.input` (cache excluded), `output = tokens.output + tokens.reasoning`, `cacheRead = tokens.cache.read`, `cacheCreation = tokens.cache.write`, so total input tokens means the same as for Claude. `numTurns` is the number of `step_start` events. Any `error` event marks the run as failed.

**Models never mix.** The model id is part of the resume key, and the report has one section per OpenCode model, labelled for example `opencode · openrouter/z-ai/glm-5.3`, with its own paired comparison. The lock file is `.lock-opencode`.

## Where things go

Everything lives under `~/.cache/distill-bench/` (override with `DISTILL_BENCH_DIR`):

- `corpus/` downloaded documents, verified by SHA-256 (a mismatch is an error for that document only, 60 second timeout, 50 MB cap).
- `results/runs.jsonl` one JSON line per run, appended immediately, accumulating across nights.
- `results/bench-report.md` and `results/report.json` from `npm run bench:report` (`--results`, `--since YYYY-MM-DD`, `--model`, `--agent claude|codex|opencode`, `--out`).
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

The runner is tested end to end with fake `claude` and `codex` executables that print stream-json and JSONL; no real calls are made. The runner tests are skipped on Windows; the benchmark is a macOS tool and runs on Linux too.

## License

Apache-2.0, like distill.
