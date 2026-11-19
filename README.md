# Rudy

**在终端让 Codex 和 Claude Code 接力完成同一项任务。**

Rudy 是一个个人自托管的 Agent 编排工具。你可以把任务交给本机或另一台已配对的电脑，随时回来查看进度。Rudy 重启后可以继续跟进原任务，也可以换一个 Agent 在原工作区接手。代码改动、测试结果和审查意见都在终端查看，由你确认是否合并。

> **开发中。** 已可体验[第 1 天本机闭环](#运行本机编排)，也可以[运行 pi 原型](#运行当前原型)。下方的远程执行和交接是目标体验。

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

需要 Node.js 24、Codex CLI 0.170.0 和已登录的 Codex（`codex login status`）。Day 1 由 CLI 直接提交简报，Runner 串行执行，Codex 在指定的现有工作区内操作。启动 Host 的终端保持打开。

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

重启 Host 时复用同一数据目录，即可从 `show` 和 `events` 取回已保存的结果和历史。Codex 可执行文件缺失时（例如另起 Host 时设置 `--codex /nonexistent/codex`），任务和执行都会进入 `failed`，原因会出现在 `show` 和 `tail` 中。Host 意外退出后，未确认结束的执行在重启时进入 `waiting`，并阻止重叠工作区的新执行。Day 1 保留执行记录供核对，原生会话恢复在后续阶段实现。

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
