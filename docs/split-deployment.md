# 前后端分离部署改造文档

## 概述

将 infinite-canvas 从**一体化部署**（Next.js SSR + Go 后端同机）改造为**前后端分离**：

- **前端**：Next.js 静态导出 → Cloudflare Pages（CDN 全球加速）
- **后端**：Go 独立 Docker 镜像 → 私有服务器（NAS），通过 Cloudflare 代理暴露 `api.asac.cc`

---

## 架构对比

| | 原架构 (main) | 新架构 (分离部署) |
|---|---|---|
| 前端部署 | Next.js `standalone` 模式（Node.js 服务端） | `export` 纯静态文件 → Cloudflare Pages |
| API 调用 | Next.js BFF 代理 `/api`（同源，无 CORS） | 浏览器直连 `api.asac.cc`（跨域，需 CORS） |
| WebDAV 代理 | Next.js route handler | Go 后端 `POST /webdav-proxy` |
| 后端部署 | 与前端一起打包 | 独立 Docker 镜像 `fairyfox/infinite-canvas-api` |
| CORS | 无需 | Go CORS 中间件 + One API CORS |

### 数据流

```
浏览器
  │
  ├── Cloudflare Pages (static frontend)
  │       └── canvas 路由通过 _redirects SPA 回退
  │
  └── HTTPS api.asac.cc
        │  Cloudflare DNS (proxy, Flexible SSL)
        │  Origin Rule: host=api.asac.cc → port 8080
        ▼
      NAS IPv6:8080 → Go backend (Docker, network_mode: host)
        │
        ├── /api/health, /api/settings, /api/auth/* ...
        │      Go 直接处理 + Go CORS
        │
        └── /api/v1/images/generations, /api/v1/chat/completions ...
               → One API (上游) → Go
               One API 设 CORS, Go 跳过
```

---

## 文件变更清单（16 files, +257/-122）

### 新增文件

| 文件 | 说明 |
|------|------|
| `Dockerfile.api` | Go 后端独立构建镜像（标准版） |
| `Dockerfile.backend` | Go 后端独立构建镜像（国内版，含 GOPROXY） |
| `docker-compose.api.yml` | 后端独立 compose（标准版） |
| `docker-compose.backend.yml` | 后端独立 compose（国内版模板） |
| `handler/webdav_proxy.go` | WebDAV 代理——浏览器 CORS 限制，由后端转发 WebDAV 请求 |
| `web/src/hooks/use-backend-health.ts` | 前端后端连接状态钩子，30 秒轮询 `/api/health` |
| `web/public/_redirects` | Cloudflare Pages SPA 路由回退规则 |

### 删除文件

| 文件 | 说明 |
|------|------|
| `web/src/app/api/[...path]/route.ts` | 原 Next.js BFF API 代理（不再需要） |
| `web/src/app/webdav-proxy/route.ts` | 原 Next.js WebDAV 代理（迁移到 Go） |

### 修改文件

| 文件 | 变更内容 |
|------|---------|
| `router/router.go` | 添加 CORS 中间件（Origin 回显，v1 路径跳过留给 One API），新增 `/webdav-proxy` 路由 |
| `web/next.config.ts` | `output` 从 `standalone` 改为 `export`，添加 `trailingSlash`，新增 `NEXT_PUBLIC_API_BASE_URL` 环境变量 |
| `web/src/app/(user)/canvas/[id]/page.tsx` | 静态导出兼容：`generateStaticParams` 生成占位页 |
| `web/src/services/api/request.ts` | axios 请求前缀拼接 `NEXT_PUBLIC_API_BASE_URL` |
| `web/src/services/api/image.ts` | remote 模式 AI 请求拼接完整后端地址 |
| `web/src/services/webdav-sync.ts` | WebDAV 代理地址拼接 `API_BASE` |
| `web/src/components/layout/user-status-actions.tsx` | 添加后端健康状态指示圆点 UI |
| `.gitignore` | 添加 `web/package-lock.json` |

---

## CORS 处理策略（核心难点）

### 问题根因

`/api/v1/*` 路径经过 **One API**（OpenAI 代理）转发到 Go 后端。One API 会自动添加 `Access-Control-Allow-Origin: *`。如果 Go 也设置 CORS 头，浏览器收到两个 `Access-Control-Allow-Origin` 值，触发 CORS 错误：

```
The 'Access-Control-Allow-Origin' header contains multiple values 'http://localhost:3333, *'
```

### 解决方案

```go
// router/router.go CORS 中间件
isV1 := strings.HasPrefix(c.Request.URL.Path, "/api/v1/")

// 所有 OPTIONS 预检请求 —— 返回 CORS 头
if c.Request.Method == "OPTIONS" {
    setCORS()                      // Access-Control-Allow-Origin: <请求Origin>
    c.AbortWithStatus(204)
    return
}

// /api/v1/* 正常请求 —— 跳过，由 One API 设 CORS
if isV1 {
    c.Next()
    return
}

// 其他路径 —— Go 设 CORS（Origin 回显）
setCORS()
c.Next()
```

| 路径 | OPTIONS 预检 | GET/POST CORS 来源 |
|------|-------------|-------------------|
| `/api/health` 等 | Go（Origin 回显） | Go（Origin 回显） |
| `/api/v1/images/generations` 等 | Go（Origin 回显） | **One API（`*`）** |
| `/webdav-proxy` | Go（Origin 回显） | Go（Origin 回显） |

### 为什么用 Origin 回显而不是 `*`

`Access-Control-Allow-Origin: *` 与 `Authorization` 等凭证头不兼容。回显请求的 `Origin` 头更安全，且浏览器能正确处理。如果请求无 `Origin` 头（如 curl），默认使用 `*`。

---

## 部署操作

### 1. 构建推送后端

```bash
# 在 WSL 中
cd /mnt/c/Users/root/Documents/project/github/infinite-canvas
docker build -f Dockerfile.backend -t fairyfox/infinite-canvas-api:v9 .
docker push fairyfox/infinite-canvas-api:v9
```

### 2. NAS 部署

```bash
# SSH 到 NAS
ssh root@nas.asac.cc

# 进入 compose 目录
cd /vol1/1000/docker-compose/image

# 拉取并重启
docker pull fairyfox/infinite-canvas-api:v9
docker compose -f docker-compose.yml down
docker compose -f docker-compose.yml up -d
```

### 3. 本地前端开发

```bash
cd web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run dev -p 3333
```

### 4. Cloudflare Pages 部署

```bash
cd web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run build
# 将 web/out/ 部署到 Cloudflare Pages
```

---

## Cloudflare 配置

### DNS 记录

| 类型 | 名称 | 目标 | 代理 |
|------|------|------|------|
| AAAA | api.asac.cc | `2408:823c:...` (NAS IPv6) | 橙色云 |

### Origin Rules

| 规则名 | 匹配 | 目标端口 |
|--------|------|---------|
| image-2-nas | `http.host eq "api.asac.cc"` | 8080 |

### SSL/TLS

- 模式：Flexible（浏览器→Cloudflare HTTPS，Cloudflare→源站 HTTP:8080）

---

## NAS docker-compose.yml

```yaml
services:
  backend:
    image: fairyfox/infinite-canvas-api:v9
    container_name: infinite-canvas-api
    network_mode: host          # 直接使用宿主机 IPv6
    env_file:
      - .env
    volumes:
      - ./data:/app/data        # SQLite 数据持久化
    restart: unless-stopped
```

### .env 关键配置

```ini
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<your-password>
JWT_SECRET=infinite-canvas      # 生产环境务必修改
JWT_EXPIRE_HOURS=168
STORAGE_DRIVER=sqlite
DATABASE_DSN=data/infinite-canvas.db
PORT=8080
```

---

## 注意事项

1. **One API CORS 冲突**：如果更换 AI 代理方案（不再使用 One API），需恢复 Go 对 `/api/v1/*` 的 CORS 设置，或移除中间件中的 `isV1` 跳过逻辑。

2. **Cloudflare Flexible SSL**：源站端口 8080 走 HTTP 明文，生产环境建议改为 Full SSL 模式并配置源站证书。

3. **IPv6 依赖**：NAS 必须保持 IPv6 地址不变，否则需更新 Cloudflare DNS AAAA 记录。

4. **国内构建**：`Dockerfile.backend` 使用 `goproxy.cn` 代理，海外构建可删除该行。

5. **前端 `NEXT_PUBLIC_API_BASE_URL`**：本地开发和 Cloudflare Pages 部署均需设置此变量指向后端地址，构建时 baked in。

6. **数据持久化**：SQLite 数据库挂载在 `./data`，重部署时勿删除此目录。

7. **网络模式**：`network_mode: host` 避免 Docker 网络层 NAT 导致的 IPv6 连接问题。副作用是容器端口直接占用宿主机端口。

8. **主应用 Dockerfile**：当前主应用镜像也按静态前端构建，运行时由 Nginx 服务 `web/out` 并反代 `/api/*` 到容器内 Go 后端；不再依赖 Next.js `standalone` 产物。
