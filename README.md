# claude-dsh-native

[English](README.en.md) | 中文

> Claude 规划，DeepSeek Harness 执行：原生驱动真正的 dsh 智能体，而不只是调 API，支持会话接续和费用估算。

> **非官方项目，与 DeepSeek 无关。**

一个 Claude Code skill：**Claude 负责规划、拆分和验收，本机的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh --profile headless`）负责执行。**

Claude 把任务写成任务书，用 `ds-task.mjs` 交给 dsh；dsh 作为一个完整的 agent 在指定目录里读文件、改代码、跑命令，做完后脚本汇总状态、工具调用、DeepSeek 的回答，以及本次的 token 用量、缓存命中率和费用估算，Claude 再去验收。

```
=== DeepSeek 任务结果 ===
状态：完成（exit 0，用时 11s）— completed
会话：session-…（接续）
本次用量：1 次请求，输入 9571 tokens（缓存命中 9344，98%），输出 5；当前上下文约 9571 tokens
费用估算：约 ¥0.0004（闲时价，北京时间 10-24 17:57；命中 ¥0.0002 + 未命中 ¥0.0002 + 输出 ¥0.0000；单价核对于 2026-10-24，以账单为准）
目录：…（权限 workspace-write）
日志：~/.dsh/dispatch-logs/20261024-175737-d78c38
工具调用：0 次
--- DeepSeek 的回答 ---
…
```

## 和直接调 API 的委派工具有什么不同

[handoff](https://github.com/dazuiba/handoff)、[claude-delegator-deepseek-mcp](https://github.com/fjgbue/claude-delegator-deepseek-mcp) 这类工具把一段提示词发给 DeepSeek API，拿回一段文本，读文件、改文件、跑命令还是 Claude 自己来。

这里的执行端是 DeepSeek Harness 本身，是一个完整的 agent：

- 自己读文件、改文件、执行命令、跑测试，Claude 只看结果和 diff；
- 有会话：同一个项目的后续任务接续同一个 dsh 会话，DeepSeek 记得已经读过的文件和做过的事，不用重读，历史部分走 DeepSeek 的上下文缓存；
- 有 dsh 自己的权限模式和沙箱（`read-only` / `workspace-write` / `danger-full-access`）；
- 会读取项目里的 `AGENTS.md` / `CLAUDE.md`，项目约定两边共用；
- 会话也能在 DeepSeek Harness Desktop 或网页版里查看。

代价是要在本机装 dsh，而且 dsh 还是开发者预览版，接口可能变化。

## 功能

- **按项目接续会话**：按 `--workdir` 记住每个项目的"当前会话"，默认接续；也支持 `--new-session`（新开并设为当前）、`--one-off`（临时新开，不改当前会话，适合并行任务）、`--session-id`（接续指定会话）。
- **会话被锁时自动新开**：dsh 每个会话同一时间只允许一个写入方。接续时如果报 `already owned by an active write handle`，自动改为新开一次，当前会话保持不变；会话已不存在时新开并设为当前会话。
- **用量和费用估算**：从 dsh 会话日志里读出本次的请求数、输入/缓存命中/输出 tokens，按配置的单价和高峰/闲时段估算人民币费用。
- **编码安全**：任务文本按原始 UTF-8 字节写进 dsh 的 stdin，事件流（`--json`）原样落盘，不经过 shell 的编码转换。
- **跨平台**：纯 Node，无依赖，Windows / macOS / Linux 通用。dsh 的位置从 PATH 或 `npm root -g` 自动查找；运行脚本的 Node 低于 22.19 时，自动改用 PATH 或 Homebrew 里更新的 Node 去跑 dsh（见下文 macOS 一节）。
- **在 Desktop 里按项目显示**：派发的会话会排队登记，用 `open-desktop.mjs` 打开 Desktop 时自动挂到对应文件夹的工作区，不再全部堆在"未分组"里。见下文。
- **日志**：每次运行写到 `~/.dsh/dispatch-logs/<时间戳>/`：`task.md`、`events.jsonl`、`answer.md`、`stderr.log`、`patch.yml`。

## 安装

前提：Node 22.19+ 或 24+，已安装 [Claude Code](https://claude.com/claude-code)。

```bash
npm install -g @deepseek-ai/dsh
git clone https://github.com/jxnxkx/claude-dsh-native.git
cd claude-dsh-native
node scripts/install.mjs
```

`install.mjs` 把 `skill/dsh-native/` 复制到 `~/.claude/skills/dsh-native/`（**会覆盖同名目录**），并在 `~/.dsh/dispatch-config.json` 不存在时创建一份默认配置。只想装到某个项目里：`node scripts/install.mjs <项目>/.claude/skills`。

装好后在 Claude Code 里说"把这个任务派给 DeepSeek"之类的话即可。也可以直接手动运行：

```bash
node ~/.claude/skills/dsh-native/ds-task.mjs --workdir ./my-project --task "跑一下测试，修好失败的用例"
```

完整参数见 `--help`。

### macOS

实测环境：macOS 26（Apple Silicon，APFS 默认不区分大小写）。

```bash
brew install node@24                      # keg-only，不会自动加进 PATH
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # 想让终端默认用它，可写进 ~/.zprofile
npm install -g @deepseek-ai/dsh
git clone https://github.com/jxnxkx/claude-dsh-native.git
cd claude-dsh-native
node scripts/install.mjs
node ~/.claude/skills/dsh-native/open-desktop.mjs --create-shortcut
```

- **Node 版本**：dsh 在 Node 22.19 以下会**不输出任何内容、直接 exit 0**。如果 PATH 里更早出现的是旧 Node（比如官方安装包放在 `/usr/local/bin` 的 22.16，排在 Homebrew 前面），Claude Code 运行 `node ds-task.mjs` 时用的就是它。脚本会自动换用 `DSH_NODE` 环境变量、配置里的 `nodePath`，或者 PATH / `/opt/homebrew/opt/node@24/bin/node` 等常见位置里 22.19 以上的 Node 去跑 dsh（优先选 Homebrew 的 `opt/` 稳定链接，`brew upgrade` 后不会失效）；都找不到时报错，不会假装成功。
- **启动入口**：`--create-shortcut` 在 `~/Applications` 生成「DeepSeek Harness（含派发会话）.app」（用 `osacompile` 生成的小程序，图标借用 Desktop 的），可以从启动台、Spotlight 打开，或拖进 Dock。`--shortcut-dir ~/Desktop` 可以改放到桌面。它记录的是生成时的 Node 和脚本绝对路径，挪动 skill 目录后重新生成一次即可。
- **完全退出 Desktop**：关窗口（红色按钮）后 Desktop 的所有进程（主进程、内置的 dsh 后端、Electron 辅助进程）都还在，仍然占着会话锁，也会覆盖 `workspace.json`。要用 ⌘Q，或在 Dock 图标上右键选"退出"。实测没有菜单栏图标。启动器把可执行文件位于 `/Applications/DeepSeek Harness.app/Contents/` 下的任何进程都算作"在运行"；Desktop 内置后端监听的是随机端口，不是 `webPort`。
- **提醒**：启动器从 .app 打开时没有终端窗口，提示用 `osascript display dialog` 弹出（20 秒后自动关闭）。
- **路径大小写**：`--workdir` 写成 `~/project/myproj` 还是 `~/Project/MyProj` 都一样。脚本用 `fs.realpathSync.native` 取磁盘上的真实大小写（和 dsh 自己登记工作区用的 `fs.realpath` 一致），接续会话和挂工作区都按它匹配，不会因为大小写不同而重复新建。

## 配置 API Key

**dsh 0.2.1 起，headless 默认不读取 Desktop/网页版保存的凭据**（`~/.dsh/.credentials.yaml`），只读环境变量和 `.env`。三选一：

1. 设置环境变量 `DEEPSEEK_API_KEY`（启动 Claude Code 的那个环境里）。
2. 写进 `.env`：dsh 会读 `~/.dsh/.env`（推荐，不会跟着仓库走）和工作目录下的 `.env`（放这里的话记得加进 `.gitignore`），内容为 `DEEPSEEK_API_KEY=...`。
3. 复用 Desktop/网页版保存的 Key：在配置里设 `"reuseSavedCredentials": true`，脚本会在每次运行的 patch 里重新启用 `credentials`、`authorization`、`deepseek-account` 三个插件。也可以自己写进 `~/.dsh/profiles/headless/cordis.patch.yml`：

   ```yaml
   - id: credentials
     disabled: false
   - id: authorization
     disabled: false
   - id: deepseek-account
     disabled: false
   ```

**Desktop 用 DeepSeek 账号登录、没有填 API Key 时**（凭据文件里只有账号授权，没有 `DEEPSEEK_API_KEY`），前三种都拿不到 Key。这时把配置里的 `agent.provider` 改成 `deepseek-account`（和 Desktop 自己用的一样），并打开 `reuseSavedCredentials`，headless 就会复用 Desktop 的登录。计费走账号，费用估算仍按配置里的 API 单价，可能和实际扣费不一致。

没配好时，输出里会有一行提示。脚本本身从不读取或打印 Key。

## 配置文件

`~/.dsh/dispatch-config.json`（或环境变量 `DS_DISPATCH_CONFIG` 指定的路径），样例见 [`dispatch-config.example.json`](skill/dsh-native/dispatch-config.example.json)。没写的字段用默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `lang` | `zh` | 输出语言，`zh` 或 `en` |
| `permissionMode` | `workspace-write` | 默认权限，`--mode` 可临时覆盖 |
| `agent` | `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}` | 写进每次运行的 `--patch`，**整体替换** headless profile 里 `agent-default-model` 的配置；思考强度可选 `off / low / high / max`。设为 `null` 则完全沿用 profile |
| `reuseSavedCredentials` | `false` | 见上一节 |
| `maxToolLines` | `40` | 汇总里列出的工具调用条数 |
| `contextWarnTokens` | `200000` | 当前上下文超过这个值时，输出里提示可以 `--new-session`。装了上下文折叠或回放插件的话，可以调高，或设为 `0` 关掉 |
| `attachToWorkspaces` | `true` | 把派发的会话记进待登记队列，供 `open-desktop.mjs` 挂到 Desktop 的工作区 |
| `nodePath` | `null` | 用来跑 dsh 的 Node（需 22.19+）。`null` 时：运行脚本的 Node 够新就用它，否则从 PATH 和常见安装位置找。环境变量 `DSH_NODE` 优先 |
| `desktop` | 见下文 | `path`（Desktop 程序位置）、`processName`（用来判断它是否在运行；macOS 上默认留空，按 .app 包路径判断）、`webPort`（`dsh web` 的端口，默认 3080）。值为 `null` 时用平台默认 |
| `pricing` | 见样例 | 单价（人民币/百万 tokens，分 `peak` / `offPeak`，各含 `cacheHit` / `cacheMiss` / `output`）、`timeZone`、`peakDays`、`peakHours`、`holidays`、`checked`（核对日期） |

默认单价按 2026-10-24 的[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：闲时 命中 0.02、未命中 1、输出 4；高峰（北京时间工作日 9–12 点、14–18 点）翻倍。价格变了只改配置文件。

## 权限：workspace-write 还是 danger-full-access

| | `workspace-write`（默认） | `danger-full-access` |
| --- | --- | --- |
| 能写哪里 | 只有工作目录 | 整台机器（以你的用户身份） |
| 命令 | 在沙箱里跑 | 不受限 |
| 问题 | 沙箱会拦截部分子进程。实测在 Windows 上 `node --test` 报 `EPERM`；DeepSeek 碰到这种情况会申请提权，被拒后可能换个方式绕过去 | 没有兜底，误操作的后果和你自己敲命令一样 |
| 适合 | 默认情况；验收命令由 Claude 在外面跑 | 确实需要跑测试、装依赖，且工作区已提交、任务书写清了范围 |

只读调研类任务可以用 `--mode read-only`。

## 会话锁和 GUI（实测结论）

- 每个会话同一时间只能有一个写入方。**Desktop 或网页版只要点开过某个会话，就一直占着它的写入锁**：切到别的会话、关掉网页标签页都不释放，只有完全退出 Desktop（包括托盘图标）或停掉 `dsh web` 服务才释放。这时派发会自动新开会话（任务照样完成，只是这次没有接续）。
- macOS 实测：只是点开会话不一定马上占锁，在会话里发过消息后就一直占着（持有者是 Desktop 内置的 dsh 后端进程），⌘Q 后释放。锁用的是 `flock(2)`，dsh 自带 darwin-arm64 的原生插件，不用另外装。
- **Desktop 不会实时刷新**别的进程写进同一会话的内容，要退出重开才看得到；网页版刷新页面就能看到。
- 建议：让 Claude 连续派发时，不要在 GUI 里点开那个项目的当前会话；想看过程，等一批任务做完再打开，看完后退出，下次派发前再接续。

## 在 Desktop 里按项目显示派发的会话

Desktop 按工作区（文件夹）分组显示会话，名单存在 `~/.dsh/storages/workspace.json`。只有 Desktop 或网页版自己建会话时，才会把会话写进名单；headless 不会，所以派发的会话默认都在"未分组"里。把 dsh 的工作区插件加进 headless profile 也没用（实测：插件只提供接口，不会自动登记）。

本项目的做法：

1. `ds-task.mjs` 每次跑完，把 `{sessionId, workDir}` 追加到 `~/.dsh/dispatch-pending-attach.json`。
2. **先完全退出 Desktop（Windows 包括托盘图标；macOS 要 ⌘Q，关窗不算），并停掉 `dsh web`**，然后运行：

   ```bash
   node ~/.claude/skills/dsh-native/open-desktop.mjs
   ```

   它按规范化后的路径找到对应的工作区（两边都取 `realpath`，所以大小写写法不同、经过软链接的路径都能匹配；Windows 上另外不区分大小写），把会话插到最前面；文件夹还没有工作区就新建一个（标题取文件夹名，排在最前）；已经在某个工作区里的会话跳过。写入前先备份为 `workspace.json.bak-attach`，再用临时文件加重命名的方式原子写入，保留原文件的权限（dsh 在 macOS/Linux 上把它设为仅本人可读写）。最后启动 Desktop。

   - `--dry-run`：只报告有几个待登记、Desktop/网页版是否在运行、会启动哪个程序，不做任何改动。
   - `--no-launch`：只登记，不启动。
   - `--create-shortcut`：Windows 在桌面和开始菜单生成"DeepSeek Harness（含派发会话）"快捷方式；macOS 在 `~/Applications` 生成同名 .app（见上文 macOS 一节）。以后从这里打开即可。

为什么必须先退出：Desktop 和 `dsh web` 运行时把名单放在内存里，下次变动时整份写回文件，也不监听外部修改，所以这时改了也会被冲掉。启动器检测到它们在运行时（按进程名或 macOS 的 .app 包路径，以及 `webPort` 端口判断）只提醒，不登记，照常启动 Desktop。日志在 `~/.dsh/dispatch-logs/open-desktop.log`。

也可以只登记、不启动，直接运行 `node ~/.claude/skills/dsh-native/attach-workspaces.mjs`。它做同样的检查：Desktop 或 `dsh web` 在运行时拒绝登记（退出码 3），待登记列表和 `workspace.json` 都不动。

- `-h` / `--help`：只打印用法。不认识的参数会报错退出（退出码 2），不会登记。
- `--dry-run`：输出会登记哪些会话、新建哪些工作区，以及现在被谁挡住（`blockedBy`），不写任何文件。
- `--force`：跳过运行检查，强制登记。**有风险**：如果 Desktop 或 `dsh web` 其实在运行，它下次改动名单时会用内存里的旧名单整份覆盖 `workspace.json`，这次登记就丢了；而待登记列表已经清空，这些会话不会再自动重登记，只能手动把它们加回 `~/.dsh/dispatch-pending-attach.json`。只在确认检测误报时使用，比如改了 `webPort` 而端口被别的程序占用。

Desktop 的位置默认是：Windows `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`，macOS `/Applications/DeepSeek Harness.app`；Linux 没有默认值，需要在配置的 `desktop.path` 里填。Windows 和 macOS 上都实测过：退出 Desktop 后用启动器打开，新建的工作区和挂进去的会话都正常显示。Linux 的默认值未经验证，请在配置里填。

## 实测效果

在一个小目录里：第一次新开会话读文件并回答，3 次请求，输入约 2.8 万 tokens（系统提示词本身就能命中缓存，命中 86%）；接着追问时接续同一会话，1 次请求，命中 98%，没有再读文件。

## 费用估算的局限

- 只是估算，以 DeepSeek 开放平台账单为准。
- 法定节假日按闲时价，需要你自己在 `holidays` 里填日期；调休上班日只按星期几判断，不会自动识别。
- 整次运行按**开始时刻**所在时段计价，跨越高峰/闲时边界的长任务会有偏差。
- 只统计 dsh 会话日志里记录的模型请求；dsh 生成会话标题等辅助请求不计入。
- 如果另一个进程正在往同一会话写入（例如排队等锁），本次的差值可能混进它的请求。

## 已测试的版本

- `@deepseek-ai/dsh` 0.2.1-rc.3（命令行版与 Desktop 同版本），模型 `deepseek-flash`（DeepSeek-V4.1-Flash-1017）
- Node 24.15，Windows 10（PowerShell 5.1 与 Git Bash）
- Node 24.22.1（Homebrew `node@24`）和 22.16（只运行脚本，dsh 自动改用 24），macOS 26.5（Apple Silicon，APFS 不区分大小写），Desktop 0.2.1-rc.3（`com.deepseek.dsh`），账号登录（`deepseek-account`）
  - 实测：新开、接续（`--workdir` 大小写不同）、两个进程抢同一会话、Desktop 占用会话时自动新开；退出 Desktop 后用启动入口登记并打开，会话出现在对应工作区下

dsh 是开发者预览版，事件格式、profile 插件 id、会话日志格式都可能在后续版本变化。会话日志是 zstd 压缩的，读取需要 Node 22.15+ / 23.8+ 自带的 zstd 支持。

## 开发

```bash
node --test
```

## 许可证

[MIT](LICENSE)。本项目与 DeepSeek、Anthropic 无关。
