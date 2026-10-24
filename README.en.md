# claude-dsh-native

English | [中文](README.md)

> Claude plans, DeepSeek Harness executes — drives a real dsh agent (not just the API), with session reuse and cost estimates.

> **Unofficial project, not affiliated with DeepSeek.**

A Claude Code skill where **Claude plans, splits and reviews the work, and a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh --profile headless`) does it.**

Claude writes a task brief and hands it to dsh with `ds-task.mjs`. dsh runs as a full agent in the given directory: it reads files, edits code and runs commands. When it finishes, the script summarizes the status, the tool calls, DeepSeek's answer, and this run's token usage, cache hit rate and estimated cost; then Claude reviews the result.

```
=== DeepSeek task result ===
Status: completed (exit 0, 11s) - completed
Session: session-… (resumed)
Usage: 1 requests, input 9571 tokens (cache hit 9344, 98%), output 5; context now ~9571 tokens
Cost estimate: ~CNY 0.0004 (off-peak rate, Asia/Shanghai 10-24 17:57; hit 0.0002 + miss 0.0002 + output 0.0000; prices checked 2026-10-24, your bill is authoritative)
Workdir: … (permission workspace-write)
Logs: ~/.dsh/dispatch-logs/20261024-175737-d78c38
Tool calls: 0
--- DeepSeek's answer ---
…
```

Output is in Chinese by default; set `"lang": "en"` in the config for English.

## How this differs from API-based delegation tools

Tools such as [handoff](https://github.com/dazuiba/handoff) and [claude-delegator-deepseek-mcp](https://github.com/fjgbue/claude-delegator-deepseek-mcp) send a prompt to the DeepSeek API and get text back; reading files, editing and running commands is still Claude's job.

Here the executor is DeepSeek Harness itself, a complete agent:

- it reads and edits files, runs commands and tests on its own; Claude only looks at the result and the diff;
- it has sessions: later tasks for the same project continue the same dsh session, so DeepSeek remembers what it already read and did, and the history is served from DeepSeek's context cache;
- it has dsh's own permission modes and sandbox (`read-only` / `workspace-write` / `danger-full-access`);
- it reads the project's `AGENTS.md` / `CLAUDE.md`, so project conventions are shared;
- sessions can be inspected in DeepSeek Harness Desktop or the web UI.

The cost: dsh must be installed locally, and it is still a developer preview whose interfaces may change.

## Features

- **Per-project session continuation**: remembers a "current session" per `--workdir` and continues it by default. Also `--new-session` (start one and make it current), `--one-off` (start one without touching the current session, for parallel tasks) and `--session-id` (continue a specific session).
- **Automatic fallback when a session is locked**: dsh allows one writer per session. If resuming fails with `already owned by an active write handle`, the task runs in a new session and the current session stays unchanged; if the session no longer exists, the new one becomes current.
- **Usage and cost estimate**: reads this run's requests and input / cache-hit / output tokens from the dsh session log and prices them with the configured peak/off-peak rates.
- **Encoding-safe**: the task text goes to dsh's stdin as raw UTF-8 bytes and the `--json` event stream is written to disk untouched, with no shell re-encoding.
- **Cross-platform**: plain Node, no dependencies; Windows, macOS and Linux. dsh is located via PATH or `npm root -g`.
- **Logs**: every run writes `~/.dsh/dispatch-logs/<timestamp>/` with `task.md`, `events.jsonl`, `answer.md`, `stderr.log` and `patch.yml`.

## Install

Requirements: Node 22.19+ or 24+, and [Claude Code](https://claude.com/claude-code).

```bash
npm install -g @deepseek-ai/dsh
git clone https://github.com/jxnxkx/claude-dsh-native.git
cd claude-dsh-native
node scripts/install.mjs
```

`install.mjs` copies `skill/dsh-native/` to `~/.claude/skills/dsh-native/` (**overwriting a directory of the same name**) and creates a default `~/.dsh/dispatch-config.json` if there is none. To install into one project only: `node scripts/install.mjs <project>/.claude/skills`.

Then ask Claude Code to "dispatch this to DeepSeek". You can also run it by hand:

```bash
node ~/.claude/skills/dsh-native/ds-task.mjs --workdir ./my-project --task "Run the tests and fix the failures"
```

See `--help` for all options.

## API key

**Since dsh 0.2.1, the headless profile no longer reads the credentials saved by Desktop/web** (`~/.dsh/.credentials.yaml`); it reads environment variables and `.env` only. Pick one:

1. Set `DEEPSEEK_API_KEY` in the environment that launches Claude Code.
2. Put `DEEPSEEK_API_KEY=...` in a `.env` file: dsh reads `~/.dsh/.env` (recommended, it never travels with a repository) and `.env` in the working directory (add it to `.gitignore` if you use this one).
3. Reuse the key saved by Desktop/web: set `"reuseSavedCredentials": true` in the config, and each run's patch re-enables the `credentials`, `authorization` and `deepseek-account` plugins. Or add this to `~/.dsh/profiles/headless/cordis.patch.yml` yourself:

   ```yaml
   - id: credentials
     disabled: false
   - id: authorization
     disabled: false
   - id: deepseek-account
     disabled: false
   ```

If no key is found, the output says so. The script never reads or prints the key.

## Config

`~/.dsh/dispatch-config.json` (or the path in `DS_DISPATCH_CONFIG`); see [`dispatch-config.example.json`](skill/dsh-native/dispatch-config.example.json). Missing fields fall back to defaults.

| Field | Default | Meaning |
| --- | --- | --- |
| `lang` | `zh` | Output language, `zh` or `en` |
| `permissionMode` | `workspace-write` | Default permission; `--mode` overrides it per run |
| `agent` | `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}` | Written into each run's `--patch` and **replaces** the headless profile's `agent-default-model` config. Thinking effort: `off / low / high / max`. `null` keeps the profile as it is |
| `reuseSavedCredentials` | `false` | See above |
| `maxToolLines` | `40` | Tool calls listed in the summary |
| `pricing` | see example | Prices (CNY per 1M tokens, `peak` / `offPeak`, each with `cacheHit` / `cacheMiss` / `output`), `timeZone`, `peakDays`, `peakHours`, `holidays`, `checked` |

Default prices follow the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) as of 2026-10-24: off-peak cache hit 0.02, cache miss 1, output 4; doubled at peak (weekdays 09–12 and 14–18 Beijing time). When prices change, edit the config only.

## Permissions: workspace-write or danger-full-access

| | `workspace-write` (default) | `danger-full-access` |
| --- | --- | --- |
| Writes | the working directory only | the whole machine, as your user |
| Commands | sandboxed | unrestricted |
| Catch | the sandbox blocks some child processes. On Windows, `node --test` failed with `EPERM` in our tests; DeepSeek then asks for elevation and, if refused, may try another way around | no safety net: mistakes cost the same as if you typed the commands |
| Use when | by default; Claude runs the acceptance checks outside | tests or installs are really needed, the tree is committed and the brief states the scope |

Use `--mode read-only` for research-only tasks.

## Session locks and the GUI (observed)

- One writer per session at a time. **Once Desktop or the web UI has opened a session, it keeps that session's write lock**: switching to another session or closing the browser tab does not release it; only quitting Desktop or stopping the web server does. Dispatches then fall back to a new session (the task still completes, just without continuation).
- **Desktop does not refresh live** when another process writes to the same session; restart it to see the new turns. The web UI shows them after a page reload.
- Tip: while Claude is dispatching, don't open that project's current session in the GUI. Look after the batch is done, then quit before the next dispatch.

## Observed effect

In a small directory, the first (new-session) task read a file and answered: 3 requests, ~28k input tokens (86% cache hit, because the system prompt itself is cached). A follow-up that continued the same session took 1 request with a 98% cache hit and did not re-read the file.

## Limits of the cost estimate

- It is an estimate; the DeepSeek platform bill is authoritative.
- Public holidays are off-peak, but you must list them in `holidays`; make-up working days are judged by weekday only.
- The whole run is priced by the period its **start time** falls in; long runs crossing a peak/off-peak boundary are off.
- Only model requests recorded in the dsh session log are counted; auxiliary requests such as dsh generating a session title are not.
- If another process is writing to the same session at the same time (e.g. queued behind the lock), this run's difference may include its requests.

## Tested versions

- `@deepseek-ai/dsh` 0.2.1-rc.3 (CLI and Desktop on the same version), model `deepseek-flash` (DeepSeek-V4.1-Flash-1017)
- Node 24.15, Windows 10 (PowerShell 5.1 and Git Bash)

dsh is a developer preview; its event format, profile plugin ids and session log format may change. Session logs are zstd-compressed and need the built-in zstd support of Node 22.15+ / 23.8+.

## Development

```bash
node --test
```

## License

[MIT](LICENSE). Not affiliated with DeepSeek or Anthropic.
