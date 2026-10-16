# 建议投票系统

给游戏做的一个玩家建议收集站。玩家提交建议，你审核通过后它变成投票选项，票数高的排前面，做完的进「已实现」列表。

像素风界面。两种跑法，业务代码是同一份：

| 方式 | 数据落在哪 | 需要准备什么 |
| --- | --- | --- |
| 本机 / 服务器跑 Node | 一个 SQLite 文件 | 一台能跑 Node 的机器 |
| Cloudflare Workers | Durable Object 内置的 SQLite | 一个 Cloudflare 账号，免费计划够用 |

前端没有构建步骤，后端除 Express 外没有别的运行时依赖。

![首页](docs/screenshot-home.png)

## 本机跑起来

Node.js 22.5 以上（用到内置的 `node:sqlite`）。

```bash
npm install
npm start
```

打开 http://localhost:3210 ，后台在 http://localhost:3210/admin 。第一次进后台会让你设置管理员密码，设完直接进去。

想先看看有数据的样子：

```bash
node scripts/seed-demo.js
```

会灌入 80 个玩家、17 条建议、300 多张票，覆盖待审、投票中、已拒绝、已实现四种状态。清空的话删掉 `data/vote.db` 重启，会自动建空库。

## Docker

```bash
docker compose up -d --build
```

一样是 http://localhost:3210 。

数据库和上传的截图在 `./data`，自动备份在 `./backups`，拷这两个目录就是完整备份。

不用 compose：

```bash
docker build -t game-suggestion-vote .
docker run -d --name vote-board \
  -p 3210:3210 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/backups:/app/backups" \
  -e TRUST_PROXY=1 \
  --restart unless-stopped \
  game-suggestion-vote
```

容器以非 root 用户运行。bind mount 的目录在首次启动时会自动修正所有权，不用手动 chown。

## Cloudflare Workers

不用服务器，一条命令部署上去。用的是免费计划能覆盖的三样东西：Workers（请求）、Durable Objects（数据）、Static Assets（前端资源）。

```bash
npx wrangler login     # 只需一次，浏览器里授权
npx wrangler deploy
```

部署完会给你一个 `https://<名字>.<你的子域>.workers.dev` 地址。绑自己的域名在 Cloudflare 后台 Workers 那一页加 Custom Domain。

没装 wrangler 也没关系，`npx` 会临时取一份；也可以 `npm run worker:deploy`，效果一样。

本机预览（不占线上资源，数据存在 `.wrangler/` 下）：

```bash
npx wrangler dev
```

**数据放在哪**：全部在 Durable Object 内置的 SQLite 里，包括首页截图（存成 BLOB）。整个站只起一个 DO 实例，写操作天然串行——和 Node 版「一个进程一个文件」的模型一致，所以两边共用同一套数据层代码。

**免费额度**：每天 10 万请求、DO 存 5GB、定时任务自带。这个量级对建议投票站很宽裕。

**备份**：Cloudflare 对 SQLite 类型的 Durable Object 自带 30 天时间点恢复，改错了可以回滚到任意时刻，比自己做快照更省事。见 [官方文档](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)。

**忘记管理员密码**：Workers 上没有能直接改数据库的命令行，所以另留了一条凭令牌自救的入口。先用命令设一个令牌：

```bash
npx wrangler secret put RESET_TOKEN        # 自己编一串长随机字符
```

然后：

```bash
curl -X POST https://<你的地址>/api/admin/force-reset \
  -H "x-reset-token: 刚才那串" \
  -H "Content-Type: application/json" \
  -d '{"password":"新的管理员密码"}'
```

没设 `RESET_TOKEN` 时这个接口直接返回 404，等于不存在。

**密码哈希的迭代次数**：`wrangler.jsonc` 里的 `PBKDF2_ITERATIONS` 默认 100000。这是给免费计划调过的值——实测 DO 里的调用不受 Worker 那 10ms CPU 限制，跑得动。如果哪天登录开始报 CPU 超限，把它调到 `50000` 或 `25000` 再部署。次数写在哈希串里，改这个不会让已有密码失效（代价是已有密码仍按老次数校验）。

**想从头开始**：删掉 Worker 再部署，Durable Object 的存储会跟着清空。

```bash
npx wrangler delete --force && npx wrangler deploy
```

## 功能

玩家端：

| 页面 | 说明 |
| --- | --- |
| 首页 | 实时统计、热门建议 Top 3、游戏截图、公告 |
| 提交建议 | 昵称 + 邮箱 + 分类 + 标题 + 正文，带字数计数 |
| 投票榜 | 按票数排名，支持分类筛选、搜索、排序、分页 |
| 已实现 | 公开的荣誉榜，显示实现说明 |
| 查我的建议 | 凭邮箱查状态、票数，以及被拒绝的理由 |

后台：

| 页面 | 说明 |
| --- | --- |
| 仪表盘 | 统计卡片、7/14/30/60 天趋势图、票数榜、可疑 IP |
| 待审核 | 审核队列，快捷键 `A` 通过 / `R` 拒绝 / `E` 编辑 / `J` `K` 上下移动 |
| 建议管理 | 按状态、分类、关键词筛选，编辑，软删除与恢复 |
| 已完成 | 写实现说明，撤销完成 |
| 投票明细 | 每张票的 IP、邮箱、时间、UA，可单删或按 IP / 邮箱批量清理 |
| 玩家管理 | 玩家列表、行为详情、封禁解封、清空某人的投票 |
| 封禁名单 | 邮箱和 IP 黑名单 |
| 站点设置 | 文案、分类、首页截图、功能开关、限频阈值、改密码 |
| 操作日志 | 后台动作留痕，保留 180 天 |

## 配置

环境变量（Node 方式）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，只在反代后面可以设 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据目录 |
| `BACKUP_DIR` | `./backups` | 备份目录 |
| `TRUST_PROXY` | `0` | 放在 Nginx / Caddy 后面必须设 `1` |
| `SESSION_DAYS` | `7` | 后台会话有效期（天） |
| `BACKUP_KEEP` | `14` | 保留多少份备份 |
| `RESET_TOKEN` | 空 | 设了才开放忘记密码时的自救入口，见 Cloudflare 那一节 |
| `NODE_ENV` | `development` | 设 `production` 会开启静态资源长缓存 |

Workers 方式只有两个变量，都在 `wrangler.jsonc` 的 `vars` 里：`SESSION_DAYS` 和 `PBKDF2_ITERATIONS`；`RESET_TOKEN` 走 `wrangler secret put`，不要写在配置文件里。

`TRUST_PROXY` 是唯一一个配错了会有隐蔽后果的：不开的话服务只能看到反代的地址，按 IP 限频和 IP 封禁全部失效，而且后台显示的 IP 都是 127.0.0.1。

下面这些在后台「站点设置」里改，改完即时生效，不用重启：

- 游戏名、站点标题、宣传语、副标题、公告、页脚
- 建议分类（最多 12 个）
- 首页截图（最多 8 张，单张 2MB）
- 是否允许提交建议、是否允许投票
- 限频：投票/小时/IP、提交/天/邮箱、提交/天/IP、新号/天/IP
- 标题和正文的字数上限
- 投票榜默认排序

## 部署

### Docker Compose

```bash
git clone https://github.com/Creator2K/game-suggestion-vote.git
cd game-suggestion-vote
docker compose up -d --build
```

### 直接跑 Node

```bash
npm install --omit=dev
PORT=3210 TRUST_PROXY=1 npm start
```

配成 systemd 服务，模板在 `deploy/vote-board.service`：

```bash
sudo cp deploy/vote-board.service /etc/systemd/system/
sudo nano /etc/systemd/system/vote-board.service    # 改 User 和路径
sudo systemctl daemon-reload
sudo systemctl enable --now vote-board
journalctl -u vote-board -f
```

### Nginx 反代

模板在 `deploy/nginx.conf.example`，里面给了反代和 HTTPS 两段。

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/vote-board
sudo nano /etc/nginx/sites-available/vote-board     # 改成你的域名
sudo ln -s /etc/nginx/sites-available/vote-board /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d vote.example.com
```

`client_max_body_size` 要给到 `8m`。上传的截图限制是 2MB，但经过 base64 编码后会变大，配小了会返回 413。

## 备份与恢复

这一节只针对 Node 方式。Workers 方式的数据在 Durable Object 里，用平台自带的 30 天时间点恢复，不需要这套脚本。

服务每天凌晨 3 点后自动备份一次，用 SQLite 的 `VACUUM INTO`，不停服也不会拷到写了一半的数据。保留最近 14 份，放在 `backups/`。重启服务不会重复备份，它靠当天有没有备份文件来判断。

手动备份：

```bash
npm run backup
# Docker
docker compose exec app node scripts/backup.js
```

恢复：

```bash
docker compose down
cp backups/vote-20261016-030012.db data/vote.db
rm -f data/vote.db-wal data/vote.db-shm
docker compose up -d
```

系统的状态只有数据库和上传的截图两块，都在 `data/` 里。

## 关于防刷

系统不做邮箱验证，玩家填个邮箱就算注册。上手最快，代价是拦不住存心刷票的人，编个邮箱就能再来一票。

现在有的限制：

- 同一邮箱对同一条建议只能投一票，靠数据库唯一索引强制，应用层绕不过去
- 同一 IP 每小时最多投 30 票，每天最多提交 20 条建议
- 同一 IP 每天最多注册 10 个新账号，用来堵批量造号绕过上一条
- 昵称全局唯一，写操作前检查黑名单
- 每张票记录 IP 和 User-Agent

后台仪表盘会列出投票数异常偏高的 IP。确认是刷票后，去「投票明细」按 IP 批量清理，再到「玩家管理」封号，最后回仪表盘点一下「重算票数」。

真要防住只有加邮箱验证一条路。加的话改动集中在提交和投票这两个接口的前置校验，加一张验证码表。

## 常见问题

**忘记管理员密码**

Node 方式：

```bash
node scripts/reset-password.js 新密码
# Docker
docker compose exec app node scripts/reset-password.js 新密码
```

Workers 方式没有能直接改数据库的命令行，用 `RESET_TOKEN` 那条接口，见上面 Cloudflare 那一节。

不带参数运行上面的脚本会交互式提示输入。重置后所有后台会话失效。

**提示「密码存储格式已升级」**

老版本用 scrypt 存管理员密码，换成 PBKDF2 之后认不出来，会明确提示而不是含糊地说密码错误。按上面重置一次即可。

**打开 /admin 没输密码就进去了**

早期版本后台页面在服务端不挡，只靠页面里的脚本判断登录状态，浏览器还可能把「已登录」的接口响应缓存下来，于是能看到后台的页面骨架。现在除登录页外的后台页面都会先查会话，没会话直接跳 `/admin/login`，接口响应也统一带 `Cache-Control: no-store`。浏览器里如果还留着旧缓存，强制刷新一次（或清一下站点数据）即可。

**排行榜票数和实际对不上**

正常情况下不会。手动改过数据库的话，去仪表盘点「重算票数」。

**上传截图返回 413**

反代的 `client_max_body_size` 太小，调到 `8m`。

**后台看到的 IP 全是 127.0.0.1**

`TRUST_PROXY` 没开。

**中文不是像素字**

字体没加载成功。确认 `public/fonts/` 下两个 woff2 文件在，以及浏览器控制台里这两个请求返回 200。

**想跑一遍自测**

```bash
npm start                     # 一个终端
node scripts/smoke-test.js    # 另一个终端
```

107 项检查，覆盖玩家端和后台的全部主要流程、15 个页面的渲染、模板文件不外泄，以及页面上引用的脚本和样式都能取到。同一套测试也能打向 Workers：

```bash
npx wrangler dev                                  # 一个终端
BASE=http://127.0.0.1:8787 node scripts/smoke-test.js
```

测试数据邮箱后缀是 `@smoke.test`，会写进当前数据库。

默认用 `smoke-admin-2026` 登录后台，密码不一样的话用环境变量传：

```bash
SMOKE_ADMIN_PASSWORD=你的密码 node scripts/smoke-test.js
```

## 目录结构

```
src/                  两个运行时共用的业务代码
  db.js               建表、查询封装、事务、审计日志（引擎由运行时注入）
  util.js             校验、清洗、PBKDF2 密码哈希
  template.js         服务端模板，{{变量}} 和 {{> partial}}
  runtime.js          运行时插槽：截图存储、会话期限、重置令牌
  routes/             玩家端 API 和后台 API（导出挂载函数，两个宿主共用）
  middleware/         IP 限频、封禁检查、后台会话、CSRF
  engines/            Node 侧数据引擎（node:sqlite）
  stores/             Node 侧截图存储（写磁盘）
  loaders/            Node 侧模板来源（读 public/）
  node-boot.js        Node 侧的装配入口
  app.js              Express 启动、路由装配、优雅退出
  config.js           配置，支持环境变量覆盖
  backup.js           VACUUM INTO 备份和定时任务

worker/               Cloudflare Workers 侧
  index.js            入口：路由分流、Cron
  board.js            Durable Object，一个实例装整个站
  app.js              装配中间件、页面、接口（与 src/app.js 对应）
  mini-router.js      Express 兼容层，让上面的路由不用改就能在 Workers 上跑
  engines/do-sql.js   DO SQLite 数据引擎
  stores/do-blob.js   截图存进 DO
  loaders/            模板从 Static Assets 读

public/               前端（两个运行时共用同一份模板和资源）
  *.html              玩家端页面，模板占位符由服务端注入
  partials/           顶栏、页脚、后台导航
  css/                pixel.css 设计系统，site.css，admin.css
  js/                 玩家端脚本
  admin/              后台页面和脚本
  fonts/              Fusion Pixel 中文像素字体
docs/                 设计说明和界面截图
scripts/              backup、reset-password、seed-demo、smoke-test
deploy/               systemd 服务和 Nginx 配置模板
wrangler.jsonc        Workers 的绑定、静态资源、定时任务配置
data/                 Node 方式的运行时数据，数据库和上传的截图
backups/              Node 方式的自动备份
```

前端没有构建步骤，改完 HTML / CSS / JS 刷新浏览器就行。

数据库结构、状态流转、接口清单和几个实现细节在 [docs/DESIGN.md](docs/DESIGN.md)。

## 字体

中文像素字用的是 [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)，SIL Open Font License 1.1，可以商用。许可证原文在 `public/fonts/OFL.txt`。

## 许可

代码用 MIT，见 [LICENSE](LICENSE)。字体走的是另一套许可，上面那行。
