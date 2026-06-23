# infinite-canvas 环境参考信息

> 生成日期：2026-06-23
> 分支：feat/cloudflare-split-deploy
> 最后提交：1af0091 (Merge upstream/main)

---

## 一、代码仓库

| 项目 | 地址 |
|------|------|
| **Fork 仓库** | `git@github.com:fayfoxcat/infinite-canvas.git` |
| **上游仓库** | `git@github.com:basketikun/infinite-canvas.git` |
| **当前分支** | `feat/cloudflare-split-deploy` |
| **Docker Hub** | `fairyfox/infinite-canvas-api` |

### 工作目录

- Linux/Git Bash：`/c/Users/root/Documents/project/github/infinite-canvas`
- Windows 路径：`C:\Users\root\Documents\project\github\infinite-canvas`

---

## 二、服务器信息

### NAS

| 项目 | 值 |
|------|-----|
| **主机名** | `catnas` |
| **SSH** | `ssh root@nas.asac.cc`（免密） |
| **compose 路径** | `/vol1/1000/docker-compose/image/` |
| **compose 文件** | `docker-compose.yml` |
| **数据目录** | `/vol1/1000/docker-compose/image/data/` |
| **配置文件** | `/vol1/1000/docker-compose/image/.env` |
| **运行镜像** | `fairyfox/infinite-canvas-api:v18` |

### docker-compose.yml（最终版）

```yaml
services:
  backend:
    image: fairyfox/infinite-canvas-api:v18
    container_name: infinite-canvas-api
    network_mode: host
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

### .env 关键配置

```ini
PORT=8080
STORAGE_DRIVER=sqlite
DATABASE_DSN=data/infinite-canvas.db
JWT_SECRET=infinite-canvas
JWT_EXPIRE_HOURS=168
```

---

## 三、云服务

### Cloudflare

| 项目 | 配置 |
|------|------|
| **前端域名** | `image.asac.cc`（Cloudflare Pages） |
| **API 域名** | `api.asac.cc`（Cloudflare DNS + Origin Rule） |
| **DNS 类型** | AAAA 记录，`api.asac.cc` → NAS IPv6 `2408:823c:e17:20b0:3e4c:fc16:ef23:87a` |
| **代理模式** | `api.asac.cc` 橙色云（已代理），其他灰色云 |
| **Origin Rule** | `http.host eq "api.asac.cc"` → 目标端口 8080 |
| **SSL 模式** | **Flexible**（浏览器→CF:HTTPS，CF→源站:HTTP:8080） |
| **Pages 构建** | 自动部署 `feat/cloudflare-split-deploy`，构建命令: `cd web && npm install --legacy-peer-deps && npm run build`，输出: `web/out` |
| **环境变量** | `NEXT_PUBLIC_API_BASE_URL` = `https://api.asac.cc` |
| **关键设置** | 无 Transform Rules、无 Workers、无 Page Rules |

### Docker Hub

| 项目 | 值 |
|------|-----|
| **用户名** | `fairyfox` |
| **镜像** | `fairyfox/infinite-canvas-api` |
| **当前 tag** | `v18` |
| **登录** | `docker login -u fairyfox`，token 保存在 WSL `~/.docker/config.json` |

---

## 四、WSL 环境

| 项目 | 值 |
|------|-----|
| **发行版** | `Debian` |
| **工作目录** | `/mnt/c/Users/root/Documents/project/github/infinite-canvas` |
| **Docker** | 已安装，已登录 fairyfox |

### Docker 构建命令

```bash
cd /mnt/c/Users/root/Documents/project/github/infinite-canvas
docker build -f Dockerfile.backend -t fairyfox/infinite-canvas-api:v19 .
docker push fairyfox/infinite-canvas-api:v19
```

### 部署命令

```bash
ssh root@nas.asac.cc
cd /vol1/1000/docker-compose/image
sed -i 's/:v18/:v19/' docker-compose.yml
docker pull fairyfox/infinite-canvas-api:v19
docker compose -f docker-compose.yml down && docker compose -f docker-compose.yml up -d
```

---

## 五、前端本地开发

```bash
cd /c/Users/root/Documents/project/github/infinite-canvas/web
NEXT_PUBLIC_API_BASE_URL="https://api.asac.cc" bun run dev -p 3333
```

---

## 六、架构图

```
浏览器
  │
  ├── Cloudflare Pages (image.asac.cc) — 静态文件
  │       └── canvas 路由通过 _redirects SPA 回退: /canvas/* → /canvas/_/  200
  │
  └── Cloudflare DNS + Origin Rule (api.asac.cc)
        │  Flexible SSL, 端口 8080
        │  IPv6 连接 NAS
        ▼
      NAS (catnas) :8080
        │  network_mode: host, Go 后端
        │  CORS: Origin 回显，v1 路径检测去重
        │  Async: /images/{generations,edits}/async + GET /images/tasks/:id
        │  Sync:  /images/{generations,edits} (本地渠道)
        │
        ├── /api/v1/* → One API (api.openxs.top / minitoken.top) → AI 模型
        │                  One API 设 CORS *, Go 去重
        └── 其他 /api/* → Go 直接处理
```

---

## 七、关键配置说明

### CORS（router/router.go）

- 所有响应设置完整 CORS 头（Origin 回显）
- `/api/v1/*` 路径：One API 也会设 `Access-Control-Allow-Origin: *`
- 如果检测到重复值，Go 删除自己的 fallback，保留 One API 的值

### 异步图片生成（handler/ai.go + service/image_task.go）

- `POST /api/v1/images/generations/async` — 提交任务，秒回 `{taskId}`
- `POST /api/v1/images/edits/async` — 改图异步版
- `GET /api/v1/images/tasks/:id` — 轮询状态
- 后台 goroutine 调上游（5 分钟超时），成功存 body，失败退费
- 前端 remote 模式自动走异步；local 模式保持同步

### 前端关键文件

| 文件 | 作用 |
|------|------|
| `web/src/services/api/image.ts` | 图片 API（异步轮询 + Gemini/tool 类型） |
| `web/src/stores/use-config-store.ts` | 配置 store（banana 关键词 + apiFormat/modelOptionName） |
| `web/src/services/api/request.ts` | API 请求工具（API_BASE 前缀） |
| `web/src/app/layout.tsx` | 根布局（暗色默认 + beforeInteractive 主题脚本） |
| `web/src/app/(user)/canvas/[id]/page.tsx` | 画布页（generateStaticParams + shell） |
| `web/src/app/(user)/canvas/[id]/canvas-page-shell.tsx` | 画布壳（dynamic ssr:false） |
| `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx` | 画布客户端（ID 提取 + Agent 支持） |
| `web/src/app/(user)/canvas/page.tsx` | 画布列表（500ms persist 延迟 + agent 模式） |

### 镜像标签

模型分类关键词：Go: `seedream/gpt-image/image/banana`；TS 额外: `dall-e/dalle/imagen/flux/sdxl/stable-diffusion/midjourney`

---

## 八、常用操作速查

### 查看后端日志
```bash
ssh root@nas.asac.cc "docker logs infinite-canvas-api --tail 50 2>&1 | grep -v 'prompt sync\|prompts-\|raw.git'"
```

### 查看 AI 异步任务日志
```bash
ssh root@nas.asac.cc "docker logs infinite-canvas-api 2>&1 | grep 'AI async'"
```

### 测试后端公网连通性
```bash
curl -s https://api.asac.cc/api/health
```

### 拉取上游代码
```bash
git fetch upstream && git merge upstream/main --no-edit
# 处理冲突后：
#   - Go 文件 → git checkout --ours <file>
#   - 前端文件 → 保留我们的修复 + 手动加回

git push origin feat/cloudflare-split-deploy
```

### 构建新版本
```bash
# 1. 修改代码
# 2. 编译检查
go build -o /dev/null .

# 3. WSL 构建 Docker
wsl bash -c "cd /mnt/c/Users/root/Documents/project/github/infinite-canvas && docker build -f Dockerfile.backend -t fairyfox/infinite-canvas-api:vXX . && docker push fairyfox/infinite-canvas-api:vXX"

# 4. 部署 NAS
ssh root@nas.asac.cc "cd /vol1/1000/docker-compose/image && sed -i 's/:vXX-1/:vXX/' docker-compose.yml && docker pull fairyfox/infinite-canvas-api:vXX && docker compose -f docker-compose.yml down && docker compose -f docker-compose.yml up -d"

# 5. 提交前端
git add -A && git commit -m "..." && git push
# Cloudflare Pages 自动部署前端
```
