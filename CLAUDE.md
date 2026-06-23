# Infinite Canvas — AI Agent Onboarding

> 本文档供其他 AI Agent / 协作者快速理解项目结构、环境信息和部署操作。
> 最后更新：2026-06-24

---

## 项目概览

| 项目 | 详情 |
|---|---|
| 仓库 | `github.com/fayfoxcat/infinite-canvas` |
| 版本 | `v0.2.5` |
| 许可证 | AGPL-3.0 |
| 分支策略 | `main`（稳定）← PR ← `dev`（开发） |
| CI/CD | GitHub Actions → Docker 镜像 → NAS 部署；前端 push 触发 Cloudflare Pages 自动构建 |

**功能**：AI 图片生成 / 视频生成 / 对话 / TTS 的统一画布应用，集成模型渠道管理、算力点计费、提示词库。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Go 1.25, Gin v1.11, GORM v1.31, SQLite (默认) / MySQL / PostgreSQL |
| 前端 | Next.js 16.2 (App Router), React 19.2, TypeScript 5, Ant Design 6.4, Zustand 5, TanStack Query 5 |
| 文档站 | Next.js 16.2 + Fumadocs 16.9 |
| 包管理 | bun (前端), go mod (后端) |
| 容器化 | Docker + Docker Compose |
| 镜像仓库 | GitHub Container Registry (`ghcr.io/basketikun/infinite-canvas`) 和 Docker Hub (`fairyfox/infinite-canvas-api`) |

---

## 架构：前后端分离部署

```
浏览器 (image.asac.cc)
  │
  ├── Cloudflare Pages（前端静态文件 CDN）
  │     SPA 回退: /canvas/* → /canvas/_/ 200
  │     SSL: Cloudflare 自动 HTTPS
  │
  └── HTTPS api.asac.cc
        └── Cloudflare DNS Proxy (Flexible SSL, Origin Rule → :8080)
              └── NAS Docker (network_mode: host)
                    └── Go 后端 :8080
                          ├── /api/v1/* → One API（上游 AI 代理）
                          ├── /webdav-proxy → WebDAV
                          └── SQLite: ./data/infinite-canvas.db
```

### Cloudflare 配置

| 配置项 | 值 |
|---|---|
| DNS | `api.asac.cc` → AAAA 记录 → NAS IPv6（橙色云代理） |
| Origin Rules | `api.asac.cc` → 端口 8080 |
| SSL/TLS | Flexible（浏览器→CF HTTPS，CF→NAS HTTP） |
| 限制 | **100 秒代理超时**——图片生成已改为后端异步轮询模式 |

---

## 服务器信息

### NAS（后端运行环境）

| 属性 | 值 |
|---|---|
| 地址 | `nas.asac.cc` |
| 用户 | `root` |
| 部署目录 | `/vol1/1000/docker-compose/image/` |
| Compose 文件 | `docker-compose.yml`（`network_mode: host`） |
| 数据目录 | `./data/`（挂载到容器 `/app/data/`，含 SQLite DB） |
| 镜像 | `fairyfox/infinite-canvas-api`（Docker Hub） |

### WSL（本地开发/构建环境）

| 属性 | 值 |
|---|---|
| 项目路径 | `/mnt/c/Users/root/Documents/project/github/infinite-canvas` |
| Docker | 可用（`wsl -e bash -c "docker ..."` 从 Windows 调用） |
| Go | 需要 WSL 内安装或有 Docker 构建 |
| Node/bun | Windows 侧可用 |

---

## 环境变量（关键项）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | 管理员账号 |
| `ADMIN_PASSWORD` | — | 首次启动自动创建 |
| `JWT_SECRET` | 自动生成 | 若为 `infinite-canvas` 则自动替换随机密钥 |
| `JWT_EXPIRE_HOURS` | `168` | 7 天 |
| `PORT` | `8080` | 后端端口 |
| `STORAGE_DRIVER` | `sqlite` | sqlite / mysql / postgres |
| `DATABASE_DSN` | `data/infinite-canvas.db` | 数据库连接 |
| `NEXT_PUBLIC_API_BASE_URL` | — | 前端 API 地址（构建时 baked-in） |
| `NEXT_PUBLIC_DOC_URL` | `https://docs.canvas.best` | 文档站 |

---

## 构建与部署命令

### 后端：修改 Go 代码后部署到 NAS

```bash
# 1. 构建镜像（在 Windows 终端执行）
wsl -e bash -c "cd /mnt/c/Users/root/Documents/project/github/infinite-canvas && docker build -f Dockerfile.backend -t fairyfox/infinite-canvas-api:v<版本号> ."

# 2. 推送
wsl -e bash -c "docker push fairyfox/infinite-canvas-api:v<版本号>"

# 3. 部署到 NAS（使用 Python paramiko）
python deploy_nas.py  # 临时脚本，用完删除，包含 SSH 密码
```

### NAS 部署 Python 脚本模板

```python
import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("nas.asac.cc", username="root", password="<来自用户>", timeout=15)
# 更新 docker-compose.yml 中的 tag → pull → down → up -d
# compose 路径: /vol1/1000/docker-compose/image/docker-compose.yml
# sed -i 's|fairyfox/infinite-canvas-api:v[0-9]*|fairyfox/infinite-canvas-api:v<新版本>|g'
```

### 前端：构建并部署到 Cloudflare Pages

```bash
cd web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run build
# 产物在 web/out/，部署到 Cloudflare Pages
# 或直接 push 到 GitHub，Cloudflare Pages 自动构建
```

### 本地开发

```bash
# 后端
cd <项目根目录>
go run .

# 前端（连接远程后端）
cd web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run dev -p 3333
```

---

## 关键设计决策与模式

### 1. 异步图片生成（绕过 Cloudflare 100s 限制）

- **问题**：Cloudflare 代理有 100 秒超时，同步等待 AI 图片生成可能超时
- **方案**：后端内部管理异步任务
  - `POST /api/v1/images/generations` → 立即返回 `{id, status:"pending"}`
  - 后台 goroutine 调用上游 AI（5 分钟超时），结果存 SQLite
  - 前端轮询 `GET /api/v1/images/generations/:id`（120 次 × 2.5s）
  - `GET /api/v1/images/generations/:id/result` 返回完整结果
  - `?sync=1` 参数保留原同步路径
- **关键文件**：`service/image_task.go`（goroutine 池，并发限制 10），`model/image_task.go`，`handler/ai.go`
- **并发控制**：`make(chan struct{}, 10)` 信号量
- **清理**：每小时删除 24 小时前的过期任务（`StartImageTaskCleaner`）

### 2. CORS 双重头处理

- **问题**：Go 和 One API 都设 `Access-Control-Allow-Origin`，浏览器拒绝多个值
- **方案 1**：`handler/ai.go` 的 `copyAIResponse` 跳过上游 CORS 头（`isCORSHeader` 过滤）
- **方案 2**：`router/router.go` 去重逻辑保留第一个值（Go 的特定 origin），而非 `*`
- **原因**：`*` 与 `Authorization` 凭证头不兼容

### 3. 模型类型检测

- **旧方案**：纯关键词匹配（`isImageModelName` / `isVideoModelName` / `isTextModelName`）
- **新方案**：`ModelChannel.Type` 字段（text/image/video/audio），管理员显式设置
- **兜底**：Type 为空时还是用关键词启发式
- **影响**：`collectChannelModelsByCapability` 用于 default model repair

### 4. 渠道选择

- `SelectModelChannel(modelName)`：加权随机（`Weight` 字段）从启用的渠道中选择
- 渠道的 `Models` 列表精确匹配请求的 model name
- API Key 保存时空值不覆盖已有 key（`keepPrivateAPIKeys`）

### 5. 积分扣费

- 同步：`proxyAIRequest` 中先扣费，上游失败则退款
- 异步：`SubmitImageTask` 中扣费，`executeImageTask` 失败则 `failImageTask` 退款
- GET 轮询不扣费

---

## 目录结构要点

```
infinite-canvas/
├── main.go                  # Go 入口
├── config/config.go          # 环境变量加载
├── handler/
│   ├── ai.go                 # AI 代理 + 异步图片 handler
│   ├── auth.go               # 认证
│   ├── settings.go           # 设置 API
│   └── response.go           # OK/Fail 响应工具
├── middleware/
│   └── admin.go              # UserAuth / AdminAuth / OptionalAuth
├── model/
│   ├── setting.go            # ModelChannel, Settings 结构体
│   ├── image_task.go         # 异步图片任务模型
│   └── user.go               # User, CreditLog
├── repository/
│   ├── db.go                 # 数据库初始化 + AutoMigrate
│   ├── image_task.go         # ImageTask CRUD
│   ├── setting.go            # Settings CRUD
│   └── user.go               # 用户/积分操作
├── router/router.go          # 路由 + CORS 中间件
├── service/
│   ├── settings.go           # 渠道选择、模型分类、配置标准化
│   ├── image_task.go         # 异步任务 goroutine 池 + 清理器
│   └── auth.go               # 积分扣费/退款
├── web/                      # Next.js 前端
│   ├── src/app/(user)/       # 用户页面（canvas, login, ...）
│   ├── src/app/(admin)/      # 管理后台
│   ├── src/services/api/     # API 客户端
│   ├── src/stores/           # Zustand stores
│   └── next.config.ts        # output: "export" (生产) / standalone (开发)
├── Dockerfile                # 一体化镜像
├── Dockerfile.backend        # 独立后端镜像（国内 GOPROXY）
├── docker-compose.yml        # 一体化部署模板
├── .env.example              # 环境变量模板
└── docs/split-deployment.md  # 分离部署详细文档
```

---

## 常见问题排查

| 问题 | 排查命令 |
|---|---|
| 后端是否存活 | `curl https://api.asac.cc/api/health` → 应返回 `ok` |
| NAS 容器状态 | SSH → `docker ps --filter name=infinite-canvas-api` |
| 后端日志 | SSH → `docker logs infinite-canvas-api --tail 100` |
| CORS 是否正常 | `curl -sI -X OPTIONS -H "Origin: https://image.asac.cc" -H "Access-Control-Request-Method: POST" https://api.asac.cc/api/v1/images/generations` |
| 异步任务是否创建 | 检查 `POST /api/v1/images/generations` 应返回 `{code:0, data:{id, status}}` |
| 前端是否最新 | Cloudflare Pages 构建日志（GitHub push → CF dashboard） |

---

## 部署检查清单

- [ ] 后端：新 Docker 镜像已推送到 Docker Hub
- [ ] NAS：`docker-compose.yml` 中 tag 已更新
- [ ] NAS：`docker compose up -d` 已执行
- [ ] NAS：`curl localhost:8080/api/health` → `ok`
- [ ] NAS：`docker logs` 无 panic / 严重错误
- [ ] 前端：Git push → Cloudflare Pages 构建成功
- [ ] 验证：浏览器访问 `image.asac.cc` → 登录 → 图片生成可用
