# 设计说明

## 两个运行时

同一套业务代码跑在两个差异很大的宿主上：

```
                 src/routes/*  src/middleware/*  src/db.js  src/util.js  src/template.js
                        │            │              │           │            │
        ┌───────────────┴────────────┴──────────────┴───────────┴────────────┴───────────────┐
        │                    共用层（不含任何 node: 内置模块）                                │
        └───────────────┬───────────────────────────────────────────┬───────────────────────┘
                        │                                           │
        ┌───────────────▼───────────────┐           ┌───────────────▼───────────────────────┐
        │ Node：Express + node:sqlite    │           │ Workers：mini-router + DO SQLite      │
        │ 截图写磁盘，模板读 public/     │           │ 截图进 DO，模板读 Static Assets       │
        └───────────────────────────────┘           └───────────────────────────────────────┘
```

共用层不引用 `node:fs`、`node:sqlite`、`node:crypto`，也不 require Express，靠三个插槽把宿主差异注入进来：

| 插槽 | Node 注入 | Workers 注入 |
| --- | --- | --- |
| 数据引擎 `db.install()` | `src/engines/node-sqlite.js` | `worker/engines/do-sql.js` |
| 截图存储 `runtime.configure()` | `src/stores/fs.js`（写磁盘） | `worker/stores/do-blob.js`（BLOB 进 DO） |
| 模板来源 `template.setLoader()` | `src/loaders/fs-views.js`（读 public/） | `worker/loaders/assets-views.js`（读 ASSETS 绑定） |

数据引擎的接口只有 5 个方法（`all` / `get` / `run` / `exec` / `transaction`），两个实现各自吸收本宿主的怪癖：Node 侧管 prepared statement 缓存和 `BEGIN IMMEDIATE`，Workers 侧把事务交给 `ctx.storage.transactionSync()`，并用 `changes()` 而不是游标的 `rowsWritten` 来取受影响行数——后者会把 `ON CONFLICT DO NOTHING` 忽略掉的写入也算进去，用它判重复投票会漏判。

**路由为什么能共用。** `src/routes/*.js` 导出的是一个「传入 router 的挂载函数」而不是 router 实例，Node 传 Express Router，Workers 传 `worker/mini-router.js`。这个兼容层只实现项目实际用到的那部分 Express：`get/post/put/patch/delete/use`、`req.body/query/params/headers/get()/ip`、`res.status()/json()/set()/append()/type()/send()`、`next()` 与 4 参数错误中间件。挂载在 build 时展开成一张扁平表，顺序不变；子路由里不带路径的 `use` 会被收窄成该前缀，否则 `requireAdmin` 会误伤所有路径。

**为什么用单个 Durable Object 而不是 D1。** 原版是「一个进程 + 一个 SQLite 文件」，写操作天然串行、事务简单。DO 也是单实例串行执行，模型一致，所以数据层几乎原样搬得动；D1 是多写者的异步模型，要改的地方多得多。代价是所有请求排同一个实例，对建议投票站这个量级够用。

**与 Workers 相关的几个取舍。**

- 截图存进 DO 的 BLOB，不引入 R2：最多 8 张 2MB 的首页图，省一个服务也省一套权限。
- 模板仍放在 `public/`，由 DO 通过 ASSETS 绑定内部读取（不走网络、不计请求数）。入口把 `*.html` 的直连请求挡成 404，避免别人抓到带 `{{占位符}}` 的原文。
- 原来的 `setInterval` 清理改成 Cron Trigger（`0 3 * * *`）驱动 DO 的方法。
- 备份换成平台自带的 30 天时间点恢复，`VACUUM INTO` 那套只在 Node 侧保留。
- 口令哈希必须换掉：免费计划单次调用只有 10ms CPU，scrypt（N=16384）实测 29ms 会被掐断。换成 PBKDF2-SHA256，迭代次数写进哈希串（`pbkdf2-sha256$<次数>$<哈希>`），改参数不会让已有密码失效。实测 DO 里的调用不受那 10ms 限制，所以 100000 次迭代跑得动；真被限了就把 `PBKDF2_ITERATIONS` 调低。
- Workers 上没法用命令行改数据库，另留了 `POST /api/admin/force-reset`，凭 `RESET_TOKEN` 改密码；令牌没配置时该接口返回 404。

## 数据模型

SQLite，七张表。建表语句在 `src/db.js`。

### players

玩家身份就是邮箱。首次提交或投票时如果有昵称就建档，之后只认邮箱。

| 字段 | 说明 |
| --- | --- |
| `email` | 唯一，入库前统一转小写 |
| `nickname` | 唯一，`COLLATE NOCASE`，防止 `Admin` 和 `admin` 同时存在 |
| `last_seen_at` / `last_ip` | 最近一次活动，用于后台排查 |
| `banned` / `ban_reason` / `banned_at` | 封禁状态 |

### suggestions

一条建议就是一个投票选项。

| 字段 | 说明 |
| --- | --- |
| `status` | `pending` / `approved` / `rejected` / `done` |
| `reject_reason` | 拒绝理由，玩家在「查我的建议」能看到 |
| `admin_note` | 后台备注。只在 `status = done` 时作为「实现说明」公开，其他状态不外泄 |
| `vote_count` | 票数缓存，排行榜排序用，避免每次 `COUNT(*)` |
| `deleted_at` | 软删除，后台可以按「已删除」筛选并恢复 |

索引：`(status, deleted_at, vote_count DESC, created_at ASC)` 覆盖排行榜查询。

### votes

| 字段 | 说明 |
| --- | --- |
| `suggestion_id` + `player_id` | `UNIQUE` 约束 |
| `ip` / `user_agent` | 留痕，后台识别刷票 |
| `created_at` | 趋势图数据源 |

重复投票由这个唯一索引强制，不靠应用层判断。写入用 `INSERT ... ON CONFLICT DO NOTHING`，`changes` 为 0 就是重复投票，然后才更新 `vote_count`，一个事务里完成。

### 其余

- `settings` — 键值对，存站点配置和管理员密码哈希。首次启动写入默认值，用 `INSERT OR IGNORE` 保证新增配置项能补进已有库
- `admin_sessions` — 后台会话 token，登录时清空旧会话
- `audit_log` — 后台动作留痕，保留 180 天
- `bans` — 邮箱和 IP 黑名单，`UNIQUE(kind, value)`
- `ip_events` — 限频事件。落库而不是放内存，重启后限频不会失效
- `ai_review_batches` — AI 审核的一轮。`cursor_id` 是这一轮扫到哪儿的游标，`remaining` 是还剩多少条，跑完才写 `finished_at`
- `ai_review_actions` — AI 审核的每一条动作，撤销全靠它（记着原来的状态和依据的那条建议）
- `ai_vectors` — 建议的向量，`b64` 是 Float32 小端的 base64。用 TEXT 存是为了绕开两个运行时对 BLOB 绑定/读回类型的不一致（node:sqlite 给 Uint8Array，DO 给 ArrayBuffer）

## 状态流转

```
        提交              审核通过
   ──────────→ pending ──────────→ approved ──标记完成──→ done
                  │                                        │
                  └──审核拒绝──→ rejected ←──打回待审──┘
                                  │
                                  └──────── 撤销完成 ────────┘
```

可逆的操作都做了：`rejected` 能打回 `pending`，`done` 能撤销回 `approved`，软删除能恢复。

投票只允许针对 `approved`，`pending` 和 `done` 都会被拒绝。

## 接口

### 玩家端 `/api`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/config` | 站点配置，不含机密字段 |
| GET | `/stats` | 首页统计数字 |
| GET | `/suggestions` | 投票榜，支持 `category` `q` `sort` `page` `email` |
| GET | `/suggestions/:id` | 单条详情 |
| GET | `/top` | 首页热门 Top N |
| GET | `/done` | 已实现列表 |
| GET | `/mine?email=` | 凭邮箱查自己的建议和投过的票 |
| POST | `/submit` | 提交建议 |
| POST | `/vote` | 投票 |

传 `email` 给 `/suggestions` 时会额外返回 `voted` 字段，前端据此标记「已投票」。

### 后台 `/api/admin`

公开四个：`/state` 查初始化状态，`/setup` 首次设置密码（仅未初始化时可用），`/login`，以及凭重置令牌用的 `/force-reset`（未配置 `RESET_TOKEN` 时返回 404）。

其余全部需要登录，写操作还要过 CSRF：

| 分组 | 接口 |
| --- | --- |
| 会话 | `POST /logout`，`GET /me` |
| 仪表盘 | `GET /dashboard?days=` |
| 建议 | `GET /suggestions`，`GET/PATCH/DELETE /suggestions/:id`，`POST /suggestions/:id/{approve,reject,reopen,done,undone,restore}` |
| 投票 | `GET /votes`，`DELETE /votes/:id`，`POST /votes/purge` |
| 玩家 | `GET /players`，`GET /players/:id`，`POST /players/:id/{ban,unban,purge-votes}` |
| 封禁 | `GET /bans`，`POST /bans`，`DELETE /bans/:id` |
| 设置 | `GET/PUT /settings`，`POST /password` |
| 截图 | `POST /screenshots`，`DELETE /screenshots` |
| 日志 | `GET /logs` |
| 维护 | `POST /recount`，`POST /cleanup` |
| AI 审核 | `GET /ai/state`，`POST /ai/run`，`GET /ai/report?batch=`，`POST /ai/undo`，`POST /ai/undo-batch`，`POST /ai/resolve` |

## AI 一键审核

放在 [`src/ai/`](../src/ai/)，两个运行时共用同一套判定流程，差别只在"谁来判"：

| | 候选检索 | 判定 |
| --- | --- | --- |
| Workers | `@cf/baai/bge-m3` 算向量，取余弦相似度最高的几条 | `@cf/zai-org/glm-4.7-flash` 判断"这两条是不是一件事""这条是不是垃圾" |
| 本机 Node | 字符 2-gram 的 Dice 系数 | 同一套规则的字面版本（`local.js`） |

**为什么不让模型直接扫全库。** 建议多了以后把全部内容塞进上下文，又贵又不准（长上下文里模型会漏判）。所以是先算向量、检索出候选，再让模型只做判断题——一次调用只回答"是/不是"，结论可复现，出错了也能指着某一条说清楚为什么。

**一次运行 = 一个批次。** `ai_review_batches.cursor_id` 记录扫到哪条（按 id 升序，所以天然是"先来后到"），`remaining` 是还剩多少。点一次处理一批（默认 10 条），界面自动接着跑完。批次没跑完时再点会继续同一批，不会另起一轮——判断"要留哪条"依赖顺序，顺序断了结论就不成立。

**判定规则**（`review.js` 里的 `judge`）：

| 找到的相似项 | 处理 |
| --- | --- |
| 状态 `done` / `approved` | 模型确认是同一件事（置信度 ≥ 0.7）→ 直接拒绝，理由指向那条 |
| 状态 `pending` 且更早 | 保留更早的，拒绝晚的。待审建议没有票，所以按先来后到公平 |
| 状态 `pending` 但更晚 | 跳过。等轮到对方时再判，避免两条互相指认 |
| 状态 `rejected` / 已删除 | 只出候选。上次为什么被拒未必适用这一次 |
| 垃圾／广告／机器人 | 置信度 ≥ 0.8 → 拒绝并打 `ai_flag`；疑似机器人另外进封禁候选 |
| 模型没把握 | 一律降级成候选 |

**绝不自动封禁。** 封错一个 IP 可能挡住一整个学校或一栋楼的玩家，而且他们不会知道为什么。所以疑似机器人只写 `ban_hint`，报告页给「封禁邮箱」「封禁 IP」两个按钮，最终点下去的是人。这与限频、封禁那套明确规则的机制是分开的：AI 的结论只影响"看不看得见"，不影响"能不能进"。

**撤销。** 每个动作记着 `prev_status` 和依据的 `target_id`，所以能逐条撤销也能整轮回滚。撤销前会检查这条建议是否还停在"被 AI 拒绝"的状态——如果中途被人工改成别的状态，就拒绝撤销并提示，绝不覆盖人的决定。

**向量缓存。** `ai_vectors.fingerprint` 是"模型 + 标题 + 正文 + 分类"的短哈希，正文改了就重算，没改就直接复用。所以第二轮以后基本不花 embedding 的钱。单次运行补算向量的数量有上限（60 条），算不完下轮继续。

**成本控制。** 每条建议最多 1 次垃圾判定 + 2 次重复确认；一批默认 10 条；相似度门槛和每批条数都在设置里改。这些数字都是为了"一次请求别跑太久"定的，不是拍脑袋。

## 邮箱域名白名单

`suggestions` 之外的校验都在 `resolvePlayer` 里（`src/routes/public.js`）：提交和投票都会走到它，所以白名单只写一处。

**只拦新注册。** 库里已经有档的邮箱不受影响——规则是后来加的，不能把已经参与过的玩家锁在门外。设置项 `allowed_email_domains` 存成逗号分隔的规范化形式（小写、去掉 `@` 和协议头），空串表示不限制。

## 实现要点

**后台鉴权。** 单一管理员密码，PBKDF2-SHA256 加盐哈希存在 `settings` 里（迭代次数写在哈希串里），比对用定长比较。会话是随机 token 存表，通过 httpOnly + SameSite=Strict 的 Cookie 下发。（早期版本用 scrypt，为了在 Workers 免费计划上跑得动换掉了；老哈希认不出来，后台会明确提示去重置密码。）

**后台页面的守卫。** 除 `/admin/login` 外，后台页面在服务端就查会话，没有会话直接 302 回登录页——只靠页面里的脚本判断的话，任何人打开 `/admin` 都能拿到后台的页面骨架。接口响应统一带 `Cache-Control: no-store`，免得浏览器把「已登录」的状态缓存下来，页面在已登录和未登录之间来回跳。

**CSRF。** SameSite 之外再加一道：写操作必须带 `x-csrf-token` 头，值等于会话 token。跨站表单设不了自定义请求头，这一道足够。

**限频。** `ip_events` 记事件，查询时数时间窗口内的条数。只有操作成功后路由才写事件，所以失败的尝试不消耗额度。阈值从 `settings` 实时读，后台改完立即生效，不用重启。

**IP 获取。** Node 侧 `TRUST_PROXY=1` 时 Express 会依据 `X-Forwarded-For` 填 `req.ip`；Workers 侧兼容层优先取 `CF-Connecting-IP`，本地开发退到 `X-Forwarded-For`，最后落到 `127.0.0.1`，保证限频在本地也能测。`::ffff:127.0.0.1` 这类 IPv4-mapped 地址会被还原成 `127.0.0.1`，否则同一个 IP 会因为连接方式不同被记成两个值。

**模板。** `src/template.js` 是个几十行的实现，支持 `{{变量}}`（自动 HTML 转义）和 `{{> partial}}`（可嵌套）。站点文案在吐 HTML 时就注入，首页不会先闪默认文字再变。文件按 mtime 缓存——只对 Node 那个 loader 成立，Workers 侧模板随部署固定，直接进程内缓存。

**备份。** Node 侧用 `VACUUM INTO` 产生一致性快照，不用停服，也不会拷到写了一半的 WAL 数据；定时器靠「当天有没有备份文件」判断，重启不会重复备份。Workers 侧交给平台的时间点恢复。

**前端。** 无构建步骤。页面头部用 `<div id="boot" hidden data-xxx="{{...}}">` 接收服务端注入的配置，脚本通过 `dataset` 读取，省一次请求也避免闪烁。

CSP 是 `script-src 'self'`，没有 `unsafe-inline`，所以页面里不能写内联 `<script>`，也不能用 `onclick=""`，脚本都在外部文件里。`style-src` 保留了 `unsafe-inline`，允许少数的行内 `style` 属性。

**CSS 里的两个约束。** 全局禁用 `border-radius`，字号只用 12 的整数倍。另外 `[hidden]` 必须带 `!important`，因为组件里显式设的 `display` 会盖掉浏览器默认规则。
