# Infinite Canvas — AI Agent Onboarding

> 最后更新：2026-06-26

---

## 分支策略

| 分支 | 用途 | 说明 |
|------|------|------|
| `main` | 上游分支 | 上游已抛弃后端，改为纯前端项目；仅作历史参考，不在此分支开发 |
| `master` | 生产主分支 | 后端运行在 NAS (`nas.asac.cc`)，前端部署 Cloudflare Pages；本地调试前端连 NAS 后端 |
| `dev` | 开发分支 | 后端在 WSL 内运行，前端在 Windows 宿主机运行（:3333 连 WSL 后端） |

### 各分支启动命令

**master 分支（前端调试，连 NAS 后端）：**
```bash
cd web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run dev -p 3000
# 访问 http://localhost:3000
# 提交 master → GitHub → Cloudflare Pages 自动部署
```

**dev 分支（全栈开发，后端 WSL + 前端 Windows）：**
```bash
# 后端（WSL 内）
cd /mnt/c/Users/root/Documents/project/github/infinite-canvas
go run .

# 前端（Windows 宿主机 PowerShell）
cd web
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8080"; bun run dev -p 3333
# 访问 http://localhost:3333
```

---

## 项目概览

| 项目 | 详情 |
|---|---|
| 仓库 | `github.com/fayfoxcat/infinite-canvas` |
| 版本 | `v0.2.5` |
| 许可证 | AGPL-3.0 |
| 功能 | AI 图片生成 / 视频生成 / 对话 / TTS 的统一画布应用 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Go 1.25, Gin v1.11, GORM v1.31, SQLite |
| 前端 | Next.js 16.2 (App Router), React 19.2, TypeScript 5, Ant Design 6.4, Zustand 5, TanStack Query 5 |
| 包管理 | bun (前端), go mod (后端) |
| 容器化 | Docker + Docker Compose |
| 镜像仓库 | Docker Hub (`fairyfox/infinite-canvas-api`) |

---

## 架构：前后端分离部署

```
浏览器 (image.asac.cc)
  │
  ├── Cloudflare Pages（前端静态文件 CDN）
  │
  └── HTTPS api.asac.cc
        └── Cloudflare DNS Proxy (Flexible SSL, Origin Rule → :8080)
              └── NAS Docker (network_mode: host)
                    └── Go 后端 :8080
                          ├── /api/v1/* → 上游 AI 代理
                          ├── /api/media/generations/* → 图片文件下载
                          └── SQLite: ./data/infinite-canvas.db
```

---

## 服务器信息

| 属性 | 值 |
|---|---|
| NAS 地址 | `nas.asac.cc` (root) |
| 部署目录 | `/vol1/1000/docker-compose/image/` |
| Compose 文件 | `docker-compose.yml`（`network_mode: host`） |
| 数据目录 | `./data/`（挂载 `/app/data/`，含 SQLite + images） |

---

## 构建与部署

### 后端部署到 NAS
```bash
# Windows 终端
wsl -e bash -c "cd /mnt/c/Users/root/Documents/project/github/infinite-canvas && docker build -f Dockerfile.backend -t fairyfox/infinite-canvas-api:v<N> ."
wsl -e bash -c "docker push fairyfox/infinite-canvas-api:v<N>"

# NAS
cd /vol1/1000/docker-compose/image
sed -i 's|fairyfox/infinite-canvas-api:v[0-9]*|fairyfox/infinite-canvas-api:v<N>|g' docker-compose.yml
docker compose pull && docker compose down && docker compose up -d
```

---

## 目录结构

```
infinite-canvas/
├── main.go                  # Go 入口
├── config/config.go          # 环境变量加载
├── handler/
│   ├── ai.go                 # AI 代理 + 异步图片 handler
│   ├── auth.go               # 认证
│   ├── settings.go           # 设置 API + 模型管理 API
│   └── response.go           # OK/Fail 响应工具
├── middleware/
│   └── admin.go              # UserAuth / AdminAuth / OptionalAuth
├── model/
│   ├── setting.go            # ModelChannel, Settings 结构体
│   ├── image_task.go         # 异步图片任务 + ResultFiles 文件存储
│   ├── model_info.go         # ModelInfo 模型元数据（🆕）
│   └── user.go               # User, CreditLog
├── repository/
│   ├── db.go                 # 数据库初始化 + AutoMigrate
│   ├── image_task.go         # ImageTask CRUD
│   ├── model_info.go         # ModelInfo CRUD（🆕）
│   ├── setting.go            # Settings CRUD
│   └── user.go               # 用户/积分操作
├── router/router.go          # 路由 + CORS 中间件
├── service/
│   ├── settings.go           # 渠道选择、模型分类、SyncModelInfos
│   ├── image_task.go         # 异步任务 goroutine 池 + 清理器 + 图片文件存储
│   └── auth.go               # 积分扣费/退款
├── data/images/               # 图片生成结果文件存储 YYYY/MM/userID/
├── web/                      # Next.js 前端
│   ├── src/app/(user)/       # 用户页面
│   ├── src/app/(admin)/admin/
│   │   ├── users/            # 用户管理
│   │   ├── models/           # 模型管理（🆕 渠道+模型清单+类型规则+定价）
│   │   ├── assets/           # 素材库
│   │   ├── prompts/          # 提示词管理
│   │   ├── credit-logs/      # 算力点日志
│   │   └── settings/         # 系统设置（🆕 扁平表单）
│   ├── src/services/api/     # API 客户端
│   └── src/stores/           # Zustand stores
└── Dockerfile.backend        # 独立后端镜像
```

---

## 关键设计决策

### 1. 异步图片生成（绕过 Cloudflare 100s 限制）
- `POST /api/v1/images/generations?async=1` → 立即返回 `{id, status:"pending"}`
- 后台 goroutine 调用上游 AI，结果存文件系统 (`data/images/YYYY/MM/userID/`)
- 前端轮询 `GET /api/v1/images/generations/:id`（120 次 × 2.5s）
- 并发控制：信号量 `make(chan struct{}, 10)`
- 清理：每小时删除 24 小时前的过期任务及其图片文件

### 2. 图片结果文件存储（v19+）
- 上游返回 base64 → 解码 → 写入 `data/images/YYYY/MM/userID/taskID-N.png`
- `GET /api/v1/images/generations/:id/result` 返回 `{"data":[{"url":"..."}]}`
- 图片文件通过 `/api/media/generations/*filepath` 公开下载（永久缓存）

### 3. DNS 劫持修复（v20+）
- NAS 路由器 DNS (192.168.0.1) 对 `uuapi.cc` 返回劫持 IP `198.18.1.39`
- Go 后端使用自定义 `net.Resolver` 直连 `119.29.29.29`（DNSPod）绕过

### 4. 信号量泄漏修复（v18）
- `SubmitImageTask` 重复获取信号量导致槽位永久泄漏
- 修复：信号量只由 `executeImageTask` goroutine 管理

### 5. CORS 双重头处理
- Go 和 One API 都设 `Access-Control-Allow-Origin`，浏览器拒绝多个值
- `copyAIResponse` 跳过上游 CORS 头，router 去重逻辑保留第一个值

### 6. 模型管理（v21+）
- ModelInfo 表存储模型元数据（provider/model/displayName/type/maxSize 等）
- 从渠道同步模型 → 手动编辑显示名称/类型/尺寸限制
- 模型清单支持拖拽排序、搜索筛选、行内编辑、自动保存
- 类型列支持多选切换（text/image/video/audio）
- 尺寸列显示 k 分辨率标签（1K/2K/4K）

---

## 常见问题排查

| 问题 | 排查命令 |
|---|---|
| 后端是否存活 | `curl https://api.asac.cc/api/health` |
| NAS 容器状态 | `ssh root@nas.asac.cc "docker ps --filter name=infinite-canvas-api"` |
| 后端日志 | `ssh root@nas.asac.cc "docker logs infinite-canvas-api --tail 100"` |
| 异步任务状态 | 检查 `POST /api/v1/images/generations?async=1` 返回 |
| 模型管理 API | `curl -X POST http://localhost:8080/api/admin/models/sync` |
