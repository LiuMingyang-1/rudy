# Rudy

基于 [pi](https://github.com/earendil-works/pi) 构建的个人助理。
Rudy 是独立的 TypeScript 应用，通过 npm 使用 pi，不维护 pi 的源码或发布流程。

## 当前可用

- 命令行多轮聊天、流式输出、取消当前执行。
- OpenAI / Anthropic API 接入，以及自定义 Base URL 和模型的兼容服务。
- 指定工作目录内的只读文件工具：列目录、读取小型文本文件。
- `/reset` 清空本次对话，`/exit` 退出。

对话仅保存在当前进程内。后台任务、持久化记忆、定时触发和主动通知尚未实现。

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
自定义模型当前按纯文本、无额外推理参数处理，输出上限为 4096 tokens，
上下文窗口暂按 128000 tokens 声明，价格未知；这些默认元数据不代表服务的实际能力或价格。

## 代码结构

```text
src/
  cli.ts           命令行入口和流式输出
  config.ts        环境配置与校验
  agent.ts         组装 pi、模型、提示词和工具
  tools/files.ts   工作目录内的只读文件工具
test/              离线测试，使用 pi 的模拟模型，不消耗 API 额度
```

pi 提供模型接口、agent loop、工具执行和事件。Rudy 负责应用入口、配置、工具策略，
后续再增加个人助理所需的任务调度、记忆和通知。

文件工具不读取隐藏路径（包括 `.env` 和 `.git`）、`node_modules`、工作目录外的路径或
指向这些位置的符号链接。读取上限为 64 KiB，列目录最多返回 100 项。
这只是应用层路径校验，不是操作系统沙箱；不要在其他进程能恶意修改的目录中运行。
读取的内容会进入模型上下文，请只指定你愿意交给模型处理的目录。

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
