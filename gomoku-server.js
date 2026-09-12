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
const crypto = require("crypto");

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const ROOM_TTL = 2 * 60 * 60 * 1000;   // 房间最长闲置时间
const RECONNECT_GRACE = 8000;          // 断线重连保留座位的宽限期
const SPEC_MAX = 10;                   // 每房间观战人数上限

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

function getRoom(id){
  let r = rooms.get(id);
  if (!r){
    r = { id, players: { [BLACK]: null, [WHITE]: null }, spectators: new Map(),
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

    /* 加入房间：空位即入，先到执黑；满员则进入观战 */
    if (action === "join" && req.method === "POST"){
      const r = getRoom(rid);
      let color = 0;
      if (!hasSeat(r, BLACK)) color = BLACK;
      else if (!hasSeat(r, WHITE)) color = WHITE;
      if (color){
        const token = crypto.randomBytes(9).toString("hex");
        r.players[color] = { token, res: null, detachTimer: null };
        broadcast(r, "join", { who: color });
        return finish(200, { token, color, roomId: rid, specCount: r.spectators.size, state: stateOf(r) });
      }
      if (r.spectators.size >= SPEC_MAX) return finish(409, { error: "对局席与观战席均已满" });
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
      return finish(200, { ok: true, color: me, state: stateOf(r) });
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

server.listen(PORT, () => {
  console.log("五子棋在线对战服务器已启动: http://127.0.0.1:" + PORT);
  console.log("两位玩家打开该地址 → 选择「在线对战」→ 输入相同房间号即可匹配。");
});
