#!/usr/bin/env node
/* ============================================================
 * 五子棋在线对战服务器（零依赖，仅 Node 内置模块）
 *
 *   用法：node gomoku-server.js [端口]      默认端口 3000
 *
 * 职责：
 *   - 房间匹配：两位玩家加入相同房间号即配成对局（先加入执黑）
 *   - 行棋中继：SSE 实时推送 + POST 上报，断线 8 秒内重连不掉座位
 *   - 权威判定：服务器复用 index.html 中的引擎判定五连/长连/平局，
 *     客户端只做展示，杜绝双方状态不一致
 * ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/* —— 配置文件 ——
 * config.example.json：仓库内模板（提交 git）
 * config.json        ：本机实际配置（.gitignore 忽略，git pull 不会覆盖你的本地配置）
 * 首次启动自动从模板复制生成；优先级：命令行参数 / 环境变量 > config.json > 内置默认 */
const CFG_FILE = path.join(__dirname, "config.json");
const CFG_EXAMPLE = path.join(__dirname, "config.example.json");
try {
  if (!fs.existsSync(CFG_FILE) && fs.existsSync(CFG_EXAMPLE)){
    fs.copyFileSync(CFG_EXAMPLE, CFG_FILE);
    console.log("已从 config.example.json 生成 config.json —— 修改该文件即可自定义配置（不会被 git 覆盖）。");
  }
} catch (e) {}
function readConfigFile(){
  try {
    const v = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}
const FILE_CFG = readConfigFile();
const num = (v, def) => (Number.isFinite(+v) ? +v : def);
const str = (v, def) => (v === undefined || v === null || v === "") ? def : String(v);

/* 端口来源优先级：命令行参数 > PORT 环境变量 > 配置文件 port > 3000
 * 支持 "3000"（单端口）、"3000-3010"（范围，占用自动顺延）、"3000,8080"（候选列表） */
const PORT_ARG = str(process.argv[2],
                  str(process.env.PORT,
                    str(process.env.PORT_RANGE, str(FILE_CFG.port, "3000"))));
const HOST = str(process.env.HOST, str(FILE_CFG.host, "0.0.0.0"));  // 云服务器/Docker 需监听全部网卡
const NO_OPEN = process.env.GOMOKU_NO_OPEN ? true : FILE_CFG.noOpen === true;
const SPEC_MAX = Math.max(0, num(FILE_CFG.specMax, 5000));                      // 每房间观战人数上限
const ROOM_TTL = Math.max(60_000, num(FILE_CFG.roomTtlHours, 2) * 3600_000);    // 房间最长闲置时间
const RECONNECT_GRACE = Math.max(1000, num(FILE_CFG.reconnectGraceMs, 8000));   // 断线重连保留座位的宽限期
const PASSWORD_MAX = Math.max(4, num(FILE_CFG.passwordMaxLen, 16));             // 房间密码最大长度

const PORTS = (() => {
  const out = [];
  for (const part of String(PORT_ARG).split(",")){
    const m = part.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (b < a) [a, b] = [b, a];
    for (let p = a; p <= b && out.length < 100; p++) out.push(p);
  }
  return out.length ? out : [3000];
})();

/* —— 从 index.html 提取纯逻辑引擎（与 test-engine.mjs 同一机制） —— */
let Game, SIZE, EMPTY, BLACK, WHITE;
try {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = html.match(/\/\*__ENGINE_START__\*\/([\s\S]*?)\/\*__ENGINE_END__\*\//);
  if (!m) throw new Error("未找到引擎代码块");
  ({ Game, SIZE, EMPTY, BLACK, WHITE } = new Function(m[1] + "\n;return {Game,SIZE,EMPTY,BLACK,WHITE};")());
} catch (e) {
  console.error("无法从 index.html 加载引擎：" + e.message);
  process.exit(1);
}

/* —— 房间 —— */
const rooms = new Map();
const normRoom = id => String(id || "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);

function getRoom(id, pwd){   // 仅 join 使用：不存在则按该密码创建（后加入者不能更改）
  let r = rooms.get(id);
  if (!r){
    r = { id, pwd: pwd || "", players: { [BLACK]: null, [WHITE]: null }, spectators: new Map(),
          game: new Game(), pendingUndo: null, ts: Date.now() };
    rooms.set(id, r);
  }
  r.ts = Date.now();
  return r;
}
const hasSeat = (r, c) => !!(r.players[c] && r.players[c].token);
function stateOf(r){
  const g = r.game, turn = g.moves.length % 2 === 0 ? BLACK : WHITE;
  return {
    moves: g.moves.map(m => [m.x, m.y, m.c]),
    winner: g.winner || 0,
    draw: !!g.draw,
    winCells: g.winCells || null,
    turn,
    seats: { [BLACK]: hasSeat(r, BLACK), [WHITE]: hasSeat(r, WHITE) },
    specCount: r.spectators.size,
  };
}
function writeEvent(res, type, extra){
  try { res.write(`data: ${JSON.stringify({ type, ...extra })}\n\n`); } catch (e) {}
}
function send(p, type, extra){
  if (p && p.res) writeEvent(p.res, type, extra);
}
function broadcast(r, type, extra = {}){
  const payload = `data: ${JSON.stringify({ type, state: stateOf(r), ...extra })}\n\n`;
  for (const c of [BLACK, WHITE]){
    const p = r.players[c];
    if (p && p.res){ try { p.res.write(payload); } catch (e) {} }
  }
  for (const s of r.spectators.values()){
    if (s.res){ try { s.res.write(payload); } catch (e) {} }
  }
}
function seatByToken(r, token){
  for (const c of [BLACK, WHITE])
    if (r.players[c] && r.players[c].token === token) return c;
  return 0;
}
function detach(r, color){
  const p = r.players[color];
  if (p){ if (p.detachTimer) clearTimeout(p.detachTimer); p.token = null; p.res = null; }
  r.pendingUndo = null;
  broadcast(r, "leave", { who: color });
}

/* —— HTTP —— */
const { exec } = require("child_process");
function autoOpenBrowser(url){
  if (NO_OPEN) return;   // 配置文件 noOpen=true 或环境变量 GOMOKU_NO_OPEN（云服务器/容器无浏览器）
  const cmd = process.platform === "win32" ? `start "" "${url}"`
            : process.platform === "darwin" ? `open "${url}"`
            : `xdg-open "${url}"`;
  try { exec(cmd, () => {}); } catch (e) {}
}
function lanAddresses(port){
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n && n.family === "IPv4" && !n.internal) ips.push(n.address);
  return ips.map(ip => `http://${ip}:${port}/`).join("   ") || "（未检测到局域网地址）";
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS"){ res.writeHead(204, cors); return res.end(); }

  /* 静态页面（同源打开即玩） */
  if (parts[0] !== "api"){
    if (url.pathname === "/" || url.pathname === "/index.html"){
      fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
        if (e){ res.writeHead(500); return res.end("err"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(d);
      });
    } else if (url.pathname === "/config.json"){
      // 提供给页面客户端：file:// 场景下按配置端口回退连接
      fs.readFile(CFG_FILE, (e, d) => {
        if (e){ res.writeHead(404, cors); return res.end("{}"); }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
        res.end(d);
      });
    } else { res.writeHead(404); res.end("nf"); }
    return;
  }

  const finish = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...cors });
    res.end(JSON.stringify(obj));
  };
  let body = "";
  req.on("data", c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on("end", () => {
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch (e) {}
    const [, , id, action] = parts;
    const rid = normRoom(id);
    if (!rid) return finish(400, { error: "房间号无效" });

    /* 加入房间：空位即入，先到执黑；满员则进入观战。房间有密码时须验证（玩家与观战一致） */
    if (action === "join" && req.method === "POST"){
      const pwd = String(data.pwd || "").trim().slice(0, PASSWORD_MAX);
      const existing = rooms.get(rid);
      if (existing && existing.pwd && existing.pwd !== pwd)
        return finish(403, { error: "房间密码错误" });
      const r = getRoom(rid, pwd);   // 不存在则创建，密码以首位创建者为准
      let color = 0;
      if (!hasSeat(r, BLACK)) color = BLACK;
      else if (!hasSeat(r, WHITE)) color = WHITE;
      if (color){
        const token = crypto.randomBytes(9).toString("hex");
        r.players[color] = { token, res: null, detachTimer: null };
        broadcast(r, "join", { who: color });
        return finish(200, { token, color, roomId: rid, specCount: r.spectators.size, state: stateOf(r) });
      }
      if (r.spectators.size >= SPEC_MAX) return finish(409, { error: `观战席已满（${SPEC_MAX} 人）` });
      const token = crypto.randomBytes(9).toString("hex");
      r.spectators.set(token, { res: null });
      broadcast(r, "spec", {});
      return finish(200, { token, color: 0, roomId: rid, specCount: r.spectators.size, state: stateOf(r) });
    }

    const r = rooms.get(rid);
    if (!r) return finish(404, { error: "房间不存在" });

    /* SSE 实时事件流（玩家与观战者共用） */
    if (action === "events" && req.method === "GET"){
      const token = url.searchParams.get("token") || "";
      const color = seatByToken(r, token);
      const isSpec = !color && r.spectators.has(token);
      if (!color && !isSpec) return finish(403, { error: "令牌无效，请重新加入" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        ...cors,
      });
      res.write(":connected\n\n");
      if (color){
        const p = r.players[color];
        if (p.detachTimer){ clearTimeout(p.detachTimer); p.detachTimer = null; }
        if (p.res && p.res !== res){          // 同一座位被另一窗口接管：通知旧窗口让位
          writeEvent(p.res, "replaced", {});
          try { p.res.end(); } catch (e) {}
        }
        p.res = res;
        send(p, "init", { you: color, state: stateOf(r) });
        broadcast(r, "join", { who: color });
        const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch (e) {} }, 25000);
        res.on("close", () => {                     // 仅在连接真正断开时触发
          clearInterval(ping);
          const me = r.players[color];
          if (me && me.res === res){
            me.res = null;
            me.detachTimer = setTimeout(() => {     // 宽限期内重连则保留座位
              const cur = r.players[color];
              if (cur && cur.token === token && !cur.res) detach(r, color);
            }, RECONNECT_GRACE);
          }
        });
      } else {
        const s = r.spectators.get(token);
        if (s.res && s.res !== res){
          writeEvent(s.res, "replaced", {});
          try { s.res.end(); } catch (e) {}
        }
        s.res = res;
        writeEvent(res, "init", { you: 0, state: stateOf(r) });
        const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch (e) {} }, 25000);
        res.on("close", () => {
          clearInterval(ping);
          const cur = r.spectators.get(token);
          if (cur && cur.res === res){ r.spectators.delete(token); broadcast(r, "spec", {}); }
        });
      }
      return;
    }

    const token = data.token || url.searchParams.get("token") || "";
    const me = seatByToken(r, token);
    const isSpec = !me && r.spectators.has(token);
    if (!me && !isSpec) return finish(403, { error: "尚未加入房间" });

    /* 落子：服务器校验回合与合法性并判定胜负 */
    if (action === "move" && req.method === "POST"){
      if (!me) return finish(403, { error: "观战者不能落子" });
      const g = r.game;
      if (g.winner || g.draw) return finish(400, { error: "对局已结束" });
      if (!hasSeat(r, BLACK) || !hasSeat(r, WHITE)) return finish(400, { error: "等待对手加入" });
      const turn = g.moves.length % 2 === 0 ? BLACK : WHITE;
      if (turn !== me) return finish(400, { error: "还没轮到你" });
      const x = data.x | 0, y = data.y | 0;
      if (!g.inB(x, y) || g.at(x, y) !== EMPTY) return finish(400, { error: "不能落在此处" });
      g.place(x, y, me);
      r.pendingUndo = null;
      const wl = g.winLine(x, y);
      if (wl){ g.winner = me; g.winCells = wl; }
      else if (g.moves.length >= SIZE * SIZE) g.draw = true;
      broadcast(r, "move");
      return finish(200, { ok: true });
    }

    /* 动作：重开 / 悔棋协商 / 转为参战 / 离开 */
    if (action === "action" && req.method === "POST"){
      const type = data.type;
      if (type === "takeSeat"){
        if (!isSpec) return finish(400, { error: "你已在对局中" });
        let color = 0;
        if (!hasSeat(r, BLACK)) color = BLACK;
        else if (!hasSeat(r, WHITE)) color = WHITE;
        else return finish(400, { error: "暂无空位" });
        r.spectators.delete(token);
        r.players[color] = { token, res: null, detachTimer: null };
        broadcast(r, "join", { who: color });
        return finish(200, { ok: true, color });
      }
      if (isSpec) return finish(403, { error: "观战者无权执行该操作" });
      if (type === "restart"){
        r.game = new Game(); r.pendingUndo = null;
        broadcast(r, "restart", { by: me });
        return finish(200, { ok: true });
      }
      if (type === "undoRequest"){
        if (r.game.moves.length === 0) return finish(400, { error: "没有可悔的棋" });
        r.pendingUndo = me;
        broadcast(r, "undoRequest", { by: me });
        return finish(200, { ok: true });
      }
      if (type === "undoResponse"){
        if (!r.pendingUndo || r.pendingUndo === me) return finish(400, { error: "无待处理的悔棋请求" });
        const accept = !!data.accept;
        const requester = r.pendingUndo;
        r.pendingUndo = null;
        if (accept && r.game.moves.length){
          r.game.undo();
          r.game.winner = 0; r.game.winCells = null; r.game.draw = false;   // 撤销后对局恢复
        }
        broadcast(r, accept ? "undo" : "undoDeclined", { by: requester });
        return finish(200, { ok: true });
      }
      if (type === "leave"){
        if (isSpec){
          r.spectators.delete(token);
          broadcast(r, "spec", {});
        } else detach(r, me);
        return finish(200, { ok: true });
      }
      return finish(400, { error: "未知动作" });
    }

    if (action === "peek" && req.method === "GET"){
      return finish(200, { ok: true, color: isSpec ? 0 : me, state: stateOf(r) });
    }

    finish(404, { error: "not found" });
  });
});

/* 闲置房间清理 */
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms){
    const empty = !hasSeat(r, BLACK) && !hasSeat(r, WHITE) && r.spectators.size === 0;
    if ((empty && now - r.ts > 60_000) || now - r.ts > ROOM_TTL) rooms.delete(id);
  }
}, 60_000);

/* 启动：按候选端口顺序尝试绑定；范围配置时端口被占用自动顺延 */
let portIdx = 0;
function bind(){
  if (portIdx >= PORTS.length){
    console.log(`候选端口全部不可用：${PORTS.join(", ")}`);
    console.log(`对战服务器可能已在运行，直接打开 http://127.0.0.1:${PORTS[0]}/ 即可继续。`);
    autoOpenBrowser(`http://127.0.0.1:${PORTS[0]}/`);
    process.exit(0);
  }
  const p = PORTS[portIdx++];
  server.listen(p, HOST, () => {
    console.log("五子棋在线对战服务器已启动。");
    console.log("  本机访问:  http://127.0.0.1:" + p + "/");
    console.log("  局域网/云: " + lanAddresses(p));
    console.log("玩家打开地址 → 选择「在线对战」→ 输入相同房间号即可匹配。");
    console.log(`配置文件: ${CFG_FILE}（观战上限 ${SPEC_MAX} · 房间回收 ${Math.round(ROOM_TTL / 3600000)}h · 重连宽限 ${RECONNECT_GRACE}ms）`);
    console.log(`(端口配置 ${PORT_ARG}，实际使用 ${p}；配置文件或环境变量 GOMOKU_NO_OPEN 可禁止自动开浏览器)`);
    autoOpenBrowser(`http://127.0.0.1:${p}/`);
  });
}
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" || e.code === "EACCES"){
    const failed = PORTS[portIdx - 1];
    console.log(`端口 ${failed} 不可用（${e.code === "EACCES" ? "无权限，建议用 1024 以上端口" : "已被占用"}），尝试下一个候选端口...`);
    bind();
    return;
  }
  console.error("服务器错误：" + (e && e.message));
  process.exit(1);
});
bind();
