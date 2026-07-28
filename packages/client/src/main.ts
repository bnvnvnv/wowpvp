/**
 * 客户端入口。
 *
 * ⚠️ 当前是 **M0 工程连通性验证**，不是游戏客户端。
 * 它连接服务器、取回职业名录并渲染成表格，用来证明：
 *   1. `@wowpvp/shared` 能在浏览器里正常 import（几何库、常量、类型）
 *   2. 客户端与服务器的 WebSocket 通道可用
 *   3. 两端拿到的是同一份职业数据
 *
 * 3D 场景、镜头、输入是 M1 的工作，见 docs/07-client-render-camera.md。
 * 在此之前刻意不引入任何 three.js 代码 —— 避免搭一个之后要推倒重建的架子。
 */

import { GEOMETRY, MOVE, RANGE, hitCone, vec3 } from '@wowpvp/shared';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8080';

interface WeaponInfo {
  id: string;
  name: string;
  isDefault: boolean;
  swingInterval: number;
  swingPercent: number;
  reach: number;
  advantage: string;
  cost: string;
}

interface ClassInfo {
  id: string;
  name: string;
  role: string;
  baseHealth: number;
  resources: string[];
  strengths: string;
  weaknesses: string;
  skillCount: number;
  weapons: WeaponInfo[];
}

interface RosterMessage {
  t: 'Roster';
  tickRate: number;
  classes: ClassInfo[];
}

const app = document.getElementById('app')!;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const renderShell = (statusHtml: string, body = ''): void => {
  app.innerHTML = `
    <h1>wowpvp</h1>
    <p class="sub">网页 3D 多人 PVP 竞技场与夺旗战场 · M0 工程连通性验证</p>
    ${statusHtml}
    ${body}
    <div class="note">
      <strong>当前阶段：M0（文档与骨架）已完成，M1（3D 场景与镜头）未开始。</strong><br />
      本页刻意不含 3D 场景 —— 见 <code>docs/PROGRESS.md</code> 的「下一步」一节。<br />
      浏览器侧已验证可直接使用 shared 层：统一碰撞体半径
      <code>${GEOMETRY.HITBOX_RADIUS}m</code>、基础移动速度
      <code>${MOVE.BASE_SPEED}m/s</code>、最大选中距离
      <code>${RANGE.MAX_SELECT}m</code>。
    </div>
  `;
};

const renderClasses = (msg: RosterMessage): string => {
  const cards = msg.classes
    .map(
      (c) => `
      <div class="card">
        <h2>${esc(c.name)}</h2>
        <p class="role">${esc(c.role)}</p>
        <div class="stat">
          <span>生命 ${c.baseHealth}</span>
          <span>资源 ${c.resources.map(esc).join(' + ')}</span>
          <span>${c.skillCount} 个技能</span>
        </div>
        <p class="pro">优势：${esc(c.strengths)}</p>
        <p class="con">弱点：${esc(c.weaknesses)}</p>
        <table>
          <tr><th>武器方案</th><th>攻速</th><th>单击</th><th>距离</th></tr>
          ${c.weapons
            .map(
              (w) => `<tr>
                <td title="${esc(w.advantage)} / 代价：${esc(w.cost)}">
                  ${esc(w.name)}${w.isDefault ? '（默认）' : ''}
                </td>
                <td>${w.swingInterval}s</td>
                <td>${(w.swingPercent * 100).toFixed(0)}%</td>
                <td>${w.reach}m</td>
              </tr>`,
            )
            .join('')}
        </table>
      </div>`,
    )
    .join('');
  return `<div class="grid">${cards}</div>`;
};

/** 顺手做一次浏览器侧的几何自检：客户端与服务器必须调用同一份判定代码 */
const geometrySelfCheck = (): boolean => {
  const inFront = hitCone(vec3(0, 0, 0), 0, 90, 5, { position: vec3(0, 0, -4) });
  const behind = hitCone(vec3(0, 0, 0), 0, 90, 5, { position: vec3(0, 0, 4) });
  return inFront && !behind;
};

renderShell('<div class="status wait">正在连接服务器…</div>');

const socket = new WebSocket(WS_URL);

socket.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data as string) as RosterMessage;
  if (msg.t !== 'Roster') return;

  const geomOk = geometrySelfCheck();
  const status =
    `<div class="status ok">` +
    `✓ 已连接 ${WS_URL}　·　服务器 tick ${msg.tickRate}Hz　·　` +
    `收到 ${msg.classes.length} 个职业　·　` +
    `浏览器端几何判定自检 ${geomOk ? '通过' : '失败'}` +
    `</div>`;

  renderShell(status, renderClasses(msg));
});

socket.addEventListener('error', () => {
  renderShell(
    `<div class="status err">✗ 无法连接 ${WS_URL}<br />` +
      `请先在另一个终端运行 <code>pnpm dev:server</code></div>`,
  );
});

socket.addEventListener('close', () => {
  if (socket.readyState === WebSocket.CLOSED && !app.querySelector('.status.ok')) {
    renderShell(
      `<div class="status err">✗ 连接已关闭。请先运行 <code>pnpm dev:server</code></div>`,
    );
  }
});
