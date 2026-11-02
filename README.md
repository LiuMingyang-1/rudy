# Rudy

基于 [pi](https://github.com/earendil-works/pi) 构建的个人助理。
Rudy 是独立的 TypeScript 应用，通过 npm 使用 pi，不维护 pi 的源码或发布流程。

## 当前可用

- 命令行多轮聊天、流式输出、取消当前执行。
- OpenAI / Anthropic API 接入，以及自定义 Base URL 和模型的兼容服务。
- 指定工作目录内的只读文件工具：列目录、读取小型文本文件。
- 按工作目录自动保存和恢复会话，重启后接着聊。
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
| `RUDY_MAX_TOKENS` | `4096` | 自定义端点的最大输出 token 数，正整数 |
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
这两个配置仅用于自定义端点；不设置 Base URL 时仍使用 pi 模型目录的元数据。
配置不会扩大服务的实际能力，也不代表价格估算。

## 代码结构

```text
src/
  config.ts        环境配置与校验
  agent.ts         组装 pi、模型、提示词和工具
  client/cli.ts    命令行入口和命令处理
  client/output.ts 终端信息、会话列表和流式输出
  session/session.ts 会话恢复、落盘与切换
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
