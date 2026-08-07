/**
 * 客户端入口。
 *
 * **M1：3D 场景 + 自由镜头 + 移动物理。**
 * 这是规格书 4.x 与 13.5 的可验证载体 —— 验收 #1/#2/#3/#44/#45/#47 在这里人工确认。
 *
 * 战斗、目标选择、技能是 M2–M4，见 docs/PROGRESS.md。
 */

import { GEOMETRY, MOVE, RANGE, getClass } from '@wowpvp/shared';
import { probeIconAssets } from './hud/skillIcon.js';
import { artEnabled } from './settings/artMode.js';
import { TestbedScene, type DebugInfo } from './scenes/TestbedScene.js';
import { TESTBED_STAGE, TUTORIAL_STAGE, stressStage } from './scenes/stages.js';

// M12：探测素材目录是否可用。不 await —— 场景启动不等它，
// 探测成功后下一次 HUD 重建（≤50ms）自然切到真实图标。
// `?art=off` 时连探测都不发，整个 HUD 走程序化 SVG（见 settings/artMode.ts）
if (artEnabled()) void probeIconAssets();

const RAD = 180 / Math.PI;

const app = document.getElementById('app')!;

/**
 * 试验场 / `?net=` 老路共用的页面骨架。
 * ★ M13：大厅分支**不**装配它 —— 大厅是纯 DOM 页面，对局画布由
 *   `LobbyShell` 每场对局单独创建（见该文件头）。
 */
const SCENE_DOM = `
  <canvas id="view"></canvas>

  <div id="hud">
    <div class="panel" id="stats"></div>
    <div class="panel" id="help">
      <h3>试验场 · 按规格书第 4 / 13 章验证</h3>
      <table>
        <tr><td><kbd>W</kbd><kbd>S</kbd></td><td>前进 / 后退<span class="hint">后退 65% 速度</span></td></tr>
        <tr><td><kbd>A</kbd><kbd>D</kbd></td><td>转向<span class="hint">按住右键时变侧移</span></td></tr>
        <tr><td><kbd>Q</kbd><kbd>E</kbd></td><td>左右侧移<span class="hint">不改变朝向</span></td></tr>
        <tr><td><kbd>Space</kbd></td><td>跳跃<span class="hint">无二段跳</span></td></tr>
        <tr><td><kbd>滚轮</kbd></td><td>连续缩放<span class="hint">第一人称 ↔ 最远第三人称</span></td></tr>
        <tr><td><kbd>左键拖</kbd></td><td>只环绕镜头<span class="hint">★ 不改变角色朝向</span></td></tr>
        <tr><td><kbd>右键拖</kbd></td><td>镜头与朝向联动</td></tr>
        <tr><td><kbd>Home</kbd></td><td>镜头复位到背后</td></tr>
        <tr><td><kbd>F1</kbd></td><td>显示碰撞体与判定标记</td></tr>
        <tr><td><kbd>F2</kbd></td><td>画质档位<span class="hint">高 → 中 → 低</span></td></tr>
        <tr><td><kbd>M</kbd></td><td>静音开关<span class="hint">M12 音效</span></td></tr>
      </table>
      <!--
        P10：战斗段由场景在启动后**覆写**（TestbedScene.combatHelpHtml）——
        写死的那份是法师的技能表加「1–8 释放技能」：换成 ?class=warrior 之后
        整段全错，而技能栏其实是 9 格。这里留的是场景还没接手时的兜底文案，
        不列具体技能（列了就会撒谎）。
      -->
      <!-- margin 是补回来的：#help 的段间距靠「h3 + table + h3」相邻选择器，
           套了这层 div 之后那条链断了，两段会挤在一起 -->
      <div id="help-combat" style="margin:12px 0">
      <h3>战斗与技能</h3>
      <table>
        <tr><td><kbd>Tab</kbd> <kbd>⇧Tab</kbd></td><td>循环选择目标<span class="hint">镜头前方 140°/45m</span></td></tr>
        <tr><td><kbd>左键</kbd></td><td>点击角色或姓名板选中</td></tr>
        <tr><td><kbd>F</kbd></td><td>设为焦点<span class="hint">独立于硬目标</span></td></tr>
        <tr><td><kbd>Esc</kbd></td><td>取消瞄准 / 取消读条<span class="hint">假读条</span></td></tr>
      </table>
      </div>
      <h3>瞄准（M3）</h3>
      <table>
        <tr><td><kbd>6</kbd> <kbd>7</kbd></td><td>地面技能<span class="hint">进入落点预览</span></td></tr>
        <tr><td><kbd>左键</kbd></td><td>确认落点</td></tr>
        <tr><td><kbd>右键</kbd> <kbd>Esc</kbd></td><td>取消瞄准</td></tr>
        <tr><td><kbd>5</kbd></td><td>自身中心<span class="hint">冰霜新星，不需选目标</span></td></tr>
        <tr><td><kbd>4</kbd></td><td>变形术<span class="hint">连按三次看控制递减</span></td></tr>
      </table>
      <h3>该看什么</h3>
      <ul>
        <li><b>验收 #2</b>：左键拖动时看黄色箭头 —— 角色朝向<b>不动</b>，只有镜头在转</li>
        <li><b>验收 #3</b>：贴着墙走，镜头快速拉近；离开后平滑恢复，全程不穿墙</li>
        <li><b>验收 #44 #45</b>：楼梯平滑走上（不弹跳）；3 米高台跳不上去；空中画圈不增速</li>
        <li><b>验收 #15</b>：假人牧师在读条治疗 → 用 <kbd>3</kbd> 法术反制打断，看学派锁定 4 秒</li>
        <li><b>验收 #16</b>：物理射击被打断<b>不</b>产生学派锁定（施法条为金色独立配色）</li>
        <li><b>验收 #18</b>：<kbd>1</kbd> 起手读条后立刻 <kbd>Esc</kbd> —— 资源与冷却都不消耗</li>
        <li><b>验收 #19</b>：读条时跑出 32 米，完成瞬间会失败并说明「超出距离」</li>
        <li><b>验收 #13</b>：读条中被假人战士拳击打断；<b>普通伤害不会</b>打断（#14）</li>
        <li><b>7.5</b>：不可打断的技能施法条带 🛡 虚线边框</li>
        <li><b>验收 #6</b>：选中后跑到墙后 —— 目标<b>仍然保留</b>，但技能显示「缺少视线」</li>
        <li><b>验收 #8</b>：按 <kbd>6</kbd> 后把落点拖到墙后 —— 圆圈变<b>虚线+叉号+变暗</b>，左键点不下去</li>
        <li><b>5.5</b>：落点拖到 30 米外会被<b>钳制到边缘</b>，技能仍可释放</li>
        <li><b>17.2</b>：非法提示不只靠颜色 —— 虚线和叉号在色盲模式下同样可辨</li>
        <li><b>验收 #23</b>：<kbd>4</kbd> 变形术连放三次 —— 时长 4s → 2s → 1s → 免疫（8.2 递减）</li>
        <li><b>8.4</b>：<kbd>8</kbd> 寒冰屏障期间受到的伤害全部显示「免疫」</li>
        <li><b>14.3</b>：护盾承伤时日志显示吸收量，耗尽时单独提示「护盾破裂」</li>
      </ul>
    </div>
  </div>
`;

const STATE_LABEL: Record<string, string> = {
  idle: '待机', walk: '行走', run: '奔跑', backward: '后退',
  strafeLeft: '左侧移', strafeRight: '右侧移', jump: '跳跃',
  fall: '下落', land: '落地', stunned: '昏迷', death: '死亡',
};

/** 试验场左上角的调试面板（M1 起）。装配进 `stats` 元素，只在试验场分支使用 */
const makePaintStats = (stats: HTMLElement): ((d: DebugInfo) => void) => {
  let lastPaint = 0;
  return (d: DebugInfo): void => {
  // HUD 每 100ms 刷一次就够，别让 DOM 更新拖累帧率
  const now = performance.now();
  if (now - lastPaint < 100) return;
  lastPaint = now;

  // 4.2 / 6.5：镜头 yaw 与角色 yaw 是两个独立的值，差值不为 0 说明左键环绕生效了
  const yawGap = Math.abs(((d.cameraYaw - d.characterYaw) * RAD + 540) % 360 - 180);

  stats.innerHTML = `
    <div class="row"><span>FPS</span><b>${d.fps.toFixed(0)}</b></div>
    <div class="row"><span>位置</span><b>${d.position.x.toFixed(1)}, ${d.position.y.toFixed(2)}, ${d.position.z.toFixed(1)}</b></div>
    <div class="row"><span>速度</span><b>${d.speed.toFixed(2)} m/s</b><i>上限 ${MOVE.BASE_SPEED}</i></div>
    <div class="row"><span>着地</span><b class="${d.grounded ? 'ok' : 'warn'}">${d.grounded ? '是' : '否'}</b></div>
    <div class="row"><span>动作</span><b>${STATE_LABEL[d.animState] ?? d.animState}</b></div>
    <hr/>
    <div class="row"><span>镜头距离</span><b>${d.cameraDistance.toFixed(2)} m</b></div>
    <div class="row"><span>第一人称</span><b class="${d.firstPerson ? 'ok' : ''}">${d.firstPerson ? '是' : '否'}</b></div>
    <div class="row"><span>镜头 yaw</span><b>${(d.cameraYaw * RAD).toFixed(0)}°</b></div>
    <div class="row"><span>角色 yaw</span><b>${(d.characterYaw * RAD).toFixed(0)}°</b></div>
    <div class="row"><span>两者夹角</span><b class="${yawGap > 1 ? 'ok' : ''}">${yawGap.toFixed(0)}°</b><i>左键拖动应 ≠ 0</i></div>
    <hr/>
    <div class="row"><span>碰撞体</span><b>r=${GEOMETRY.HITBOX_RADIUS} h=${GEOMETRY.HITBOX_HEIGHT}</b></div>
    <div class="row"><span>可跨越高度</span><b>${GEOMETRY.STEP_HEIGHT} m</b></div>
    <div class="row"><span>最大选中距离</span><b>${RANGE.MAX_SELECT} m</b></div>
  `;
  };
};

/**
 * P2 压测面板（`?stress`）。**回答的是「12v12 掉不掉帧」，所以显示的是
 * 帧时间的分布而不是瞬时 FPS** —— 平均 60 帧但每秒卡一下 200ms 的体验
 * 是「卡」，瞬时读数看不出来，p95/最差帧才看得出来。
 *
 * ★ 采样窗口 3 秒滚动；`renderer.info` 是 three 每帧自己在统计的，零额外开销。
 */
const makePaintStress = (stats: HTMLElement): ((d: DebugInfo) => void) => {
  const frames: { at: number; ms: number }[] = [];
  let last = performance.now();
  let lastPaint = 0;
  let worst = 0;

  return (d: DebugInfo): void => {
    const now = performance.now();
    const ms = now - last;
    last = now;
    // 首帧与切标签页回来的巨大间隔不计（那不是渲染负载）
    if (ms > 0 && ms < 1000) {
      frames.push({ at: now, ms });
      if (ms > worst) worst = ms;
    }
    while (frames.length > 0 && now - frames[0]!.at > 3000) frames.shift();
    if (now - lastPaint < 250) return;
    lastPaint = now;

    const sorted = frames.map((f) => f.ms).sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;
    const fps = avg > 0 ? 1000 / avg : 0;
    // 60 帧 = 16.7ms。p95 超过 33ms（30 帧）就是肉眼可见的卡顿
    const cls = (v: number, ok: number, warn: number): string =>
      v <= ok ? 'ok' : v <= warn ? '' : 'warn';
    const r = d.render;

    stats.innerHTML = `
      <div class="row"><span>压测</span><b>${r?.entities ?? '?'} 实体同屏</b><i>?stress=&lt;人数&gt;</i></div>
      <hr/>
      <div class="row"><span>平均帧率</span><b class="${cls(1000 / Math.max(fps, 0.01), 17, 34)}">${fps.toFixed(0)} fps</b></div>
      <div class="row"><span>平均帧时间</span><b class="${cls(avg, 17, 34)}">${avg.toFixed(1)} ms</b></div>
      <div class="row"><span>p95 帧时间</span><b class="${cls(p95, 20, 40)}">${p95.toFixed(1)} ms</b><i>卡顿看这个</i></div>
      <div class="row"><span>最差帧</span><b class="${cls(worst, 34, 100)}">${worst.toFixed(0)} ms</b></div>
      <hr/>
      <div class="row"><span>绘制调用</span><b>${r?.calls ?? '?'}</b></div>
      <div class="row"><span>三角面</span><b>${((r?.triangles ?? 0) / 1000).toFixed(0)}k</b></div>
      <div class="row"><span>画质档</span><b>${r?.quality ?? '?'}</b><i>F2 切档</i></div>
      <hr/>
      <div class="row"><span>镜头距离</span><b>${d.cameraDistance.toFixed(1)} m</b><i>滚轮拉远看全场</i></div>
    `;
  };
};

/**
 * ★ 三条入口并存（P6 起默认落**主菜单**）：
 *   · `?net=<房间名>` 联网场景（M10 老路，verify 脚本靠它，原样保留）
 *   · `?testbed` 试验场（M1–M9 共 141 项验收的载体；`?tutorial=on` 与
 *     `?stress` 是它的子模式，带它们时可省 `testbed`）。其上再叠
 *     `?class=`（P5 职业）/`?bot=`（难度）/`?combat`（实战模式）/`?art=`。
 *   · **不带参数 = 主菜单（大厅入口页）** —— P6 用户拍板：「真正成体系的
 *     游戏不能让用户通过不同 URL 进入」。大厅连接是惰性的（只在建房/加房
 *     时连服务器），离线也能开；练习/教学从菜单点进去。
 *     `?lobby=<码>` 深链预填房间码，照旧。
 *
 *   ⚠️ 试验场从「默认路径」改为 `?testbed`：m1–m4/m8/m12 的 URL 同步加了
 *   前缀（**测试内容零变化**，docs/14 §M13 的「默认路径不变」红线自此
 *   改述为「?testbed 路径不变」—— 见 PROGRESS P6）。
 *
 *   其余参数：`server`（默认 ws://<当前主机>:8080）、`team`、`class`、`name`。
 *   例：`?net=r1&team=blue&class=warrior`、`?testbed&class=warrior&bot=hard&combat`
 *   `net=` 优先于一切 —— 老路的优先级不因新入口而变。
 */
const params = new URLSearchParams(location.search);
const room = params.get('net');
const serverUrl = params.get('server') ?? `ws://${location.hostname}:8080`;

if (room !== null) {
  const canvas = mountSceneDom();
  /**
   * W10（技术债总账）：撤掉试验场专用的帮助与调试面板。那份 #help 的标题
   * 是「M1 试验场 · 按规格书第 4/13 章验证」（假人验收清单、F1 调试……），
   * 对联网对局整个是误导；#stats 在这条分支上从来没人绘制过（空框）。
   * 联网的键位入口与读数由场景**自带**：SceneShell 提示条（#hint-bar）+ F10 设置面板
   * （含完整键位表）+ 右下角延迟/帧率 —— 大厅路径与老路因此同一份体验。
   */
  document.getElementById('help')?.remove();
  document.getElementById('stats')?.remove();
  const { NetworkScene } = await import('./scenes/NetworkScene.js');
  const net = new NetworkScene(canvas, {
    url: serverUrl,
    roomId: room || 'r1',
    name: params.get('name') ?? '玩家',
    team: (params.get('team') === 'blue' ? 'blue' : 'red'),
    classId: params.get('class') ?? 'mage',
  });
  // ★ 暴露给验收脚本读联网状态。与试验场的 onDebug 是同一个用途
  (globalThis as Record<string, unknown>).__net = net;
  net.start();
} else if (
  params.has('testbed') || params.get('tutorial') === 'on' || params.has('stress')
) {
  const canvas = mountSceneDom();
  /**
   * ★ `?tutorial=on` 走**教学舞台**（自己的地图 + 自己的假人布置），
   *   `?testbed` 是验收用的试验场 —— 场景行为与做默认路径时一个字节都没变。
   *   为什么两台戏不能共用一个舞台，见 `scenes/stages.ts` 的文件头。
   */
  const tutorialMode = params.get('tutorial') === 'on';
  /**
   * P2 压测台（`?stress` / `?stress=<人数>`）：24 个实体同屏开打，
   * 面板换成渲染负载读数。存在的理由是 X10 —— 12v12 的真机帧率从来没有
   * 数据。★ 与教学同一条机制：**只换舞台数据**。
   */
  const stressParam = params.get('stress');
  const stressMode = params.has('stress');
  const stage = stressMode
    ? stressStage(Number(stressParam) > 0 ? Number(stressParam) : undefined)
    : tutorialMode ? TUTORIAL_STAGE : TESTBED_STAGE;
  /**
   * P5：`?class=<职业id>` 在试验场直接玩别的职业（`?class=warrior&bot=hard`）。
   * 不带 class 仍是法师（验收初始条件）。非法职业 id 静默回落法师。
   * ★ 教学舞台不吃 class：课程以法师技能栏写死（docs/PROGRESS M15 已记）。
   */
  const classParam = params.get('class');
  const playerClass = !tutorialMode && classParam
    ? (getClass(classParam as never) ?? undefined) : undefined;
  const botParam = params.get('bot');
  const botDifficulty = botParam === 'easy' || botParam === 'hard' ? botParam : undefined;
  /**
   * ★★ P10：**练习场**（大厅「开始练习」跳来的 `?testbed&combat`）与
   *   **裸 `?testbed`**（开发入口，141 项验收的载体）自此分家。
   *
   *   分家的只有「开发化的那几块」：`#help` 是一份写着「M1 试验场 / 验收 #2 /
   *   F1 调试」的验收清单，`#stats` 是 FPS 与 yaw 读数 —— 联网分支早在 W10
   *   就把这两块 remove 掉了（那儿的注释写着「对玩家整个是误导」），而练习场
   *   这条路一直原样端给玩家。★ 复用的就是下面那**同样两行**。
   *   `?stress` 不在此列：它的读数面板就装在 `#stats` 里。
   */
  const practiceMode = params.has('combat') && !stressMode;
  if (practiceMode) {
    document.getElementById('help')?.remove();
    document.getElementById('stats')?.remove();
  }
  /**
   * C8：`&grace` 由大厅「开始练习」拼进来（A5）。★ 5 秒是**占位值** ——
   * 取「够把底部提示条读一遍」的量级，没有出处。verify 脚本不带 `&grace`
   * ⇒ 缺省 0 ⇒ 假人行为逐字节等于现状。
   */
  const graceSeconds = params.has('grace') ? 5 : 0;
  const scene = new TestbedScene(
    canvas,
    stressMode
      ? makePaintStress(document.getElementById('stats')!)
      // 练习场没有调试面板 ⇒ 连每 100ms 那次 innerHTML 拼装都不做
      : practiceMode ? (): void => {} : makePaintStats(document.getElementById('stats')!),
    stage,
    playerClass,
    botDifficulty,
    { ctfDemo: !practiceMode, graceSeconds },
  );
  /**
   * `#help` 的战斗段改成从**真实技能栏 + 真实键位**生成（见 combatHelpHtml）。
   * 练习场已经把 `#help` 整个 remove 了，所以这里查不到就跳过。
   */
  const helpCombat = document.getElementById('help-combat');
  if (helpCombat) helpCombat.innerHTML = scene.combatHelpHtml;
  // 压测要假人**真的在打**（站桩测不到特效负载）—— 与 K 键同一个开关；
  // P6：`?combat` 显式开实战（主菜单练习场走这里 —— 练习就是要有人打你）
  if (stressMode || params.has('combat')) scene.combatMode = true;
  // ★ 暴露给验收脚本读场景状态（M12 的美术自检、M9 的观战与可访问性）。
  //   与联网场景的 `__net` 是同一个用途
  (globalThis as Record<string, unknown>).__scene = scene;
  scene.start();
} else {
  /**
   * P6 默认入口 = 主菜单（大厅入口页）。用户拍板：「真正成体系的游戏，
   * 不能让用户通过不同的 URL 进入」。大厅连接惰性（建房/加房才连服务器），
   * 离线也能开 —— 练习场/教学从菜单里点。`?lobby=<码>` 深链照旧。
   */
  const { LobbyShell } = await import('./lobby/LobbyShell.js');
  const shell = new LobbyShell(app, {
    serverUrl,
    joinCode: params.get('lobby') || undefined,
    // 分享链接只在 URL **显式**给过 server 时才带它 —— 默认地址是
    // 「当前主机:8080」，对拿到链接的另一台机器未必成立
    explicitServer: params.get('server') ?? undefined,
  });
  // ★ 暴露给 verify:m13 读大厅状态。与 `__scene` / `__net` 同一个用途
  (globalThis as Record<string, unknown>).__lobby = shell;
  shell.mount();
}

/** 装配场景骨架并返回画布（试验场与 `?net=` 老路共用）*/
function mountSceneDom(): HTMLCanvasElement {
  app.innerHTML = SCENE_DOM;
  return document.getElementById('view') as HTMLCanvasElement;
}
