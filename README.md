# Github雷达

探测多个 GitHub 仓库的正式 Release、可选预发布与指定分支变化；另有一个按日导入外部候选的“项目发现”页。

## Docker 部署

```bash
mkdir -p data
sudo chown 10001:10001 data     # 容器以 UID/GID 10001 运行
cp .env.example .env            # 至少确认 PUBLIC_ORIGIN

docker compose build
docker compose up -d
docker compose logs -f --tail=100 githubradar   # 随机初始密码只出现一次

curl -sS http://127.0.0.1:8080/health/live
curl -sS http://127.0.0.1:8080/health/ready
```

| 变量 | 说明 |
|---|---|
| `PUBLIC_ORIGIN` | 必须与浏览器地址栏的 scheme/host/port 完全一致；`localhost` 与 `127.0.0.1` 不互换。非回环明文 HTTP 只给公开只读面板（含私有仓库名），管理需 HTTPS |
| `BIND_ADDRESS` | 默认 `127.0.0.1`，远程访问走反代指向它 |
| `TRUSTED_PROXY` | 反代后面必配（如 `127.0.0.1,::1`），否则登录限速全站共用一桶 |
| `PORT` | 容器监听端口，默认 `8080`；宿主端口映射自动同值跟随 |
| `TZ` | 默认 `Asia/Shanghai`，影响日志时间与看板时间判定 |

## 重置密码

初始管理员密码由系统随机生成，只在**首次启动日志打印一次**。

```bash
docker compose build && docker compose up -d                                      # 升级；./data 原样保留
docker compose exec githubradar node /app/server/dist/cli/reset-password.js      # 重置密码，撤销全部会话
```

## 本地开发

```bash
pnpm install --frozen-lockfile    # Node >=26、pnpm 12+
pnpm run build                    # contracts → server / web
pnpm run typecheck                # 内含一次 build

mkdir -p data                     # 数据库固定为 ./data/githubradar.sqlite
PUBLIC_ORIGIN=http://127.0.0.1:8080 \
HOST=127.0.0.1 \
node apps/server/dist/main.js

pnpm run test                     # 构建 + 单元 + 集成
cd tests && pnpm run e2e          # 端到端：桌面 + 手机
```

```powershell
New-Item -ItemType Directory -Force data
$env:PUBLIC_ORIGIN='http://127.0.0.1:8080'
$env:HOST='127.0.0.1'
node apps/server/dist/main.js
```

前端由服务端同源提供，改前端要重新 `pnpm run build`。

## 页面与使用

| 路径 | 内容 | 访问 |
|---|---|---|
| `/` | 仓库看板：Release、预发布、分支 HEAD、Star/Fork 趋势 | 公开只读；管理需登录 |
| `/discover` | 项目发现：按日导入的外部候选，不自动加入监控 | 公开只读；加入监控需登录 |
| `/settings` | Token、代理、默认档位、标签、密码 | 管理员 |
| `/jobs` | 任务列表、配额与诊断（含发现导入状态） | 管理员 |

容器内配代理时 `127.0.0.1` 指容器自身，用宿主机 IP 或 Docker 网关（Linux 默认 `172.17.0.1`）。

## 排障

| 现象 | 原因 |
|---|---|
| 启动即退出 `ConfigError` | `PUBLIC_ORIGIN` 缺失或取值非法；同名 shell 变量覆盖 `.env` |
| `/data` 权限拒绝 | `sudo chown -R 10001:10001 data` 后重启 |
| 登录提示需 HTTPS | `PUBLIC_ORIGIN` 是非回环明文 HTTP |
| Origin / CSRF 报错 | 浏览器地址与 `PUBLIC_ORIGIN` 不一致 |
| `APP_KEY_INVALID` | 主密钥长度异常；`reset-password.js --clear-credentials` 后在设置页重配凭证 |
| 迁移失败 | 按 `MIGRATION_*` 错误码修复，不要删库 |
| 长期 `unhealthy` | 查 `docker compose logs githubradar` |
| 容器 `healthy` 但数据不动 | Token 未验证或 GitHub 不可达；探针只查本地 |
| 项目发现长期空白 | 首次导入在服务启动后自动执行、失败按 30 分钟重试；仍空白时看“任务与诊断”页的「发现导入」行——`SOURCE_DATA_ANOMALY` 多为容器访问不了 `raw.githubusercontent.com`（该主机不在监控采集路径上，需要配代理） |
