/**
 * 小地图。规格书 15.1（右上区）+ 15.4（夺旗永久显示旗手与掉落旗帜）。
 *
 * 15.1 右上：「小地图、己方玩家、已发现敌人、主要目标、掉落旗帜和补给点」
 * 15.4 夺旗：「小地图永久显示双方旗手和掉落旗帜」
 * 15.4 竞技场：「不显示任何旗帜信息」—— 由 ModeHud 的类型收窄保证，见那边文件头
 *
 * ★ 两条容易做错的：
 *
 *   1. **验收 #5：未被发现的潜行目标不能被小地图选中/显示。**
 *      小地图最容易变成潜行的克星 —— 服务器把所有实体位置发过来，
 *      客户端画个点就等于自动透视。所以 `blips` 的入口**只接受已过滤的列表**，
 *      本文件不接触世界状态、也没有能力去查"所有实体"。
 *      过滤是 M9 网络层（`net/visibility.ts`）的职责。
 *
 *   2. **12.2：旗帜信息对双方持续可见，旗手位置不受潜行影响。**
 *      这与上一条方向相反 —— 潜行的旗手，**人要隐、旗要显**。
 *      所以旗手 blip 与角色 blip 是两种不同的 kind，分别过滤。
 *
 * 用 canvas 画而不是 DOM：blip 数量在 12v12 下可能到 24+，
 * 每帧重建 24 个 div 会重演 M4 那次把帧率从 25 拖到 12 的事故。
 */

import { isEssential } from '../render/quality.js';
import type { MinimapBlip } from './ModeHud.js';

const SIZE = 168;
/** 小地图显示的世界半径（米）。夺旗图很大，只显示身边一圈 */
const DEFAULT_VIEW_RADIUS = 90;

const BLIP_STYLE: Record<MinimapBlip['kind'], { color: string; r: number; glyph?: string }> = {
  self: { color: '#ffffff', r: 3.5 },
  ally: { color: '#6fd0ff', r: 2.8 },
  enemy: { color: '#ff7a6f', r: 2.8 },
  objective: { color: '#ffd76a', r: 3.2 },
  // 17.2：旗手与掉落旗帜不能只靠颜色区分，各带一个字形
  flagCarrier: { color: '#ffd76a', r: 4.2, glyph: '⚑' },
  droppedFlag: { color: '#e0c07e', r: 3.6, glyph: '⚐' },
  supply: { color: '#9ad48f', r: 3, glyph: '✚' },
};

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private viewRadius = DEFAULT_VIEW_RADIUS;

  constructor(container: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.id = 'minimap';
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = SIZE * dpr;
    this.canvas.height = SIZE * dpr;
    this.canvas.style.width = `${SIZE}px`;
    this.canvas.style.height = `${SIZE}px`;
    wrap.appendChild(this.canvas);
    container.appendChild(wrap);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('小地图无法获取 2d 上下文');
    this.ctx = ctx;
    this.ctx.scale(dpr, dpr);
  }

  setViewRadius(m: number): void {
    this.viewRadius = Math.max(10, m);
  }

  /**
   * 画一帧。
   *
   * @param blips **已经过可见性过滤**的列表。本方法不做任何可见性判断 ——
   *              它拿不到世界状态，所以不可能意外画出未被发现的潜行者（验收 #5）。
   * @param centerX / centerZ 视野中心，通常是玩家自己
   * @param yaw 玩家朝向，用于把地图转成"上方 = 前方"
   */
  draw(
    blips: readonly MinimapBlip[],
    centerX: number,
    centerZ: number,
    yaw: number,
  ): void {
    const c = this.ctx;
    const half = SIZE / 2;
    c.clearRect(0, 0, SIZE, SIZE);

    // 底盘
    c.fillStyle = 'rgba(16,19,25,.85)';
    c.beginPath();
    c.arc(half, half, half - 1, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#3a4150';
    c.lineWidth = 1;
    c.stroke();

    // 朝向楔形：让"上方 = 前方"有个参照
    c.fillStyle = 'rgba(255,255,255,.08)';
    c.beginPath();
    c.moveTo(half, half);
    c.arc(half, half, half - 2, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    c.closePath();
    c.fill();

    const scale = (half - 8) / this.viewRadius;
    // yaw=0 面向 −Z（vec3.ts 的约定），所以旋转量取 −yaw 才能让前方朝上
    const cos = Math.cos(-yaw);
    const sin = Math.sin(-yaw);

    // 旗帜相关的 blip 最后画 —— 12.2 要求旗帜信息持续可见，
    // 压在角色点下面就等于时隐时现
    const ordered = [...blips].sort(
      (a, b) => Number(isFlagKind(a.kind)) - Number(isFlagKind(b.kind)),
    );

    for (const b of ordered) {
      const dx = b.x - centerX;
      const dz = b.z - centerZ;
      // 先旋转到屏幕坐标：+Z 向下
      let sx = dx * cos - dz * sin;
      let sy = dx * sin + dz * cos;
      sx *= scale;
      sy *= scale;

      const dist = Math.hypot(sx, sy);
      const maxR = half - 8;
      let clamped = false;
      if (dist > maxR) {
        // 12.2：旗帜信息**持续**可见 —— 超出视野时贴在边缘而不是消失
        if (isFlagKind(b.kind)) {
          sx = (sx / dist) * maxR;
          sy = (sy / dist) * maxR;
          clamped = true;
        } else {
          continue;
        }
      }

      const st = BLIP_STYLE[b.kind];
      const px = half + sx;
      const py = half + sy;

      c.fillStyle = st.color;
      c.globalAlpha = clamped ? 0.75 : 1;
      c.beginPath();
      c.arc(px, py, st.r, 0, Math.PI * 2);
      c.fill();
      if (st.glyph) {
        c.globalAlpha = 1;
        c.fillStyle = '#14171d';
        c.font = '700 8px ui-monospace, monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(st.glyph, px, py + 0.5);
      }
      c.globalAlpha = 1;
    }
  }
}

const isFlagKind = (k: MinimapBlip['kind']): boolean =>
  k === 'flagCarrier' || k === 'droppedFlag';

/**
 * 自检：旗手是 14.4 的关键角色，任何画质下都必须可见。
 * 小地图不看画质档位，这里只是把这条约束显式记下来 ——
 * 以后有人想给小地图加"低画质省点开销"时会先撞到它。
 */
if (!isEssential('flagCarrier')) {
  throw new Error('flagCarrier 必须是 ESSENTIAL_ROLES 成员（14.4）');
}
