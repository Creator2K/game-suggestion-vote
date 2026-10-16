# 设计说明

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

公开三个：`/state` 查初始化状态，`/setup` 首次设置密码（仅未初始化时可用），`/login`。

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

## 实现要点

**后台鉴权。** 单一管理员密码，scrypt 加盐哈希存在 `settings` 里，比对用 `timingSafeEqual`。会话是随机 token 存表，通过 httpOnly + SameSite=Strict 的 Cookie 下发。

**CSRF。** SameSite 之外再加一道：写操作必须带 `x-csrf-token` 头，值等于会话 token。跨站表单设不了自定义请求头，这一道足够。

**限频。** `ip_events` 记事件，查询时数时间窗口内的条数。只有操作成功后路由才写事件，所以失败的尝试不消耗额度。阈值从 `settings` 实时读，后台改完立即生效，不用重启。

**IP 获取。** `TRUST_PROXY=1` 时 Express 会依据 `X-Forwarded-For` 填 `req.ip`。`::ffff:127.0.0.1` 这类 IPv4-mapped 地址会被还原成 `127.0.0.1`，否则同一个 IP 会因为连接方式不同被记成两个值。

**模板。** `src/template.js` 是个几十行的实现，支持 `{{变量}}`（自动 HTML 转义）和 `{{> partial}}`（可嵌套）。站点文案在吐 HTML 时就注入，首页不会先闪默认文字再变。文件按 mtime 缓存。

**备份。** `VACUUM INTO` 产生一致性快照，不用停服，也不会拷到写了一半的 WAL 数据。定时器靠「当天有没有备份文件」判断，重启不会重复备份。

**前端。** 无构建步骤。页面头部用 `<div id="boot" hidden data-xxx="{{...}}">` 接收服务端注入的配置，脚本通过 `dataset` 读取，省一次请求也避免闪烁。

CSP 是 `script-src 'self'`，没有 `unsafe-inline`，所以页面里不能写内联 `<script>`，也不能用 `onclick=""`，脚本都在外部文件里。`style-src` 保留了 `unsafe-inline`，允许少数的行内 `style` 属性。

**CSS 里的两个约束。** 全局禁用 `border-radius`，字号只用 12 的整数倍。另外 `[hidden]` 必须带 `!important`，因为组件里显式设的 `display` 会盖掉浏览器默认规则。
