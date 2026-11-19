# Day 1 面试笔记：本机闭环、异常兜底与边界设计

## 1. 一句话讲清 Day 1 架构

Day 1 实现了 **CLI 与执行解耦的本机最小闭环**（`CLI -> Host -> SQLite -> LocalRunner -> Codex`）：
- **CLI 是无状态视图**：随时断开重连，关闭终端不会中断后台任务。
- **Host 是唯一权威**：所有任务状态转换与事件分配统一由 Host 裁决并写入 SQLite。
- **三层 ID 严格分离**：
  - `taskId`：用户目标与完整生命周期（跨重试、跨换手不变）。
  - `executionId`：Runner 对某任务的单次领取与执行，用于隔离不同次尝试、识别迟到事件。
  - `nativeSessionId`：Codex 自身的 `thread_id`，仅绑定特定 harness 与工作目录，绝不等同于 `taskId`。

快速对照源码只需看 4 处：
1. `src/protocol/task.ts`：三层 ID、任务状态机与事件定义。
2. `src/store/database.ts`、`src/store/tasks.ts`：进程互斥锁与状态/事件原子事务。
3. `src/host/events.ts`：基于 `seq` 游标的历史回放与实时流切换。
4. `src/runner/local.ts`、`src/harness/codex.ts`：子进程管控、目录防双写与故障兜底。

---

## 2. 面试高频追问：难点、边界条件与兜底

### Q1：CLI 断线重连，或者从“查历史”切到“推实时流”时，怎么保证不丢事件、不重复、不乱序？

- **常见坑**：先查一次数据库发历史，再挂内存 `EventEmitter` 推实时增量——两步交界处极短时间窗内落盘的事件要么漏推，要么重复推。
- **解法（SQLite 单一真相源 + `pump` 唤醒模型，`src/host/events.ts`）**：
  1. **内存不传数据，只传无参唤醒信号 `notify()`**。所有事件必须先随状态在 SQLite 事务内写入并拿到单调递增的 `seq`，提交成功后才触发 `notify()`。
  2. 每个 WebSocket 连接在闭包内维护游标 `after`，每次唤醒执行 `SELECT ... WHERE seq > after ORDER BY seq LIMIT 100`。
  3. **自带网络背压（Backpressure）**：置 `sending = true`，必须等当前批次 `ws.send` 回调完成后才置回 `false` 并递归 `pump()` 下一批，慢客户端不会撑爆 Host 内存。
  4. 当数据库暂时查不到新事件且尚未追平时，发送一次 `stream.caught_up` 告知客户端历史已追平（若此时任务已非 `queued/running`，`tail` 可直接优雅退出）。

### Q2：Host 突然崩溃（`kill -9` / 断电）重启后，原本 `running` 的任务怎么处理？为什么不直接自动重跑？

- **边界风险（脑裂双写）**：为了能整组清理子进程，Codex 运行在独立进程组（`detached`）。Host 暴毙时，旧 Codex 可能仍存活并在磁盘上改文件；若重启后盲目自动重跑，会出现两个 Agent 并发改同一工作区。
- **三层兜底（`src/store/tasks.ts`、`src/runner/local.ts`、`src/store/database.ts`）**：
  1. **启动对账（`reconcile()`）**：Host 启动时把所有残留 `running` 的任务和执行在同一事务内降级为 `waiting`，记录明确原因（未确认旧执行已停止），绝不伪造仍在运行，也不盲目重跑。
  2. **重叠目录封锁**：Runner 派发排队任务前检查真实路径包含关系（`contains(A, B) || contains(B, A)`）。只要新任务目录与未确认停止的任务存在父子或相等重叠，新任务立即转入 `waiting`，严防并发双写。
  3. **防双 Host 进程抢库**：单独使用 `host-lock.sqlite` 执行 `BEGIN EXCLUSIVE` 持锁，而不共用主库 WAL（WAL 允许读写并发，且传统 PID 文件在崩溃后会残留死锁；SQLite 独占事务锁绑定 OS 文件描述符，进程崩溃时内核自动释放锁）。

### Q3：把外部 CLI（Codex）当黑盒执行器调用，有哪些异常边界？怎么防“假成功”和“孤儿孙进程”？

- **防假成功（`src/harness/codex.ts`）**：子进程退出码为 `0` 不代表任务完成（空跑、配置忽略或提前断流也可能返回 `0`）。必须同时满足 **4 个条件**才算 `succeeded`：无 `spawnError`、`exit code === 0`、收到合法的 `thread.started`（`nativeSessionId`）、收到明确的 `turn.completed`；缺一即判 `failed` 并附带 stderr 诊断信息。
- **防启动卡死**：设置 **30 秒启动超时看门狗**，30 秒内未吐出 `thread.started` 自动触发停止并判超时失败。
- **防孤儿孙进程**：Codex 执行测试或构建会拉起子进程树。通过 `detached: true` 建立独立进程组，停止时向 `-child.pid`（整个进程组）先发 `SIGTERM`，留 2 秒优雅退出窗口，未退再补 `SIGKILL`。
- **异步停止确认**：HTTP `POST /tasks/:id/stop` 仅触发 `abort` 并返回 `202 Accepted`，绝不立即改库为已取消；必须等子进程真正触发 `close` 确认停止写入后，才将状态落盘为 `canceled`。
- **防管道破裂崩主进程**：若可执行文件缺失或秒退，向 `child.stdin` 写入简报会触发 `EPIPE`，显式监听 `child.stdin.on("error")` 吞掉写入异常，交由 `close` 统一报错。
- **防单行超大输出撑爆内存**：`readLines` 限制单行缓冲上限为 256 KiB，超长行自动丢弃跳过。

### Q4：任务运行中途如果 SQLite 写入失败（如磁盘满、权限异常）怎么办？

- **状态与日志同事务（`BEGIN IMMEDIATE`）**：更新 `tasks`、更新 `executions`、插入 `events` 永远在同一个事务中执行，单测通过 SQLite `BEFORE INSERT` 触发器注入异常验证了完整回滚，杜绝“状态变了但没事件”的脏账。
- **熔断停机（Fail-Closed，`storageFailed()`）**：运行期一旦写库失败，Runner 立即锁死 `unavailable = true`，主动 `abort` 当前正在运行的 Codex 阻止继续修改工作区，并对后续提交/停止请求返回 `503`，提示重启 Host 对账。

### Q5：本机服务只监听 `127.0.0.1` 就安全了吗？做了哪些安全边界防护？

1. **防浏览器跨站打本地端口（CSRF / DNS Rebinding）**：
   - 浏览器内任意恶意网页都能向 `127.0.0.1` 发请求。Host 直接拒绝所有携带 `Origin` 头的 HTTP/WebSocket 请求，并强校验 `Host` 头精确匹配 `127.0.0.1:<port>`。
   - 每次启动生成 32 字节随机 Token，通过临时文件 + `rename` 原子写入 `0600` 权限的 `connection.json`；校验时用 `timingSafeEqual` 防止时序侧信道。
2. **防软链越界与 TOCTOU（检查与使用时间差）**：
   - 提交任务时用 `realpath` 校验工作目录必须在允许根目录下；Runner 真正拉起 Codex 前**二次调用 `validateWorkspace` 复核路径未变**，防止排队期间目录被替换成指向外部的符号链接。
   - 显式禁止 `workspace` 与 Host 自身的 `dataDir` 重叠，防止 Agent 篡改 `tasks.sqlite`。
3. **环境变量裁剪、日志脱敏与沙箱收口**：
   - 仅向 Codex 传递最小环境变量白名单（`PATH`、`HOME`、`OPENAI_API_KEY` 等）。
   - 所有落盘进度与报错经过 `previewer`：剔除终端控制字符、将匹配敏感变量值及 `Bearer` / `sk-` 替换为 `[redacted]`，并截断至 2048 字符。
   - 显式向 Codex 注入只写目标 `workspace`、禁联网、禁插件策略，并在 macOS 上额外封禁 Seatbelt 默认放行的 `/private/tmp` 与 `/private/var/tmp`。
