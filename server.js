/**
 * 宿舍洗衣机状态参考系统 —— 零依赖 Node.js 服务
 * 功能：状态展示、状态机闭环、30 秒限频、2 小时过期提示、管理端 CRUD 与日志、报修处理
 * 启动：node server.js  →  http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STALE_MS = 2 * 60 * 60 * 1000; // 状态超过 2 小时未更新 → 可能已过期
const RATE_MS = 30 * 1000;           // 每个 IP 30 秒内只允许一次状态操作

// 合法状态迁移表（状态机）
const TRANSITIONS = {
  空闲: ['使用中', '故障'],
  使用中: ['待取衣', '空闲', '故障'],
  待取衣: ['空闲', '故障'],
  故障: ['空闲'],
};

function defaultStore() {
  const now = Date.now();
  const t = (msAgo) => now - msAgo;
  return {
    machines: [
      { id: 1, name: '1号洗衣机', location: '12号宿舍楼 洗衣房', status: '空闲', updated_at: t(30 * 60 * 1000), remark: '' },
      { id: 2, name: '2号洗衣机', location: '12号宿舍楼 洗衣房', status: '使用中', updated_at: t(12 * 60 * 1000), remark: '' },
      { id: 3, name: '3号洗衣机', location: '12号宿舍楼 洗衣房', status: '待取衣', updated_at: t(3 * 60 * 1000), remark: '' },
      { id: 4, name: '4号洗衣机', location: '12号宿舍楼 洗衣房', status: '空闲', updated_at: t(10 * 60 * 1000), remark: '' },
      { id: 5, name: '5号洗衣机', location: '12号宿舍楼 洗衣房', status: '故障', updated_at: t(2 * 60 * 60 * 1000), remark: '滚筒异响，待维修' },
      { id: 6, name: '6号洗衣机', location: '12号宿舍楼 洗衣房', status: '空闲', updated_at: t(45 * 60 * 1000), remark: '' },
    ],
    logs: [],
    faults: [],
    seq: 6,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.machines)) throw new Error('bad data');
    return s;
  } catch {
    return defaultStore();
  }
}

let store = load();
let dirty = false;
function save() {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  dirty = false;
}
setInterval(save, 3000);
process.on('exit', save);
process.on('SIGINT', () => { save(); process.exit(0); });

// ---- 限频 ----
const lastAction = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const last = lastAction.get(ip) || 0;
  if (now - last < RATE_MS) return true;
  lastAction.set(ip, now);
  return false;
}

// ---- 工具 ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function machineView(m) {
  const now = Date.now();
  const updatedAt = m.updated_at || now;
  const stale = m.status !== '空闲' && now - updatedAt > STALE_MS;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  return { ...m, stale, minutes_ago: minutes };
}

function getClientIp(req) {
  return req.socket.remoteAddress || 'local';
}

// ---- 路由处理 ----
async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);

  // GET /api/machines
  if (method === 'GET' && parts.join('/') === 'api/machines') {
    const machines = store.machines.map(machineView);
    const summary = machines.reduce((acc, m) => {
      acc.total += 1;
      acc[m.status] = (acc[m.status] || 0) + 1;
      return acc;
    }, { total: 0, 空闲: 0, 使用中: 0, 待取衣: 0, 故障: 0 });
    return sendJson(res, 200, { machines, summary, server_time: Date.now() });
  }

  // GET /api/logs
  if (method === 'GET' && parts.join('/') === 'api/logs') {
    return sendJson(res, 200, { logs: store.logs.slice(-100).reverse() });
  }

  // GET /api/faults
  if (method === 'GET' && parts.join('/') === 'api/faults') {
    return sendJson(res, 200, { faults: store.faults.slice(-50).reverse() });
  }

  // POST /api/machines/:id/status
  if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'machines' && parts[3] === 'status') {
    const id = Number(parts[2]);
    const machine = store.machines.find((m) => m.id === id);
    if (!machine) return sendJson(res, 404, { error: '机器不存在' });
    if (isRateLimited(getClientIp(req))) return sendJson(res, 429, { error: '操作过于频繁，请 30 秒后再试' });

    const body = await readBody(req);
    const to = String(body.to || '');
    const from = machine.status;
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
      return sendJson(res, 400, { error: `非法状态迁移：${from} → ${to}` });
    }

    const now = Date.now();
    machine.status = to;
    machine.updated_at = now;
    if (to === '故障') machine.remark = String(body.note || machine.remark || '学生报修');
    if (to !== '故障') machine.remark = String(body.note || machine.remark || '');
    store.logs.push({
      id: ++store.seq,
      machine_id: id,
      machine_name: machine.name,
      from,
      to,
      by: String(body.by || '同学'),
      created_at: now,
    });
    if (to === '故障') {
      store.faults.push({
        id: store.faults.length + 1,
        machine_id: id,
        machine_name: machine.name,
        desc: String(body.note || '报修'),
        reporter: String(body.by || '同学'),
        status: '待处理',
        created_at: now,
      });
    }
    dirty = true;
    return sendJson(res, 200, { ok: true, machine: machineView(machine) });
  }

  // 管理端：POST /api/admin/machines
  if (method === 'POST' && parts.join('/') === 'api/admin/machines') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const location = String(body.location || '').trim();
    if (!name) return sendJson(res, 400, { error: '缺少机器名称' });
    const now = Date.now();
    const machine = {
      id: ++store.seq,
      name,
      location: location || '未指定位置',
      status: '空闲',
      updated_at: now,
      remark: '',
    };
    store.machines.push(machine);
    store.logs.push({ id: ++store.seq, machine_id: machine.id, machine_name: machine.name, from: '-', to: '空闲', by: '管理员', created_at: now });
    dirty = true;
    return sendJson(res, 201, { ok: true, machine });
  }

  // 管理端：PUT /api/admin/machines/:id
  if (method === 'PUT' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'machines') {
    const id = Number(parts[3]);
    const machine = store.machines.find((m) => m.id === id);
    if (!machine) return sendJson(res, 404, { error: '机器不存在' });
    const body = await readBody(req);
    if (body.name !== undefined) machine.name = String(body.name).trim() || machine.name;
    if (body.location !== undefined) machine.location = String(body.location).trim() || machine.location;
    if (body.remark !== undefined) machine.remark = String(body.remark);
    dirty = true;
    return sendJson(res, 200, { ok: true, machine: machineView(machine) });
  }

  // 管理端：DELETE /api/admin/machines/:id
  if (method === 'DELETE' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'machines') {
    const id = Number(parts[3]);
    const idx = store.machines.findIndex((m) => m.id === id);
    if (idx === -1) return sendJson(res, 404, { error: '机器不存在' });
    store.machines.splice(idx, 1);
    dirty = true;
    return sendJson(res, 200, { ok: true });
  }

  // 管理端：POST /api/admin/faults/:id/close
  if (method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'faults' && parts[4] === 'close') {
    const id = Number(parts[3]);
    const fault = store.faults.find((f) => f.id === id);
    if (!fault) return sendJson(res, 404, { error: '报修记录不存在' });
    fault.status = '已处理';
    fault.closed_at = Date.now();
    const machine = store.machines.find((m) => m.id === fault.machine_id);
    if (machine && machine.status === '故障') {
      machine.status = '空闲';
      machine.updated_at = Date.now();
      machine.remark = '';
      store.logs.push({
        id: ++store.seq, machine_id: machine.id, machine_name: machine.name,
        from: '故障', to: '空闲', by: '管理员', created_at: Date.now(),
      });
    }
    dirty = true;
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---- 静态文件 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const SAFE_NAMES = new Set(['index.html', 'admin.html', 'style.css', 'app.js', 'admin.js', 'favicon.svg']);

function serveStatic(res, pathname) {
  let name = pathname === '/' ? 'index.html' : path.basename(pathname);
  if (pathname === '/admin') name = 'admin.html';
  if (!SAFE_NAMES.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const file = path.join(PUBLIC_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---- 服务入口 ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(res, url.pathname);
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`✅ 宿舍洗衣机状态参考系统已启动：http://localhost:${PORT}`);
  console.log(`   学生端：http://localhost:${PORT}/     管理端：http://localhost:${PORT}/admin`);
});
