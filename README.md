# 建议投票系统

给游戏做的一个玩家建议收集站。玩家提交建议，你审核通过后它变成投票选项，票数高的排前面，做完的进「已实现」列表。

像素风界面，单个 Node 进程加一个 SQLite 文件，不依赖任何外部服务。

![首页](docs/screenshot-home.png)

## 快速开始

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

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，只在反代后面可以设 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据目录 |
| `BACKUP_DIR` | `./backups` | 备份目录 |
| `TRUST_PROXY` | `0` | 放在 Nginx / Caddy 后面必须设 `1` |
| `SESSION_DAYS` | `7` | 后台会话有效期（天） |
| `BACKUP_KEEP` | `14` | 保留多少份备份 |
| `NODE_ENV` | `development` | 设 `production` 会开启静态资源长缓存 |

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

```bash
node scripts/reset-password.js 新密码
# Docker
docker compose exec app node scripts/reset-password.js 新密码
```

不带参数会交互式提示输入。重置后所有后台会话失效。

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

105 项检查，覆盖玩家端和后台的全部主要流程以及 15 个页面的渲染。测试数据邮箱后缀是 `@smoke.test`，会写进当前数据库。

默认用 `smoke-admin-2026` 登录后台，密码不一样的话用环境变量传：

```bash
SMOKE_ADMIN_PASSWORD=你的密码 node scripts/smoke-test.js
```

## 目录结构

```
src/
  app.js              Express 启动、路由装配、优雅退出
  config.js           配置，支持环境变量覆盖
  db.js               建表、查询封装、事务、审计日志
  util.js             校验、清洗、scrypt 密码哈希
  template.js         服务端模板，{{变量}} 和 {{> partial}}
  backup.js           VACUUM INTO 备份和定时任务
  middleware/         IP 限频、封禁检查、后台会话、CSRF
  routes/             玩家端 API 和后台 API
public/
  *.html              玩家端页面
  partials/           顶栏、页脚、后台导航
  css/                pixel.css 设计系统，site.css，admin.css
  js/                 玩家端脚本
  admin/              后台页面和脚本
  fonts/              Fusion Pixel 中文像素字体
docs/                 设计说明和界面截图
scripts/              backup、reset-password、seed-demo、smoke-test
deploy/               systemd 服务和 Nginx 配置模板
data/                 运行时数据，数据库和上传的截图
backups/              自动备份
```

前端没有构建步骤，改完 HTML / CSS / JS 刷新浏览器就行。

数据库结构、状态流转、接口清单和几个实现细节在 [docs/DESIGN.md](docs/DESIGN.md)。

## 字体

中文像素字用的是 [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)，SIL Open Font License 1.1，可以商用。许可证原文在 `public/fonts/OFL.txt`。

## 许可

代码用 MIT，见 [LICENSE](LICENSE)。字体走的是另一套许可，上面那行。
