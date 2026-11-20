# Rudy

**在终端让 Codex 和 Claude Code 接力完成同一项任务。**

Rudy 是一个个人自托管的 Agent 编排工具。你可以把任务交给本机或另一台已配对的电脑，随时回来查看进度。Rudy 重启后可以继续跟进原任务，也可以换一个 Agent 在原工作区接手。代码改动、测试结果和审查意见都在终端查看，由你确认是否合并。

可直接[运行本机编排](#运行本机编排)、[复现双机演示](#双机演示)或[运行 pi 原型](#运行当前原型)。

## 一次任务，从委派到合并

在 Rudy 里输入：

> 让第二台电脑上的 Codex 修复这个仓库里偶发失败的测试，再让 Claude Code 审查。把改动和测试结果给我，我来决定是否合并。

```text
任务 #42 · 修复偶发失败的测试

执行设备   dev-box
修复       Codex 在独立 Git worktree 中开始执行
审查       Claude Code 等待修复完成

── Rudy 主机重启，重新打开任务 #42 ──

恢复       已接回 dev-box 上的 Codex
修复       完成 · 已保存 diff
验证       受影响的测试通过
审查       完成 · Claude Code 未发现阻塞项

待确认     在 dev-box 上将这次改动合并到 main？
你         查看 diff 和验证结果后，确认合并
结果       已合并到 dev-box 的 main
```

关闭终端后任务可以继续运行。主机重启时，Rudy 从 SQLite 读回任务记录，并核对执行端的状态。原执行仍在运行时就重新接入，已经结束时优先恢复原生会话。会话失效时，Rudy 用任务简报和最近保存的进展，在原 worktree 开新会话。

你也可以在修复途中把任务从 Codex 交给 Claude Code。Rudy 确认 Codex 已停止写入后，把已完成的改动、验证结果和待办事项交给 Claude Code。同一个任务 ID 和 worktree 会贯穿整个过程。远程设备断线且执行状态未知时，任务会显示为等待设备。

## 运行本机编排

需要 Node.js 24 和 Git。执行机器安装 Codex CLI 0.170.0 和 Claude Code 2.1.329，并分别用 `codex login status` 和 `claude auth status` 确认登录。仅做下方本机示例时，安装 Codex 即可。

在 Rudy 仓库根目录安装依赖。使用 `delegate` 时，在 Host 上复制 [.env.example](.env.example) 到 `.env` 并配置一个 pi 支持的模型及凭证。手写简报的 `submit` 只需要执行端的登录。

```sh
npm ci --ignore-scripts
DEMO="$(mktemp -d)"
mkdir "$DEMO/work"
printf '%s\n' "$DEMO"
npm run host -- --workspace "$DEMO/work" --data-dir "$DEMO/data" --port 0
```

另开终端，在 Rudy 仓库里将 `DEMO` 设成上面打印的目录，再提交一次真实 Codex 任务。CLI 返回 `taskId` 后退出，Host 继续运行。

```sh
export DEMO=/path/from/first/terminal
export RUDY_DATA_DIR="$DEMO/data"
npm run rudy -- submit --workspace "$DEMO/work" \
  --goal '新建 day1.txt，写入一行 RUDY-DAY-1' \
  --completion '读回文件确认内容，并在回复中报告结果'
npm run rudy -- list
```

把返回的 `taskId` 填入下面的命令。`tail` 重放已有事件并跟进到终态，可用 Ctrl+C 退出后继续。使用 `--after` 传入最后看到的 `seq`，从下一条事件开始。也可以在提交时加 `--follow`，或用 `stop` 显式停止任务。

```sh
TASK_ID=your-task-id
npm run rudy -- tail "$TASK_ID"
npm run rudy -- events "$TASK_ID" --after 2
npm run rudy -- show "$TASK_ID"
cat "$DEMO/work/day1.txt"
```

Host 默认监听 `127.0.0.1:4317`，客户端从私有连接文件读取端口。Host 支持 `--workspace`、`--data-dir`、`--port`、`--codex`，也可用 `RUDY_WORKSPACE`、`RUDY_DATA_DIR`、`RUDY_PORT`、`RUDY_CODEX`。默认存储目录为 `~/.rudy/orchestration`，应与任务工作区分开。Codex 使用本机登录状态和 Rudy 指定的权限配置，在 SQLite 中保存原生会话引用与限长结果预览。

重启 Host 时复用同一数据目录，从 `show` 和 `events` 取回结果和历史。执行端可执行文件缺失时，`show` 会显示 `failed` 和原因。修复安装后用 `resume` 在原任务上继续。旧执行状态仍不明确时，Rudy 会等待核对结果。

## 自然语言委派与上下文

```sh
npm run rudy -- delegate '让 Codex 检查可复现的测试问题并报告证据' --workspace "$DEMO/work"
```

用 `--workspace` 指定本地目录，或用 `--repository` 和 `--device` 选择远程目标。写入型串行组用 `--base main` 指定 Git 基线。Partner 按委派目标延续对话，参考相关任务状态，主机验证后返回任务 ID。再次使用同一目标时可引用上轮的约束。上下文过长时，先缩短本轮请求再试。摘要失败时本轮委派报错，原始消息和上一次有效摘要仍保留在 Host 数据目录中。

Codex 写任务沿用 `AGENTS.md` 和 `.agents/skills/*/SKILL.md`。Claude Code 写任务加载工作目录里的 `CLAUDE.md`，并通过原生插件加载器发现 `.claude/skills/*/SKILL.md`，沿用该目录的插件命名空间。两者均在执行机器的工作区加载，Git 任务应把这些文件纳入基线。Claude Code 仍使用 restricted 模式，关闭项目 hook 和 Skill 内嵌 shell 命令。含符号链接的 `.claude` 插件目录会跳过加载。审查任务沿用只读限制。

### 可选 Nowledge Mem

Host 加 `--memory` 才启用。先在 Host 安装并连接 `nmem`，用 `nmem status` 检查服务。

```sh
npm run rudy -- remember '文本格式变更须附带回归测试'
npm run rudy -- delegate '按先前决定处理这一项' --workspace "$DEMO/work" --recall '文本格式回归测试'
```

`remember` 只发送选定的决定，`--recall` 只发送指定的检索词。服务不可用或认证失败时，委派返回 `memoryStatus` 并使用本地记录继续。检索结果只作为背景资料，任务状态和合并权限仍由主机与用户决定。

## 双机演示

两台机器都从 Rudy 仓库根目录执行 `npm ci --ignore-scripts`。Host 配置 `.env`，Worker 登录两个 harness。示例使用同一个 Worker 完成修复、审查和合并。示例中的 Git 仓库独立于 Rudy。

### 1. 建立连接与可重复的失败

在 Host 终端启动主机。启动函数也用于后面的重启。

```sh
HOST_DEMO="$(mktemp -d)"
mkdir "$HOST_DEMO/work"
export RUDY_DATA_DIR="$HOST_DEMO/data"
start_host() {
  node --env-file-if-exists=.env src/client/host.ts \
    --workspace "$HOST_DEMO/work" --port 4317 --worker-port 4318 &
  HOST_PID=$!
}
start_host
# 等待 Host 打印 Worker endpoint 后再生成配对码
npm run -s rudy -- pair-code
```

在 Worker 的另一个终端执行 `ssh -N -L 4318:127.0.0.1:4318 USER@HOST` 并保持连接。在 Worker 的 Rudy 根目录创建演示仓库并配对。在提示时粘贴一次性配对码，回车后按 Ctrl+D。

```sh
WORKER_DEMO="$(mktemp -d "$HOME/rudy-demo.XXXXXXXX")"
export RUDY_DATA_DIR="$WORKER_DEMO/data"
REPO="$WORKER_DEMO/project"
git init -qb main "$REPO"
git -C "$REPO" config user.name 'Rudy Demo'
git -C "$REPO" config user.email demo@localhost
cat > "$REPO/normalize.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$1"
EOF
cat > "$REPO/test.sh" <<'EOF'
#!/bin/sh
actual=$(/bin/sh ./normalize.sh '  hello  ')
if [ "$actual" != "hello" ]; then
  printf 'expected <hello>, got <%s>\n' "$actual"
  exit 1
fi
EOF
printf '%s\n' 'Use /bin/sh test.sh to verify normalization.' > "$REPO/AGENTS.md"
cp "$REPO/AGENTS.md" "$REPO/CLAUDE.md"
mkdir -p "$REPO/.agents/skills/demo-check" "$REPO/.claude/skills/demo-check" "$REPO/.claude/.claude-plugin"
printf '%s\n' '{"name":"rudy-demo"}' > "$REPO/.claude/.claude-plugin/plugin.json"
cat > "$REPO/.agents/skills/demo-check/SKILL.md" <<'EOF'
---
name: demo-check
description: Use for normalization changes in the Rudy demo.
---
Include the label RUDY-NORMALIZATION in the handoff checkpoint.
EOF
cp "$REPO/.agents/skills/demo-check/SKILL.md" "$REPO/.claude/skills/demo-check/SKILL.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'fixture: reproduce whitespace regression'
(cd "$REPO" && /bin/sh test.sh) # 预期退出码 1
npm run -s rudy -- worker-pair ws://127.0.0.1:4318
npm run rudy -- worker --workspace "$WORKER_DEMO" --repo "demo=$REPO" --name demo-worker
```

### 2. 委派、重启与恢复

在 Host 用 `devices` 找到在线 Worker 的 `device` ID，填入 `DEVICE`。将返回的两个 `taskId` 分别填入 `FIX` 和 `REVIEW`。

```sh
npm run rudy -- devices
DEVICE=worker-device-id
npm run rudy -- delegate \
  '让 Codex 使用 demo-check Skill。先运行 /bin/sh test.sh 确认失败并报告 checkpoint，再执行 /bin/sleep 45 留出重启演示时间。之后修复 normalize.sh 去掉首尾空格，重新跑测试并记录退出码。修复完成后，让同一机器上的 Claude Code 只读审查 diff、测试证据和遗留问题。' \
  --repository demo --device "$DEVICE" --base main
npm run rudy -- show "$FIX"
npm run rudy -- show "$REVIEW"
```

在 `events "$FIX"` 看到 `/bin/sh test.sh` 的非零退出码后重启演示 Host。保留 Worker 和 SSH 隧道，重连后继续观察修复任务。

```sh
kill -KILL "$HOST_PID"
wait "$HOST_PID" || true
start_host
# 等待 Host 重新打印监听地址
npm run rudy -- tail "$FIX"
npm run rudy -- show "$FIX"
npm run rudy -- show "$REVIEW"
```

| 观察 | 判断依据与恢复动作 |
| --- | --- |
| 重启后等待设备或正在重连 | `show` 中的 `reason` 指出还在核对旧执行。保留隧道和 Worker，等设备重连并核对执行 ID。 |
| 仍在运行，或离线期间已结束 | `events` 中的 `execution.reconnected` 和后续事件沿用原执行 ID。分别继续 `tail` 或直接查看已回放的结果。 |
| 修复失败、缺少证据或设备状态未知 | 审查继续 `waiting`。用 `show` 查上游原因。设备不确定时先恢复原 Worker；确认旧执行结束后，失败的任务可用 `resume "$FIX"` 重试。 |

### 3. 检查结果并确认合并

等两个任务都 `succeeded`。用 `show "$FIX"` 核对 `evidence.diff`、测试的退出码和结果提交。用 `show "$REVIEW"` 核对 Claude Code 的审查意见和所审提交。把查看过的结果提交填入 `RESULT`，演示中未移动的 `main` 提交是修复任务的 `git.baseline`，填入 `TARGET_HEAD`。

```sh
npm run rudy -- merge "$FIX" --commit "$RESULT" --target main --target-head "$TARGET_HEAD"
npm run rudy -- events "$FIX"
```

看到 `task.merged` 后，在 Worker 的目标仓库运行 `(cd "$REPO" && /bin/sh test.sh)`，应返回 0。如果目标变脏或提交变化，合并会报错，结果分支仍可检查。恢复干净目标、核对当前提交和审查依据后再确认。

### 4. 演示同任务换手

在 Host 新建一个单任务，保存返回的 `taskId` 到 `HANDOFF`。等 Codex 成功并保有会话引用后交给 Claude Code，再切回 Codex。

```sh
npm run rudy -- submit --repository demo --device "$DEVICE" --base main --harness codex \
  --goal '用 demo-check 补一个内部空格应原样保留的测试，写 checkpoint' \
  --completion '执行 /bin/sh test.sh 并记录测试结果'
npm run rudy -- tail "$HANDOFF"
npm run rudy -- switch "$HANDOFF" --harness claude-code
npm run rudy -- tail "$HANDOFF"
npm run rudy -- switch "$HANDOFF" --harness codex
npm run rudy -- tail "$HANDOFF"
npm run rudy -- show "$HANDOFF"
```

核对任务 ID 和 worktree 一直相同，执行 ID 随换手变化。两次 Codex 执行应引用同一原生会话，Claude Code 使用自己的会话并能从 checkpoint 继续。要演示中途换手，在 `running` 时先用 `pause "$HANDOFF"`。等 `show` 显示 `paused` 再执行 `switch`。如果 `switch` 被拒绝，查看原因并等旧进程停止。原生会话不可用时，事件会说明从简报和 checkpoint 开新会话。

摘要和记忆故障可独立复现。运行 `node --test test/partner/delegation.test.ts`，用本地模型桩和模拟 `nmem` 验证摘要失败后原文仍在、记忆服务不可用时任务仍能成功。

## 运行当前原型

需要 Node.js 22.19 或更新版本。在仓库根目录运行：

```sh
npm ci --ignore-scripts
test -f .env || cp .env.example .env
```

按 [.env.example](.env.example) 配置模型。在默认 OpenAI 配置下，填写 `OPENAI_API_KEY`，然后启动：

```sh
npm start
```

可以试着输入「读一下 package.json，告诉我这个仓库怎么启动」。原型支持终端对话、工作区内的只读文件工具、JSONL 会话恢复和历史压缩。输入 `/resume` 查看当前工作区的历史会话，输入 `/exit` 退出。

其他配置见 [原型使用说明](https://github.com/LiuMingyang-1/rudy/blob/28c165df57a42f1d0c8cf8bce633a275e0950f36/README.md#启动)和 [会话压缩文档](docs/session-compaction.md)。本地开发检查使用 `npm run check` 和 `npm run test:unit`。

## 编排版设计

Partner 把自然语言请求拆成任务。Rudy 主机负责调度、保存任务状态和恢复执行。本机 Runner 或远程 Worker 调用 Codex 和 Claude Code，各自管理原生会话。完整的任务语义、故障处理、模块划分和验收标准见 [实施规格](docs/implementation-spec.md)。

## 参考与许可

Rudy 是独立的 TypeScript 应用，架构参考 [Ducter 0.0.80](https://github.com/wey-gu/ducter/tree/55ec5b309eef222f3dcc3fdaabd139e17f35efb1)。现有原型使用 [pi](https://github.com/earendil-works/pi)。本项目采用 [MIT 许可证](LICENSE)，保留原 pi 的版权声明。
