/**
 * 程序化技能图标。规格书 15.2 / 14.2 / 17.2。
 *
 * ★★ **为什么是画出来的，而不是下载 91 张图：**
 *
 *   docs/09 §5 已经把「表现层保持全程序化」写成一个有理有据的决定，
 *   并列了三条规格书要求恰好是程序化**更容易**满足的。技能图标同理：
 *
 *   | 要求 | 程序化的好处 |
 *   |---|---|
 *   | 17.2 界面缩放 | SVG 任意缩放不糊；位图精灵在 1.5× 下会毛 |
 *   | 17.2 不能只靠颜色区分 | 学派色 **+ glyph 形状 + 边框形状** 三通道，14.2 的表里本来就有 glyph |
 *   | 14.4 低画质不隐藏关键信息 | 图标不经过画质档位，天然不会被「关掉贴图」连累 |
 *   | 附录A#5 素材许可 | 没有文件 = 没有清单要填，也没有署名义务 |
 *
 *   ★ 而且它**跟着数据走**：加一个技能就自动有图标，不会出现
 *     「技能加了但图标没画」这种要等美术排期的空窗。
 *
 * ── ⚠️ 一条必须说清楚的局限 ──────────────────────────────────
 *
 *   **类别推导编码的是「这是什么」，不是「这是哪一个」。**
 *   实测：只用 学派×主效果×瞄准×形状×施放方式×冷却档 推导，
 *   同职业内仍会撞脸（圣骑士最差，3 个技能共用一个图标）。
 *
 *   所以最后叠一层**由技能 id 派生的确定性花纹**（`accentOf`）——
 *   ★ 它**不承载任何含义**，唯一职责是保证同职业内两两可分。
 *     把它说成「这个花纹代表某某」才是骗人。
 */

import { CastKind, getClass, type SkillDef } from '@wowpvp/shared';
import { cssColor, visualOf } from '../vfx/schools.js';
import { skillIconUrl } from './skillIconMap.js';

/** 图标的语义分类 —— 决定主形状。★ 顺序即优先级：一个技能可能既伤害又控制 */
const CORE_KINDS = [
  'heal', 'stun', 'incapacitate', 'fear', 'root', 'silence', 'disarm',
  'interrupt', 'dispel', 'enterStealth', 'shapeshift', 'damage',
] as const;
type CoreKind = (typeof CORE_KINDS)[number] | 'buff' | 'move';

const MOVE_KINDS = new Set([
  'pullTarget', 'teleportBehindTarget', 'charge', 'blink', 'knockback', 'leapBackward',
]);

/**
 * 把**嵌套**的效果一并摊平。
 *
 * ⚠️ **不摊平就会判错，而且错得很像对的。** 暴风雪的伤害在
 *   `spawnGroundArea.onTick` 里、陨星的在 `delayedGroundImpact.onImpact` 里、
 *   刺骨的在 `spendComboPoints.base` 里 —— 只看顶层的话它们全都落进
 *   `buff` 分支，于是三个纯输出技能显示成**盾牌图标**。
 *   ★ 这是截图比对抓到的：spec 值全对，语义全错。
 */
const flattenEffects = (effects: readonly { kind: string }[]): { kind: string }[] => {
  const out: { kind: string }[] = [];
  for (const e of effects) {
    out.push(e);
    const nested = e as Record<string, unknown>;
    for (const key of ['onTick', 'onImpact', 'onTrigger']) {
      const list = nested[key];
      if (Array.isArray(list)) out.push(...flattenEffects(list as { kind: string }[]));
    }
    if (nested['base']) out.push(...flattenEffects([nested['base'] as { kind: string }]));
    const aura = nested['aura'] as { periodic?: { effects?: { kind: string }[] } } | undefined;
    if (aura?.periodic?.effects) out.push(...flattenEffects(aura.periodic.effects));
  }
  return out;
};

const coreKindOf = (skill: SkillDef): CoreKind => {
  const all = flattenEffects(skill.effects);
  if (all.some((e) => MOVE_KINDS.has(e.kind))) return 'move';
  for (const k of CORE_KINDS) {
    if (all.some((e) => e.kind === k)) return k;
  }
  return 'buff';
};

/**
 * 主形状。**这一层是有含义的** —— 玩家学一次就能跨全部 91 个技能读懂。
 * 路径都画在 32×32 的视口里。
 */
const CORE_PATH: Record<CoreKind, string> = {
  // 伤害：尖角（向上的锐三角）
  damage: 'M16 5 L24 24 L16 20 L8 24 Z',
  // 治疗：十字
  heal: 'M13 8h6v5h5v6h-5v5h-6v-5H8v-6h5z',
  // 昏迷：断裂的环
  stun: 'M16 6a10 10 0 1 1-7 17l4-4a4.5 4.5 0 1 0 3-8z',
  // 迷惑：睡眠符号（三条渐大的横线）。★ 14.3 要求迷惑与昏迷视觉不同
  incapacitate: 'M11 10h6M10 16h9M9 22h12',
  // 潜行：半透的轮廓（虚线菱形由描边表达）
  enterStealth: 'M16 6l9 10-9 10-9-10z',
  // 形态切换：双向环箭
  shapeshift: 'M9 13a7 7 0 0 1 13-2M23 19a7 7 0 0 1-13 2M22 8v4h-4M10 24v-4h4',
  // 恐惧：波浪
  fear: 'M6 12q5-6 10 0t10 0M6 20q5-6 10 0t10 0',
  // 定身：锚形（向下的钉）
  root: 'M14 6h4v14h6l-8 8-8-8h6z',
  // 沉默：斜杠穿过的圆
  silence: 'M16 6a10 10 0 1 1 0 20 10 10 0 0 1 0-20M9 9l14 14',
  // 缴械：断柄
  disarm: 'M8 24 22 10M18 6l8 8M10 20l-4 4',
  // 打断：闪电折线
  interrupt: 'M18 5 10 17h5l-2 10 9-13h-5z',
  // 驱散：向上的三条弧
  dispel: 'M8 22q8-10 16 0M11 16q5-6 10 0M14 11q2-3 4 0',
  // 位移：箭头
  move: 'M6 16h14l-5-6 11 6-11 6 5-6H6z',
  // 增益/其他：盾形
  buff: 'M16 5l10 4v8c0 6-4 9-10 11-6-2-10-5-10-11V9z',
};

/**
 * 边框形状 —— 编码**瞄准方式**（5.4 六类）。
 * ★ 第二个「不靠颜色」的通道：单体是方角、范围是圆角、地面是菱形、自身是六边。
 */
const frameOf = (skill: SkillDef): { rx: number; rotate: number } => {
  switch (skill.targeting) {
    case 'ground': return { rx: 3, rotate: 45 };   // 地面：菱形
    case 'selfCenter':
    case 'self': return { rx: 14, rotate: 0 };      // 自身：圆
    case 'cone':
    case 'line':
    case 'projectile': return { rx: 9, rotate: 0 }; // 方向：大圆角
    default: return { rx: 3, rotate: 0 };           // 直接目标：方角
  }
};

/**
 * 确定性花纹。
 *
 * ⚠️ **它不代表任何东西** —— 唯一职责是让同职业内两两可分（见文件头）。
 *
 * ★★ **按「在本职业技能表里的序号」分配，而不是按 id 哈希。**
 *
 *   第一版用的是 id 哈希，理由是「加删技能时其他图标不会集体变样」。
 *   但哈希只能做到**大概率**不撞 —— 花纹空间 4×4=16，而一个职业有 11–13 个技能，
 *   生日碰撞是必然的。实测圣骑士和盗贼各撞了一对。
 *
 *   改成序号之后，同职业内两两不同是**构造上成立**的
 *   （序号互不相同，空间 16 ≥ 最大职业技能数 13），不再依赖运气。
 *
 * ⚠️ 代价：往一个职业中间插入技能，会让它后面所有技能的花纹平移一格。
 *   这个代价是值得的 —— 「图标偶尔变个花纹」远不如「两个技能长得一样」严重。
 */
const accentOf = (skill: SkillDef): { dots: number; angle: number } => {
  const siblings = getClass(skill.classId)?.skills ?? [];
  const i = siblings.findIndex((s) => s.id === skill.id);
  const idx = i < 0 ? 0 : i;
  return { dots: idx % 4, angle: Math.floor(idx / 4) % 4 };
};

/** 只描边不填充的形状 —— 它们是线条图形，填充会糊成一团 */
const OUTLINE_ONLY = new Set<CoreKind>([
  'fear', 'dispel', 'silence', 'disarm', 'incapacitate', 'shapeshift',
]);

/** 一个技能图标的**完整描述**。测试断言它，不必解析 SVG 字符串 */
export interface SkillIconSpec {
  core: CoreKind;
  rx: number;
  rotate: number;
  glyph: string;
  primary: string;
  secondary: string;
  dots: number;
  angle: number;
  /** 施放方式的角标：读条/引导/瞄准射击各有一道边（瞬发没有）*/
  castMark: '' | 'cast' | 'channel' | 'aimed';
}

export const skillIconSpec = (skill: SkillDef): SkillIconSpec => {
  const v = visualOf(skill);
  const f = frameOf(skill);
  const a = accentOf(skill);
  const castMark =
    skill.cast.kind === CastKind.Instant ? ''
      : skill.cast.kind === CastKind.Channel ? 'channel'
        : skill.cast.kind === CastKind.AimedShot ? 'aimed' : 'cast';
  return {
    core: coreKindOf(skill),
    rx: f.rx,
    rotate: f.rotate,
    glyph: v.glyph,
    primary: cssColor(v.primary),
    secondary: cssColor(v.secondary),
    dots: a.dots,
    angle: a.angle,
    castMark,
  };
};

/**
 * 生成内联 SVG。★ 不引用任何外部文件，也不依赖字体以外的东西。
 *
 * `size` 由调用方给，SVG 自身用 viewBox 缩放 —— 17.2 的界面缩放因此免费成立。
 */
export const skillIconSvg = (skill: SkillDef, size = 28): string => {
  const s = skillIconSpec(skill);
  const gid = `g${(skill.id as string).replace(/[^a-z0-9]/gi, '')}`;

  // 花纹：0–3 个小点沿一条由 angle 决定的边排布。纯装饰，见 accentOf
  const dots = Array.from({ length: s.dots }, (_, i) => {
    const base = [[4, 4], [28, 4], [28, 28], [4, 28]][s.angle]!;
    const dx = s.angle % 2 === 0 ? i * 5 : 0;
    const dy = s.angle % 2 === 1 ? i * 5 : 0;
    return `<circle cx="${base[0]! + dx}" cy="${base[1]! + dy}" r="1.3" fill="${s.secondary}" opacity=".85"/>`;
  }).join('');

  const castStroke = s.castMark === ''
    ? ''
    : `<rect x="1.5" y="1.5" width="29" height="29" rx="${s.rx}" fill="none"
         stroke="${s.secondary}" stroke-width="1.5" opacity=".9"
         ${s.castMark === 'channel' ? 'stroke-dasharray="3 3"' : ''}
         ${s.castMark === 'aimed' ? 'stroke-dasharray="8 3"' : ''}/>`;

  return `<svg class="sk-icon" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${s.primary}" stop-opacity=".38"/>
    <stop offset="1" stop-color="${s.primary}" stop-opacity=".10"/>
  </linearGradient></defs>
  <g transform="rotate(${s.rotate} 16 16)">
    <rect x="1" y="1" width="30" height="30" rx="${s.rx}" fill="url(#${gid})" stroke="${s.primary}" stroke-width="1.2"/>
    ${castStroke}
  </g>
  <path d="${CORE_PATH[s.core]}" fill="${OUTLINE_ONLY.has(s.core) ? 'none' : s.primary}"
        stroke="${s.primary}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  <text x="26" y="30" font-size="9" fill="${s.secondary}" opacity=".9">${s.glyph}</text>
</svg>`;
};

// ── M12：真实图标（素材缺失时整体回落程序化 SVG）──────────────────

/**
 * 素材可用性开关。
 *
 * ★ **一次探测，而不是每个 <img> 各自 onerror** —— HUD 每 50ms 重建一次
 *   innerHTML，逐 img 兜底意味着素材缺失时每秒发几十个注定 404 的请求。
 *   这里在启动时 HEAD 一张已知图标：成功则全体启用，失败则全体回落。
 *
 * ★ 默认 **false**（先画程序化 SVG）：宁可素材晚 ~100ms 淡入，
 *   也不要在无素材环境里闪一排裂图 —— M1–M10 验收不依赖素材，这条路径必须稳。
 */
let remoteIconsAvailable = false;

export const probeIconAssets = async (): Promise<boolean> => {
  try {
    const probe = skillIconUrl('mage.frostbolt');
    if (!probe) return false;
    const res = await fetch(probe, { method: 'HEAD' });
    remoteIconsAvailable = res.ok;
  } catch {
    remoteIconsAvailable = false;
  }
  return remoteIconsAvailable;
};

/** 测试与验收脚本用：强制指定图标来源 */
export const setRemoteIconsAvailable = (v: boolean): void => {
  remoteIconsAvailable = v;
};

/**
 * 技能图标 HTML：有素材用真实图标，否则用程序化 SVG。
 *
 * ★ 两条路径都带 `sk-icon` class —— 验收脚本与 CSS 不感知图标来源。
 * ★ img 不配 onerror：映射表由 `skillIconMap.test.ts` 对着磁盘文件校验，
 *   运行时 404 只剩「整个素材目录不存在」一种情况，已由上面的探测兜住。
 */
export const skillIconHtml = (skill: SkillDef, size = 28): string => {
  const url = remoteIconsAvailable ? skillIconUrl(skill.id as string) : undefined;
  if (!url) return skillIconSvg(skill, size);
  return `<img class="sk-icon sk-img" src="${url}" width="${size}" height="${size}" alt="" draggable="false" loading="lazy"/>`;
};
