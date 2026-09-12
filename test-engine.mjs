/* 引擎单元测试：从 index.html 中提取 ENGINE 块，在 Node 中运行 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, "index.html"), "utf8");
const m = html.match(/\/\*__ENGINE_START__\*\/([\s\S]*?)\/\*__ENGINE_END__\*\//);
if (!m) throw new Error("未找到引擎代码块");
const api = new Function(
  m[1] + "\n;return {SIZE,EMPTY,BLACK,WHITE,opp,Game,pointScore,genCandidates,findWinPoints,chooseAiMove,negamax,evaluate};"
)();
const { SIZE, EMPTY, BLACK, WHITE, Game, pointScore, chooseAiMove, findWinPoints } = api;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg){
  if (cond) passed++;
  else { failed++; failures.push(msg); console.error("  ✗ " + msg); }
}
function section(name){ console.log("▶ " + name); }

/* 按黑先交替的顺序摆子（保证回合奇偶正确：黑白数相等 => 轮黑） */
function mkGame(blacks, whites){
  const g = new Game();
  const n = Math.max(blacks.length, whites.length);
  for (let i = 0; i < n; i++){
    if (blacks[i]) g.place(blacks[i][0], blacks[i][1], BLACK);
    if (whites[i]) g.place(whites[i][0], whites[i][1], WHITE);
  }
  return g;
}

/* ---------- 1. 胜负判定 ---------- */
section("胜负判定");
{
  const g = mkGame([[5,7],[6,7],[7,7],[8,7],[9,7]], [[0,0],[0,1],[0,2],[0,3],[0,4]]);
  ok(g.winLine(7,7)?.length === 5, "横向五连应被识别");
  const line = g.winLine(7,7);
  ok(line && line[0][0] === 5 && line[4][0] === 9, "五连棋子应按连线顺序排列: " + JSON.stringify(line));
  ok(g.winLine(5,7)?.length === 5, "五连端点也应识别");
  ok(g.winLine(0,2)?.length === 5, "白棋纵向五连也应识别");
  const g2 = mkGame([[7,3],[7,4],[7,5],[7,6],[7,7]], [[0,14],[1,14],[2,14],[3,14]]);
  ok(g2.winLine(7,5)?.length === 5, "纵向五连应被识别");
  const g3 = mkGame([[3,3],[4,4],[5,5],[6,6],[7,7]], [[0,0],[0,1],[0,2],[0,3]]);
  ok(g3.winLine(5,5)?.length === 5, "主对角线五连应被识别");
  const g4 = mkGame([[11,3],[10,4],[9,5],[8,6],[7,7]], [[0,0],[0,1],[0,2],[0,3]]);
  ok(g4.winLine(9,5)?.length === 5, "反对角线五连应被识别");
  const g5 = mkGame([[2,7],[3,7],[4,7],[6,7],[7,7]], [[0,0],[0,1],[0,2],[0,3],[0,5]]);
  ok(g5.winLine(4,7) === null, "断开的三连不应误判为胜");
  const g6 = mkGame([[2,7],[3,7],[4,7],[5,7],[6,7],[7,7]], [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5]]);
  ok(g6.winLine(4,7)?.length === 6, "长连（六子）应识别且包含全部棋子");
  ok(g5.makesFive(8,7,BLACK) === false, "空点虚拟成五判断（不该成五时）");
}
{
  const g = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,1],[0,2],[0,3]]);
  ok(g.makesFive(7,7,BLACK) === true, "跳四空隙处虚拟落子应成五");
  ok(findWinPoints(g, BLACK).some(p => p.x === 7 && p.y === 7), "findWinPoints 应找到跳四成五点");
}

/* ---------- 2. pointScore 棋型识别 ---------- */
section("棋型评估");
{
  const g = mkGame([[5,7],[6,7],[7,7]], [[0,0],[0,1],[0,2]]);
  ok(pointScore(g,4,7,BLACK) >= 1000000, "落子成活四应得高分（≥100万）: " + pointScore(g,4,7,BLACK));
  ok(pointScore(g,8,7,BLACK) >= 1000000, "另一端成活四同理");

  const g2 = mkGame([[5,7],[6,7],[7,7],[8,7]], [[4,7],[0,0],[0,1],[0,2]]); // 左端被堵
  const s = pointScore(g2,9,7,BLACK);
  ok(s === 10000000, "补成五应得 1000 万分: " + s);

  const g3 = mkGame([[5,7],[6,7],[7,7]], [[4,7],[0,0],[0,1],[0,2]]);       // 左端被堵的活三
  const s3 = pointScore(g3,8,7,BLACK);
  ok(s3 >= 100000 && s3 < 1000000, "一端被堵时成冲四（非活四）: " + s3);

  const g4 = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,1],[0,2],[0,3]]); // 跳四 011011
  ok(pointScore(g4,7,7,BLACK) === 10000000, "填跳四空隙成五: " + pointScore(g4,7,7,BLACK));

  const g5 = mkGame([[5,7],[6,7],[6,5],[7,6]], [[0,0],[0,1],[0,2]]);       // 散子
  ok(pointScore(g5,7,7,BLACK) < 200000, "散子组合分不应过高: " + pointScore(g5,7,7,BLACK));
}

/* ---------- 3. AI 战术：取胜 / 防守 ---------- */
section("AI 战术行为");
{
  const g = mkGame([[5,7],[6,7],[7,7],[8,7]], [[0,0],[0,2],[0,4],[0,6]]);
  const mv = chooseAiMove(g, BLACK, 3);
  ok((mv.x === 4 && mv.y === 7) || (mv.x === 9 && mv.y === 7), "AI 应直接成五取胜: " + JSON.stringify(mv));

  const g2 = mkGame([[4,7],[1,1],[1,3],[1,5]], [[5,7],[6,7],[7,7],[8,7]]);
  const mv2 = chooseAiMove(g2, BLACK, 3);
  ok(mv2.x === 9 && mv2.y === 7, "AI 应堵住对方唯一成五点(9,7): " + JSON.stringify(mv2));

  const g3 = mkGame([[1,1],[1,3],[1,5]], [[5,7],[6,7],[7,7],[0,0],[0,2],[0,4]]);
  const mv3 = chooseAiMove(g3, BLACK, 3);
  ok((mv3.x === 4 && mv3.y === 7) || (mv3.x === 8 && mv3.y === 7), "AI 应封堵对方活三两端之一: " + JSON.stringify(mv3));

  const g4 = mkGame([[5,7],[6,7],[7,7],[8,7]], [[5,9],[6,9],[7,9],[8,9]]);
  const mv4 = chooseAiMove(g4, BLACK, 2);
  ok((mv4.x === 4 && mv4.y === 7) || (mv4.x === 9 && mv4.y === 7), "自己能成五时优先于堵对方: " + JSON.stringify(mv4));

  const g5 = mkGame([[5,5],[6,6],[7,7]], [[0,0],[0,1],[0,2]]);
  const mv5 = chooseAiMove(g5, BLACK, 3);
  ok(g5.at(mv5.x, mv5.y) === EMPTY, "AI 落在空点");
  const near = Math.max(Math.abs(mv5.x-6), Math.abs(mv5.y-6));
  ok(near <= 2, "开局阶段 AI 应在棋筋附近落子: " + JSON.stringify(mv5));

  const g6 = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,1],[0,2],[0,3]]);
  const mv6 = chooseAiMove(g6, BLACK, 2);
  ok(mv6.x === 7 && mv6.y === 7, "进阶 AI 应会填跳四空隙成五: " + JSON.stringify(mv6));

  const g7 = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,2],[0,4],[0,6]]);
  const mv7 = chooseAiMove(g7, WHITE, 2);
  ok(mv7.x === 7 && mv7.y === 7, "AI 执白时也应堵跳四成五点: " + JSON.stringify(mv7));

  const g8 = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,2],[0,4],[0,6]]);
  const mv8 = chooseAiMove(g8, BLACK, 4);
  ok(mv8.x === 7 && mv8.y === 7, "宗师应填跳四空隙成五: " + JSON.stringify(mv8));

  const g9 = mkGame([[1,1],[1,3],[1,5]], [[5,7],[6,7],[7,7],[0,0],[0,2],[0,4]]);
  const mv9 = chooseAiMove(g9, BLACK, 4);
  // 直接封堵活三两端，或利用 1 列 1.1.1 骑缝型先冲四反先（更强），二者皆可
  const okMv9 = [[4,7],[8,7],[1,2],[1,4]].some(p => p[0] === mv9.x && p[1] === mv9.y);
  ok(okMv9, "宗师应封堵活三或冲四反先: " + JSON.stringify(mv9));

  const g10 = mkGame([[5,7],[6,7],[8,7],[9,7]], [[0,0],[0,2],[0,4],[0,6]]);
  const mv10 = chooseAiMove(g10, BLACK, 5);
  ok(mv10.x === 7 && mv10.y === 7, "棋圣应填跳四空隙成五: " + JSON.stringify(mv10));
}

/* ---------- 4. 性能：AI 对弈全流程 ---------- */
section("性能与稳定性（AI 对弈）");
{
  const t0 = Date.now();
  let maxMs = 0, playouts = 0;
  for (let r = 0; r < 3; r++){
    const g = new Game();
    const lvlB = r === 0 ? 3 : r === 1 ? 4 : 5;   // 逐盘加深：大师 → 宗师 → 棋圣
    const cap = r === 0 ? 30 : r === 1 ? 10 : 6;
    let color = BLACK;
    for (let moves = 0; moves < cap; moves++){
      const t1 = Date.now();
      const mv = chooseAiMove(g, color, color === BLACK ? lvlB : 2);
      const dt = Date.now() - t1;
      if (dt > maxMs) maxMs = dt;
      ok(g.at(mv.x, mv.y) === EMPTY, `AI 落子必须为空点 (r${r} m${moves}): ${JSON.stringify(mv)}`);
      g.place(mv.x, mv.y, color);
      playouts++;
      if (g.winLine(mv.x, mv.y)) break;
      color = color === BLACK ? WHITE : BLACK;
    }
  }
  const total = Date.now() - t0;
  console.log(`  共 ${playouts} 手，总耗时 ${total} ms，单手最慢 ${maxMs} ms`);
  ok(maxMs < 6000, `单手耗时应 < 6s（含棋圣 5s 时间上限，实测最慢 ${maxMs} ms）`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
