/**
 * 试验场侧的 `CombatView` 实现 —— `CombatDirector` 外面薄薄的一层。
 *
 * ★★ **它存在的唯一理由是 X17 的光环行**（`HudUnit.auras`）。
 *   `CombatEntity` 结构上本来就满足 `HudUnit`，所以 M11 之后试验场是把
 *   `CombatDirector` 直接喂给 HUD 的、中间一层都没有。但光环**不在实体上**
 *   （它们住在 `AuraStore` 里，`aurasOf(store, id)` 才取得到），而
 *   `CombatDirector.player` 是一个 `readonly` **字段**、类内上百处直接用它 ——
 *   要给它挂光环就得先把字段改成 getter，那是一次与光环行毫无关系的大改。
 *
 *   所以改在**外面**：这一层只把 player / target / focus 三个单位换成
 *   「浅拷贝 + auras」，其余全部原样转发。
 *
 * ★ **只有这三个单位需要拷贝** —— HUD 的光环行只画目标框、焦点框和自己
 *   （`CombatHud.renderUnitFrame` / `renderSelfAuras`）。姓名板不读光环，
 *   所以 `visibleUnits()` 原样返回实体本身，12v12 里不会每帧多出 24 个拷贝。
 *
 * ⚠️ 拷贝是**浅**的：position / flags / resources 都还是同一批引用，读到的
 *   永远是当前帧的真值。反过来说，**没有人该往这些拷贝上写** —— 写了会
 *   丢。HUD 是只读消费方，这条约束天然成立；将来若有人想拿
 *   `view.player` 去改状态，正确的做法是拿 `dir.player`。
 *
 * ★ 与 `net/SnapshotCombatView.ts` 是同一件事的两半：一个把快照转成 HUD 的
 *   窄接口，一个把本地模拟转成同一个窄接口。同一个 `CombatHud` 两边都能喂。
 */

import {
  aurasOf,
  getEntity,
  type CastState,
  type CombatEntity,
  type EntityId,
  type SkillDef,
} from '@wowpvp/shared';

import { auraSchoolById } from '../data/auraRegistry.js';
import type { CombatDirector } from '../combat/CombatDirector.js';
import type {
  CombatView, HudAura, HudLogEntry, HudSkillSlot, HudUnit,
} from '../hud/CombatView.js';

/**
 * 某个实体身上的光环 → HUD 形状。
 *
 * ★ 本地模拟这边**什么都查得到**（`AuraDef` 就在手里），所以 kind / school /
 *   name 一律如实填。
 * ★★ **X26 收口：`school` 走注册表，不走手里这份 `AuraDef`。**
 *   联网侧 `toHudAura` 用的是「`def.school` 查不到就问**施加它的技能**」这条
 *   两级回落，而 63 枚光环里有 **53 枚**自己不写 `school`（断筋、审判、
 *   剑刃风暴…）。本地只读 `a.def.school` 的话，同一枚断筋在试验场是中性灰
 *   `#9aa3b6`、在联网局是钢铁色 `#d8cbb4` —— 判据从一处变成了两处。
 *   现在两条投影都调 `auraSchoolById`（同 `vfx/debuffAura.ts` 的纪律：
 *   手里有 def 也照样走同一张表）。
 * ★ 优先级与联网侧对齐：**实例 > 注册表**。`control.*` 的学派是 sim 施加时
 *   算出来的、写在实例的 def 上，注册表查不到它 —— 所以实例那份排前面。
 * ★ `expiresAt` 直接给：persistent 光环在 sim 里本来就是 `Infinity`
 *   （`AuraInstance.expiresAt` 的注释），而 `auraRowModel` 对 `Infinity`
 *   不画倒计时 —— 两边口径已经对上，这里不需要转换。
 */
export const hudAurasOf = (dir: CombatDirector, id: EntityId): HudAura[] =>
  aurasOf(dir.auras, id).map((a) => {
    const school = a.def.school ?? auraSchoolById(a.def.id);
    return {
      id: a.def.id,
      kind: a.def.kind,
      expiresAt: a.expiresAt,
      stacks: a.stacks,
      ...(school !== undefined ? { school } : {}),
      ...(a.absorbRemaining > 0 ? { absorbRemaining: a.absorbRemaining } : {}),
      ...(a.absorbInitial > 0 ? { absorbInitial: a.absorbInitial } : {}),
      name: a.def.name,
    };
  });

export class LocalCombatView implements CombatView {
  constructor(private readonly dir: CombatDirector) {}

  get now(): number { return this.dir.now; }
  get player(): HudUnit { return this.withAuras(this.dir.player); }

  get target(): HudUnit | undefined {
    const t = this.dir.target;
    return t === undefined ? undefined : this.withAuras(t);
  }

  get focus(): HudUnit | undefined {
    const f = this.dir.focus;
    return f === undefined ? undefined : this.withAuras(f);
  }

  get playerCast(): CastState | undefined { return this.dir.playerCast; }
  get skills(): readonly SkillDef[] { return this.dir.skills; }
  get log(): readonly HudLogEntry[] { return this.dir.log; }

  /** ★ 姓名板不画光环行，所以这里不拷贝（见文件头） */
  visibleUnits(): readonly HudUnit[] { return this.dir.visibleEntities(); }

  skillSlots(): readonly HudSkillSlot[] { return this.dir.skillSlots(); }
  selectById(id: number): void { this.dir.selectById(id); }

  castOf(unit: HudUnit): CastState | undefined {
    const e = this.entityOf(unit);
    return e === undefined ? undefined : this.dir.castOf(e);
  }

  distanceTo(unit: HudUnit): number {
    const e = this.entityOf(unit);
    // ★ 回到 director 自己那把尺子，不在这里重算一遍平面距离 ——
    //   重算必然漂移，而漂移的方向是「目标框显示的米数与技能栏的判定不一致」
    return e === undefined ? 0 : this.dir.distanceTo(e);
  }

  /**
   * 从 HUD 单位回到真正的实体。
   * ★ 传进来的单位一定是上面三个 getter 刚刚从世界里取出来的，查不到只可能
   *   发生在「同一帧里实体被移除了」—— 结构上做不到（HUD 的调用是同步的）。
   */
  private entityOf(unit: HudUnit): CombatEntity | undefined {
    return getEntity(this.dir.world, unit.id);
  }

  private withAuras(e: CombatEntity): HudUnit {
    return { ...e, auras: hudAurasOf(this.dir, e.id) };
  }
}
