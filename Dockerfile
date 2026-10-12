# GitHubRadar 容器镜像。
#
# 版本策略：基础镜像 node:slim 与 pnpm 均取构建时最新稳定版，依赖版本范围见各
# package.json（^ 区间）；可复现性由 pnpm-lock.yaml（--frozen-lockfile）提供。
#
# 运行期布局（CMD 与模块的相对路径解析依赖此布局）：
#   /app/node_modules        仅生产依赖（含 @githubradar/contracts）
#   /app/server/dist         服务端编译产物（CMD 入口）
#   /app/server/migrations   SQL 迁移（dist/db/migrate.js 以 ../../migrations 解析）
#   /app/web/dist            前端静态资源（服务端以 ../../web/dist 解析）
#   /data                    SQLite 数据卷挂载点（由 compose 挂载）

# ---------------------------------------------------------------------------
# 阶段 1：依赖安装（workspace 全量，构建需要 typescript/vite 等 devDependencies）
# ---------------------------------------------------------------------------
FROM node:slim AS build-base

# 显式安装最新版 pnpm（新版 Node 发行包不再保证自带 corepack）。
RUN npm install --global --no-fund --no-audit pnpm@latest

ENV CI=true
WORKDIR /repo

# 先只放 workspace 清单与 lockfile，让依赖层可以独立缓存；
# tests/package.json 必须在场：workspace 声明了该 importer，缺清单会让 --frozen-lockfile 失败。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tests/package.json tests/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 阶段 2：编译 contracts → server / web
# ---------------------------------------------------------------------------
FROM build-base AS build

# 产物一律在容器内重新生成，不复用宿主机的构建结果（.dockerignore 已排除 node_modules 与 **/dist）。
COPY . .

RUN pnpm --filter @githubradar/contracts run build \
 && pnpm --filter @githubradar/server run build \
 && pnpm --filter @githubradar/web run build

# ---------------------------------------------------------------------------
# 阶段 3：生产依赖（pnpm deploy 产出 @githubradar/server 的自包含目录）
# ---------------------------------------------------------------------------
FROM build AS prod-deps

# deploy 把 server 及其生产依赖（含 workspace 包 contracts）复制成 /out/server 自包含目录，
# 并把 workspace:* 软链落地为真实目录；`pnpm install --prod` 保留跨包软链布局，做不到这一点。
RUN pnpm --filter @githubradar/server deploy --prod /out/server

# ---------------------------------------------------------------------------
# 阶段 4：运行镜像
# ---------------------------------------------------------------------------
FROM node:slim AS runtime

ENV NODE_ENV=production

# 非 root 运行：UID/GID 10001 与 compose.yaml 的 user: "10001:10001" 一致；
# /data 预建目录只服务于不经 compose 的手工运行，compose 会用 ./data 覆盖。
RUN groupadd --gid 10001 githubradar \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /home/githubradar --shell /usr/sbin/nologin githubradar \
 && install -d -o 10001 -g 10001 -m 0750 /data

# better-sqlite3 自带各平台 prebuilds（gypfile=false、无 install 脚本），无需编译工具链。

# 工作目录固定为 /：数据库路径是相对路径 data/githubradar.sqlite，容器内即数据卷 /data。
WORKDIR /

# 仅生产依赖；/app/server/dist 下的模块按 Node 解析规则向上一级命中这里。
COPY --from=prod-deps /out/server/node_modules /app/node_modules
# package.json 必须保留：其中 "type": "module" 决定 dist/*.js 以 ESM 解析。
COPY --from=prod-deps /out/server/package.json /app/server/package.json
COPY --from=prod-deps /out/server/dist /app/server/dist
COPY --from=prod-deps /out/server/migrations /app/server/migrations
# 前端静态资源；服务端以 ../../web/dist 相对 dist/ 解析。
COPY --from=build /repo/apps/web/dist /app/web/dist

USER 10001:10001
EXPOSE 8080

# 健康检查由 compose.yaml 统一提供（探测本机 ready 接口），保持单一来源。
CMD ["node", "/app/server/dist/main.js"]
