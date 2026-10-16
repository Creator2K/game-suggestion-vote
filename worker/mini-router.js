'use strict';

/**
 * 极简 Express 兼容层（只做这个项目用到的那部分）。
 *
 * 为什么需要它：src/routes 和 src/middleware 是 Node 与 Workers 共用的，
 * 里面写的是 Express 风格（req.body / res.status().json() / next()）。
 * Node 那边直接用真的 Express，Workers 这边就用这个实现顶上。
 *
 * 已实现（对照项目实际用到的 API 枚举）：
 *   router.get/post/put/patch/delete(path, ...handlers)
 *   router.use(...handlers) / router.use(prefix, ...handlers) / router.use(prefix, subRouter)
 *   req: method url path originalUrl query params body headers get() ip secure socket
 *   res: status() json() set() append() type() send() end()，以及 res.finished
 *   中间件 next()、next(err)；4 参数签名即错误处理中间件（同 Express）
 *
 * 挂载（use(prefix, subRouter)）在 build() 时展开成一张扁平的表，
 * 顺序完全保留；子路由里「不带路径的 use」会被收窄成该前缀，
 * 否则 requireAdmin 这种会误伤所有路径。
 */

/* ------------------------------------------------------------------ *
 * 路径匹配
 * ------------------------------------------------------------------ */

const PARAM_RE = /:([A-Za-z0-9_]+)/g;

function compilePath(pattern) {
  const keys = [];
  const source = String(pattern)
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(PARAM_RE, (_m, name) => {
      keys.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source}$`), keys };
}

/** 前缀匹配：/api 命中 /api 与 /api/x，但不命中 /apix */
function prefixMatch(prefix, path) {
  if (prefix === '/' || prefix === '') return true;
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function joinPath(prefix, path) {
  const p = String(path || '');
  if (!prefix || prefix === '/') return p || '/';
  if (!p || p === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
}

function matchParams(keys, m) {
  const params = {};
  keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1]);
  });
  return params;
}

/* ------------------------------------------------------------------ *
 * 请求 / 响应
 * ------------------------------------------------------------------ */

function parseQuery(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k in out) {
      out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 来源地址。Workers 一定在 Cloudflare 后面，优先用 CF-Connecting-IP；
 * 本地 wrangler dev 没有这个头，退到 X-Forwarded-For，最后落到 127.0.0.1，
 * 与 Node 版在本地看到的效果一致（限频测试才有意义）。
 */
function clientIpOf(request, url) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? '127.0.0.1' : 'unknown';
}

function createRequest(request, url, body) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k] = v;

  const req = {
    method: request.method.toUpperCase(),
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    path: url.pathname,
    query: parseQuery(url.searchParams),
    params: {},
    headers,
    body,
    ip: clientIpOf(request, url),
    secure: url.protocol === 'https:',
    /** 兼容层内部用：原始 Request，读 body 时要 */
    raw: request,
  };

  req.get = (name) => {
    const v = request.headers.get(String(name).toLowerCase());
    return v === null ? undefined : v;
  };
  req.socket = { remoteAddress: req.ip };
  return req;
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

function createResponse() {
  const headers = new Headers();
  const res = {
    statusCode: 200,
    headers,
    finished: false,
    body: null,

    status(code) {
      res.statusCode = Number(code) || 200;
      return res;
    },
    set(name, value) {
      headers.set(String(name), String(value));
      return res;
    },
    append(name, value) {
      headers.append(String(name), String(value));
      return res;
    },
    type(t) {
      const key = String(t).toLowerCase().replace(/^\./, '');
      headers.set('Content-Type', CONTENT_TYPES[key] || String(t));
      return res;
    },
    json(obj) {
      if (!headers.has('Content-Type')) headers.set('Content-Type', CONTENT_TYPES.json);
      res.body = JSON.stringify(obj);
      return res.end();
    },
    send(payload) {
      if (payload === undefined || payload === null) return res.end();
      if (typeof payload === 'object' && !(payload instanceof Uint8Array) && !ArrayBuffer.isView(payload)) {
        return res.json(payload);
      }
      if (typeof payload === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', CONTENT_TYPES.html);
      }
      res.body = payload;
      return res.end();
    },
    end(payload) {
      if (payload !== undefined) res.body = payload;
      if (res.finished) return res;
      res.finished = true;
      if (res._onEnd) res._onEnd();
      return res;
    },

    /** 调度器用：响应一结束就通知它，避免 await 悬在那里 */
    _setOnEnd(fn) {
      res._onEnd = fn;
    },
  };
  return res;
}

/* ------------------------------------------------------------------ *
 * 路由器
 * ------------------------------------------------------------------ */

function createRouter() {
  /** 注册阶段的层：{ kind:'route'|'use'|'mount', ... } */
  const layers = [];

  function addRoute(method, path, handlers) {
    layers.push({ kind: 'route', method, pattern: String(path), handlers });
    return router;
  }

  const router = {
    get: (p, ...h) => addRoute('GET', p, h),
    post: (p, ...h) => addRoute('POST', p, h),
    put: (p, ...h) => addRoute('PUT', p, h),
    patch: (p, ...h) => addRoute('PATCH', p, h),
    delete: (p, ...h) => addRoute('DELETE', p, h),
    options: (p, ...h) => addRoute('OPTIONS', p, h),

    use(a, ...rest) {
      if (typeof a === 'string') {
        const sub = rest.length === 1 && rest[0] && typeof rest[0].build === 'function' ? rest[0] : null;
        if (sub) layers.push({ kind: 'mount', prefix: a, target: sub });
        else layers.push({ kind: 'use', prefix: a, handlers: rest });
      } else {
        layers.push({ kind: 'use', prefix: null, handlers: [a, ...rest] });
      }
      return router;
    },

    /** 把挂载展开成一张扁平表，顺序不变 */
    build() {
      const flat = [];
      (function walk(list, prefix) {
        for (const L of list) {
          if (L.kind === 'mount') {
            walk(L.target.layers, joinPath(prefix, L.prefix));
          } else if (L.kind === 'use') {
            const scoped = L.prefix ? joinPath(prefix, L.prefix) : prefix;
            flat.push({ kind: 'use', prefix: scoped || null, handlers: L.handlers });
          } else {
            const { regex, keys } = compilePath(joinPath(prefix, L.pattern));
            flat.push({ kind: 'route', method: L.method, regex, keys, handlers: L.handlers });
          }
        }
      })(layers, '');
      return flat;
    },

    /** 暴露给兼容层内部与测试 */
    get layers() {
      return layers;
    },
  };

  return router;
}

/**
 * 依次跑扁平表里的层，直到有响应或全部跑完。
 *
 * next 就是续体：handler 同步或异步调用它都行，跟 Express 一致。
 * 两个容易踩的点在这里处理掉：
 *   - handler 内部调用了 next 的话，外层循环必须立刻退出，否则会重复推进
 *     （靠比较推进前后 j 是否变化来判断）
 *   - 异步 handler 直接响应而不调 next 时，靠 res.end 回调解开这个 Promise
 *
 * 返回 Promise<Error|null>：没人处理的错误会浮上来。
 */
function runLayers(flat, req, res) {
  return new Promise((resolve) => {
    let i = 0;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      resolve(err || null);
    };

    // 响应一结束就等于这一轮结束
    res._setOnEnd(() => finish(null));

    function runHandlers(handlers, initialErr, next) {
      let j = 0;
      let err = initialErr;

      function step(e) {
        if (e) err = e;
        if (settled) return;
        if (res.finished) return finish(null);

        while (j < handlers.length) {
          const h = handlers[j++];
          const isErrorHandler = h.length === 4;
          if (err && !isErrorHandler) continue;
          if (!err && isErrorHandler) continue;

          const pending = err;
          err = null;

          // handler 一旦调用 next，就等于把控制权交出去了；
          // 这个标记必须显式记，不能靠别的副作用推断（异步 handler 尤其如此）。
          let advanced = false;
          const nextHandler = (e2) => {
            advanced = true;
            return step(e2);
          };

          let out;
          try {
            out = pending ? h(pending, req, res, nextHandler) : h(req, res, nextHandler);
          } catch (x) {
            err = x;
            continue;
          }

          if (out && typeof out.then === 'function') {
            // 异步 handler：它自己会调 next 或直接响应。
            // 只有「既没调 next 也没响应」才需要替它继续，否则会把
            // 还在等待中的下游跳过（这曾导致响应被后面的 404 层抢走）。
            out.then(
              () => {
                if (!advanced && !res.finished) step();
              },
              (x) => nextHandler(x)
            );
          }

          // 与 Express 保持一致：handler 不调用 next 就到此为止。
          // 这里绝不能继续循环——u.wrap 包出来的 handler 不返回 promise，
          // 继续走会让后面的中间件（比如 requireAdmin）抢在它前面执行。
          return;
        }

        return next(err);
      }

      return step();
    }

    function next(err) {
      if (settled) return;
      if (res.finished) return finish(null);

      while (i < flat.length) {
        const L = flat[i++];

        if (L.kind === 'use') {
          if (L.prefix && !prefixMatch(L.prefix, req.path)) continue;
          return runHandlers(L.handlers, err, next);
        }

        if (L.method !== req.method) continue;
        const m = L.regex.exec(req.path);
        if (!m) continue;

        req.params = matchParams(L.keys, m);
        return runHandlers(L.handlers, err, next);
      }

      return finish(err);
    }

    next();
  });
}

module.exports = {
  createRouter,
  createRequest,
  createResponse,
  runLayers,
  prefixMatch,
  joinPath,
  compilePath,
};
