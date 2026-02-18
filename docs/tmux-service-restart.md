# 各服务重启流程（tmux 手动 kill + start）

本文档约定：**不使用 `restart` 命令**，统一采用两步流程：
1. `tmux kill-session`（或等价封装）
2. 重新 `start`

## 通用检查

先看当前会话：

```bash
pnpm workflow:sessions
# 或
# tmux list-sessions
```

如果 session 不存在，`kill` 会提示不存在，可直接执行 `start`。

## 1) pi 主进程（compiled pi）

默认 session：`pi-run`

### 手动流程

```bash
# 1. kill
pnpm workflow:session:kill -- pi-run
# 或 tmux kill-session -t pi-run

# 2. start
pnpm workflow:run
```

### 验证

```bash
pnpm workflow:run:status
pnpm workflow:run:logs
```

## 2) mom service

默认 session：`pi-mom-service`

### 手动流程

```bash
# 1. kill
pnpm workflow:session:kill -- pi-mom-service
# 或 tmux kill-session -t pi-mom-service

# 2. start
pnpm workflow:mom
```

### 验证

```bash
pnpm workflow:mom:status
pnpm workflow:mom:logs
```

## 3) dev 工作流（pnpm dev + pi-test）

默认 session：`pi-dev`

### 手动流程

```bash
# 1. kill
pnpm workflow:session:kill -- pi-dev
# 或 tmux kill-session -t pi-dev

# 2. start（会重新拉起 dev 与 pi 窗口）
pnpm workflow:dev
```

## 推荐别名（可选）

如果你想用“重启”这个词，也建议底层仍走 kill + start。可在 shell 配置里加：

```bash
alias pi-restart-run='pnpm workflow:session:kill -- pi-run && pnpm workflow:run'
alias pi-restart-mom='pnpm workflow:session:kill -- pi-mom-service && pnpm workflow:mom'
alias pi-restart-dev='pnpm workflow:session:kill -- pi-dev && pnpm workflow:dev'
```

> 上述别名不会调用 `workflow:*:restart`，符合“先 kill，再 start”的要求。

## 故障处理

- `no server running on /tmp/tmux-*`：当前没有 tmux 服务，直接执行 `start`。
- `session not found`：session 已退出，直接执行 `start`。
- 启动后无输出：执行 `pnpm workflow:*:logs` 或 `tmux attach -t <session>` 查看。
