# Rudy

基于 [pi](https://github.com/earendil-works/pi) 构建的个人助理。
Rudy 是独立的 TypeScript 应用，通过 npm 使用 pi，不维护 pi 的源码或发布流程。

## 当前可用

- 命令行多轮聊天、流式输出、取消当前执行。
- OpenAI / Anthropic API 接入，以及自定义 Base URL 和模型的兼容服务。
- 指定工作目录内的只读文件工具：列目录、读取小型文本文件。
- 按工作目录自动保存和恢复会话，重启后接着聊。
- 请求前自动压缩长历史；`/compact` 手动压缩，原始消息可按需分页查回。
- `/reset` 开始新会话，`/resume` 列出历史会话，`/resume <编号>` 切换会话，`/exit` 退出。

后台任务、跨会话的持久化记忆、定时触发和主动通知尚未实现。

## 启动

需要 Node.js **22.19+**（推荐 Node.js 24）。直接运行 TypeScript，无需构建。

```sh
npm ci --ignore-scripts
cp .env.example .env
```

在 `.env` 中填写 `OPENAI_API_KEY`，然后启动：

```sh
npm start
```

也可以执行单次任务：

```sh
npm start -- "读取 README.md，说明这个项目目前能做什么"
```

`.env` 仅在本地使用，已被 Git 忽略。配置项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RUDY_PROVIDER` | `openai` | 官方服务为 `openai` / `anthropic`；自定义服务可填写自己的名称 |
| `RUDY_MODEL` | 按 provider 选择 | OpenAI 默认 `gpt-5.4`，Anthropic 默认 `claude-sonnet-4-6` |
| `RUDY_BASE_URL` | 无 | 自定义 API 基础地址，保留服务要求的路径前缀 |
| `RUDY_CONTEXT_WINDOW` | `128000` | 自定义端点的上下文窗口 token 数，正整数 |
| `RUDY_MAX_TOKENS` | `4096` | 普通回复的输出 token 预算，正安全整数，受模型上限约束 |
| `RUDY_COMPACTION_THRESHOLD` | `0.8` | 自动压缩触发比例，大于 0、小于 1 |
| `RUDY_COMPACTION_KEEP_RECENT_TOKENS` | `20000` | 压缩后近期原文目标 token 数，正安全整数 |
| `RUDY_COMPACTION_MAX_TOKENS` | `8192` | 摘要初始输出预算，正安全整数，独立于普通回复 |
| `RUDY_API_KEY` | 无 | 通用 API 凭证，优先于下面的 provider 专用变量 |
| `OPENAI_API_KEY` | 无 | OpenAI API 凭证 |
| `ANTHROPIC_API_KEY` | 无 | Anthropic API 凭证 |
| `RUDY_WORKSPACE` | `.` | 文件工具可访问的目录，相对于启动目录 |

切换 Anthropic 时修改 `RUDY_PROVIDER`，填写对应密钥，并删除或修改 `RUDY_MODEL`。
不设置 Base URL 时，模型需存在于当前 pi 包的模型目录中。

接入 OpenAI Chat Completions 兼容服务时，在 `.env` 中设置：

```dotenv
RUDY_PROVIDER=my-gateway
RUDY_BASE_URL=https://example.com/v1
RUDY_MODEL=your-model-id
RUDY_API_KEY=your-api-key
```

`RUDY_BASE_URL` 是基础地址，不包含 `/chat/completions`；若服务要求 `/v1`，需保留它。
设置 Base URL 后必须指定模型 ID，不再受 pi 内置模型目录限制。
`RUDY_PROVIDER=anthropic` 使用 Anthropic Messages 协议，基础地址通常不包含 `/v1/messages`，
例如 `https://your-proxy.example`。其他 provider 名称（包括 `openai`）在自定义地址下使用
Chat Completions 协议。仅支持 Responses 的代理暂不在此配置范围内。
自定义模型当前按纯文本、无额外推理参数处理，价格未知。可在 `.env` 中设置
`RUDY_CONTEXT_WINDOW=200000` 和 `RUDY_MAX_TOKENS=8192`，按端点实际支持的模型上限填写。
未设置或留空时分别使用 128000 和 4096；非法值会在启动时报错。
`RUDY_CONTEXT_WINDOW` 仅用于自定义端点；官方模型窗口和输出上限来自 pi 模型目录。
`RUDY_MAX_TOKENS` 控制每次普通回复的输出预算，也适用于官方模型。
自定义端点没有可查询的输出上限元数据，Rudy 按普通回复和摘要预算中较大者声明输出能力，
并受配置窗口限制；这两个预算都应按端点实际支持范围填写。
配置不会扩大服务的实际能力，也不代表价格估算。

## 代码结构

```text
src/
  config.ts        环境配置与校验
  agent.ts         组装 pi、模型、提示词和工具
  client/cli.ts    命令行入口和命令处理
  client/output.ts 终端信息、会话列表和流式输出
  session/session.ts 会话恢复、落盘与切换
  session/compaction.ts token 估算、原文切分、摘要和有限重试
  runtime/model.ts 模型 provider 与自定义模型配置
  tools/files.ts   工作目录内的只读文件工具
test/              离线测试，使用 pi 的模拟模型，不消耗 API 额度
```

pi 提供模型接口、agent loop、工具执行和事件。Rudy 负责应用入口、配置、工具策略，
后续再增加个人助理所需的任务调度、记忆和通知。

文件工具不读取隐藏路径（包括 `.env` 和 `.git`）、`node_modules`、工作目录外的路径或
指向这些位置的符号链接。读取上限为 64 KiB，列目录最多返回 100 项。
这只是应用层路径校验，不是操作系统沙箱；不要在其他进程能恶意修改的目录中运行。
读取的内容会进入模型上下文，请只指定你愿意交给模型处理的目录。

## 会话保存与恢复

交互聊天和单次任务均自动使用当前工作目录的会话。首次启动自动创建 UUID，之后恢复
该目录上次使用的会话；模型和凭证仍由当前启动配置决定。

会话存放在 `~/.rudy/sessions/<工作目录哈希>/`。工作目录先解析为真实路径，因此符号链接
指向同一目录时共享会话，不同目录则隔离。`current.json` 记录当前 UUID，采用临时文件
加原子替换；`<UUID>.jsonl` 的首行是版本为 1 的会话元数据，后续记录完整 pi 消息，
包括系统提示、工具声明、用户消息、助手消息和工具结果。配置中的 API key 不写入会话文件。
会话包含对话及工具读取的内容，存储目录默认仅当前用户可访问，并受现有隐藏路径规则保护。

完整消息结束后串行追加，调用返回前等待写入。取消或模型报错也保存已结束的消息。
强制退出可能丢失未写完的消息；恢复时截断末尾未完成的行，中间损坏、版本不支持或当前
指针损坏均明确报错，不静默创建新会话。中断的工具调用会补充失败结果，不会重新执行。
这里保证进程重启后的恢复，不承诺断电时的持久性。

- `/reset` 创建并切换到新会话，旧文件保留。
- `/resume` 列出当前工作目录内有用户消息的会话，仅显示编号和最近消息时间，按时间倒序。
- `/resume <编号>` 切换到最近一次列表中的会话，下次启动继续该会话。
- `/compact` 手动压缩当前有效历史；没有可移出近期保留区的消息时不请求模型。

每次模型请求前（包括工具续跑）检查上下文，默认达到有效窗口的 80% 时压缩；另为输出
预算和 1024 tokens 的额外开销留出空间。优先用本次运行最近一次有效 API usage，加上
后续新增消息的估算；恢复、压缩或模型变化后回退本地估算。ASCII 按约 4 字符/token、
非 ASCII 按 Unicode 码点约 1.5 tokens 计数。这是启发式估算，不能保证端点永不超窗。

摘要使用同一模型的独立请求，输入当前系统上下文、旧摘要和全部有效消息，不执行工具。
压缩后保留最新摘要及近期原文，默认目标 20000 tokens；assistant 工具调用及该批全部
结果整体保留或移入摘要，达到目标的 120% 时排除整个边界单元。最新批次过大时可只留摘要。
摘要作为历史用户消息重放，不升级为系统指令；系统提示与工具声明单独恢复。

JSONL 保留版本 1，原消息不删除，另追加 `type: "compaction"` 记录。`firstKept` 是原始
消息的一基编号（不计 header 和 compaction 行），`messageCount + 1` 表示空尾部。
恢复采用最新摘要和保留边界后的原消息；压缩时间不改变会话列表的最近对话时间。
摘要验证和预算检查通过、写盘成功后才替换运行上下文；写盘失败沿用会话阻断规则。

摘要请求最多共 3 次尝试，临时错误使用 250/500ms 可取消退避，关闭 provider 内建重试；
空摘要或截断只允许重新生成一次，共用这 3 次上限。截断时输出预算最多翻倍，并受模型和
剩余窗口约束。确定性错误、无效摘要或压缩后仍放不下请求均明确报错，保留原历史。
忙时第一次 Ctrl+C 取消整个操作（包括手动压缩和退避）；操作停止后再次 Ctrl+C 退出。
运行期间输入的命令或消息会立即拒绝，不会在结束后自动排队执行。

模型可用 `read_session_history` 按需读取当前 session 的原始记录，每页最多 50 条消息、
16000 字符。默认从最近被压缩的历史向前读取；长消息按偏移续读，结果带稳定编号、角色、
工具调用关联及 `nextCursor`。该工具不接受文件路径或其他 session ID，工作区文件工具
的边界不变。摘要可能遗漏或误记关键细节，需要时应查回原文，避免无目的遍历历史。

写入失败会中止当前执行，并阻止继续发送消息，直到重新打开、恢复或重置会话。
第一版不提供会话标题、删除、格式迁移或多进程写入协调；请勿同时启动多个进程操作同一工作目录。

## 开发

```sh
npm run check
npm run test:unit
```

`npm run format` 自动整理格式。依赖固定为精确版本，安装时不运行生命周期脚本。
不使用 GitHub Actions，检查和测试在本地运行。

本仓库的 Git 历史保留了最初导入的 pi 源码；当前工作树为独立的 Rudy 应用。
`upstream` 远程仅用于参考 pi，不要直接合并整个 pi 仓库；升级通过更新 npm 依赖完成。

## License

MIT。保留原 pi 的版权声明，见 [LICENSE](LICENSE)。
