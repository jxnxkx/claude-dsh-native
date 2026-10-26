---
name: dsh-native
description: 由 Claude 做顶层规划、拆分和验收，把边界清楚的执行类子任务派给本机 DeepSeek Harness（dsh headless）执行。当用户说"派给 DeepSeek / 让 DeepSeek 做 / 交给 dsh / 用 DeepSeek 跑"，或要求 Claude 只负责规划、执行交给 DeepSeek 时使用。
---

# DeepSeek 派发（Claude 规划，DeepSeek 执行）

分工：Claude 理解需求、拆任务、写任务书、验收、整合；DeepSeek Harness 在指定目录里作为完整的 agent 执行一个边界清楚的子任务（自己读文件、改文件、跑命令）。DeepSeek 的回报只是报告，不是证据，每次都要自己验收。

## 前置

- 已全局安装 `dsh`：`npm install -g @deepseek-ai/dsh`（需要 Node 22.19+ 或 24+）。脚本从 PATH 或 `npm root -g` 找 dsh，也可以用环境变量 `DSH_BIN` 指向 `lib/bin.js`。
- 如果同时用 DeepSeek Harness Desktop，它和命令行版共用 `~/.dsh`，命令行版要和 Desktop 内置的版本一致。
- API Key：由用户自己配置（`DEEPSEEK_API_KEY` 环境变量、`.env`，或在配置里打开 `reuseSavedCredentials` 复用 Desktop/网页版保存的 Key）。Claude 不读取、不输出 Key。脚本输出里出现 Key 提示时，转告用户按 README 配置。
- 配置文件：`~/.dsh/dispatch-config.json`（`DS_DISPATCH_CONFIG` 可改路径）。模型、思考强度、默认权限、单价都在里面。
- DeepSeek 会读取项目里的 `AGENTS.md` / `CLAUDE.md`，项目约定写在那里两边都能看到。

## 派发一个任务

1. 按下面的模板写任务书，存到 scratchpad 或临时目录。
2. 运行（路径换成本 skill 实际所在的目录）：

   ```bash
   node ~/.claude/skills/dsh-native/ds-task.mjs --workdir "<项目目录>" --task-file "<任务书.md>"
   ```

   - Windows PowerShell 5.1 下如果中文输出乱码，先执行 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()`，或改用 Git Bash。
   - 可能超过 2 分钟的任务放到后台运行，跑完会收到通知，不要轮询。
   - **默认接续会话**：同一个 `--workdir` 的任务会接续这个项目的"当前会话"（记在 `~/.dsh/dispatch-sessions.json`）。DeepSeek 记得前面读过的文件和做过的事，历史部分走缓存。接续省下的主要是重新读文件、重新摸索项目的开销，所以优先接续，不要每次新开。
   - 什么时候新开（`--new-session`，新会话会成为当前会话）：换到和之前无关的工作；之前的会话把它带偏了；输出里出现"上下文超过阈值"的提示（阈值是配置里的 `contextWarnTokens`，默认 20 万 tokens；用户装了上下文折叠或回放插件时可能把它调高或关掉，没有提示就不用因为上下文长而新开）。
   - 并行任务：同一会话同一时间只能有一个进程写入。主线任务接续当前会话，其余并行任务加 `--one-off`（临时新开，不改当前会话）。
   - 接续指定会话：`--session-id <会话 id>`，`--workdir` 必须和那次相同，不会改动当前会话。
   - 接续失败（会话被界面或另一个任务占用、已不存在）时，脚本会自动新开并在输出的"注意"一行说明。出现这种情况时告诉用户，见下面"会话锁与界面"。
   - 接续时任务书可以省掉 DeepSeek 已经知道的背景，但范围和验收标准每次都要写。
   - 权限默认取配置里的 `permissionMode`（默认 `workspace-write`）。只读的调研、梳理类任务加 `--mode read-only`；需要完全访问时加 `--mode danger-full-access`，但要先得到用户同意（见"安全边界"）。
   - 一句话的小任务可以用 `--task "<文本>"` 代替 `--task-file`。
3. 脚本输出状态、会话 id（以及是接续还是新开）、本次用量和缓存命中率、费用估算、工具调用清单和 DeepSeek 的最终回答。每次派完都把用量和估算金额报给用户。
   - 费用估算按配置里的单价和高峰/闲时段，按任务开始时刻选价。只是估算，以 DeepSeek 开放平台账单为准。
   - 完整日志在 `~/.dsh/dispatch-logs/<时间戳>/`（`task.md`、`events.jsonl`、`answer.md`、`stderr.log`，以及本次用的 `patch.yml`）。退出码 0 表示完成，1 表示失败或中止，2 表示参数错误。

## 会话锁与界面

- 每个会话同一时间只能有一个写入方（dsh 的系统级锁）。Desktop 或网页版只要点开过某个会话，后台就一直占着它的锁：切到别的会话、关掉网页标签页都不释放；只有完全退出 Desktop（包括托盘图标），或停掉 `dsh web` 服务才释放。
- Desktop 不会实时显示别的进程写进来的内容，要完全退出再打开才看得到；网页版刷新页面就能看到。
- 被锁时任务会自动新开会话，照样完成，只是这一次没享受到接续。用户想在界面里看派发的会话，最好等这一批做完再打开；看过之后，下次派发前提醒用户退出 Desktop 或停掉 `dsh web`。
- 需要看某个会话的细节而它正被界面占用时，可以只读它的日志：`node session-usage.mjs <会话 id>` 输出该会话的累计用量，不受锁影响。

## 在 Desktop 里按项目显示

- Desktop 按工作区（文件夹）分组显示会话，名单在 `~/.dsh/storages/workspace.json`。只有 Desktop 或网页版自己建会话时才会写进名单，headless 不会，所以派发的会话默认出现在"未分组"里。
- 因此 `ds-task.mjs` 每次跑完都把会话记进 `~/.dsh/dispatch-pending-attach.json`（配置 `attachToWorkspaces` 可关）。用户想在 Desktop 里看时，让用户**先完全退出 Desktop 和 `dsh web`**，再用 `node open-desktop.mjs`（或它在 Windows 上生成的快捷方式）打开：它先把待登记的会话挂到对应文件夹的工作区（没有就新建），再启动 Desktop。
- Desktop 或 `dsh web` 正在运行时不能登记：它们把名单放在内存里，下次变动时整份写回文件，会冲掉外部的修改。这时启动器只提醒、不登记。不要在 Desktop 运行时手动改 `workspace.json`。登记前的备份是 `workspace.json.bak-attach`。

## 任务书模板

```markdown
# 任务：<一句话目标>

## 背景
<DeepSeek 需要知道、但从仓库里看不出来的信息。它没看过我们的对话。>

## 范围
- 只改：<文件/目录>
- 不要碰：<文件/目录>
- 允许/禁止：删除文件、git commit/push、安装依赖、联网

## 要求
<具体做什么；接口、风格、约束；可参考的现有文件>

## 验收标准
- <可检查的条件，例如：`pytest tests/test_x.py` 全部通过>

## 回报
完成后用简短列表说明：改了哪些文件、各做了什么、跑了哪些检查及结果、没完成或不确定的地方。
```

## 拆分与并行

- 可以派完整的功能或模块级任务，不用切得很碎；实现、调试、写测试、重构都可以交给它。
- 每个任务自洽：拿到任务书就能开工，不依赖其他子任务的中间结果。
- 改动文件互不重叠的任务可以并行派发（各自后台运行，除主线外加 `--one-off`）；改同一组文件的任务串行。
- 整体架构、跨任务的接口约定、涉及用户偏好的取舍，以及最终整合，由 Claude 负责。

## 验收（每次必做）

- 读回答，再看实际改动（`git diff`、打开文件），跑验收标准里的检查。
- 不合格就把具体问题发回去让它修（直接再派一次，默认就接续同一会话）；两轮还不行就自己改。
- 向用户汇报时，分清"DeepSeek 说它做了"和"我验证过"。

## 安全边界

- `workspace-write`（默认）：只能写工作目录，命令在沙箱里跑。代价是沙箱会拦截部分子进程（实测 Windows 上 `node --test` 报 `EPERM`），这时 DeepSeek 可能申请提权或换个方式绕过。遇到这种情况，由 Claude 自己在外面跑验收命令，或征得用户同意后改用完全访问。
- `danger-full-access`：DeepSeek 以用户身份运行，能读写整台机器、执行任何命令。只在用户明确同意时使用；任务书的"范围"一节要写清楚哪些能动、哪些不能动。
- `--workdir` 指向真实项目时，先确认工作区已提交或干净，方便回滚。
- 验收时除了看 `git diff`，也看一下 `events.jsonl` 里的工具调用，确认它没有动范围以外的东西。
- 任务书里不放密钥、密码和个人隐私数据。
