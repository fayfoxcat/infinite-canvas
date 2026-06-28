# 构建 Next.js 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建 Go 后端入口。
FROM golang:1.25-alpine AS api-build

WORKDIR /app
COPY go.mod go.sum ./
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN CGO_ENABLED=0 go build -o /server .

# 运行镜像：Nginx 对外监听 3000，Go 只在容器内部监听 8080。
FROM nginx:1.29-alpine

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY --from=api-build /app/config /app/config
COPY --from=web-build /app/web/out /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
ENV PORT=8080
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN apk add --no-cache ca-certificates tzdata && mkdir -p /app/data/prompts

EXPOSE 3000
# 先启动内部 Go API，再由 Nginx 提供静态页面并代理 /api/*。
CMD ["sh", "-c", "PORT=8080 /app/server & nginx -g 'daemon off;'"]
