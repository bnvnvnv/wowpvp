/**
 * 客户端入口。
 *
 * **M1：3D 场景 + 自由镜头 + 移动物理。**
 * 这是规格书 4.x 与 13.5 的可验证载体 —— 验收 #1/#2/#3/#44/#45/#47 在这里人工确认。
 *
 * 战斗、目标选择、技能是 M2–M4，见 docs/PROGRESS.md。
 */

import { GEOMETRY, MOVE, RANGE } from '@wowpvp/shared';
import { probeIconAssets } from './hud/skillIcon.js';
import { artEnabled } from './settings/artMode.js';
import { TestbedScene, type DebugInfo } from './scenes/TestbedScene.js';
import { TESTBED_STAGE, TUTORIAL_STAGE } from './scenes/stages.js';

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
      <h3>M1 试验场 · 按规格书第 4 / 13 章验证</h3>
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
      <h3>战斗（M2）</h3>
      <table>
        <tr><td><kbd>Tab</kbd> <kbd>⇧Tab</kbd></td><td>循环选择目标<span class="hint">镜头前方 140°/45m</span></td></tr>
        <tr><td><kbd>左键</kbd></td><td>点击角色或姓名板选中</td></tr>
        <tr><td><kbd>F</kbd></td><td>设为焦点<span class="hint">独立于硬目标</span></td></tr>
        <tr><td><kbd>1</kbd>–<kbd>8</kbd></td><td>释放技能</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>取消瞄准 / 取消读条<span class="hint">假读条</span></td></tr>
      </table>
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
 * ★ 三条入口并存。`?net=<房间名>` 进联网场景（M10 老路，全部 verify 脚本
 *   靠它，**原样保留**）；`?lobby` 进大厅（M13，纯 UI 的建房/加房流程，
 *   `?lobby=<码>` 深链预填房间码）；不带参数进试验场 ——
 *   试验场是 M1–M9 共 141 项验收的载体，**默认路径不能变**（docs/14 §M13 红线）。
 *
 *   其余参数：`server`（默认 ws://<当前主机>:8080）、`team`、`class`、`name`。
 *   例：`?net=r1&team=blue&class=warrior`、`?lobby=K7XQ`
 *   `net=` 与 `lobby` 同时出现时 net= 优先 —— 老路的优先级不因新入口而变。
 */
const params = new URLSearchParams(location.search);
const room = params.get('net');
const serverUrl = params.get('server') ?? `ws://${location.hostname}:8080`;

if (room !== null) {
  const canvas = mountSceneDom();
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
} else if (params.has('lobby')) {
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
} else {
  const canvas = mountSceneDom();
  /**
   * ★ `?tutorial=on` 走**教学舞台**（自己的地图 + 自己的假人布置），
   *   不带参数仍是验收用的试验场 —— 默认路径一个字节都没变。
   *   为什么两台戏不能共用一个舞台，见 `scenes/stages.ts` 的文件头。
   */
  const tutorialMode = params.get('tutorial') === 'on';
  const scene = new TestbedScene(
    canvas,
    makePaintStats(document.getElementById('stats')!),
    tutorialMode ? TUTORIAL_STAGE : TESTBED_STAGE,
  );
  // ★ 暴露给验收脚本读场景状态（M12 的美术自检、M9 的观战与可访问性）。
  //   与联网场景的 `__net` 是同一个用途
  (globalThis as Record<string, unknown>).__scene = scene;
  scene.start();
}

/** 装配场景骨架并返回画布（试验场与 `?net=` 老路共用）*/
function mountSceneDom(): HTMLCanvasElement {
  app.innerHTML = SCENE_DOM;
  return document.getElementById('view') as HTMLCanvasElement;
}
