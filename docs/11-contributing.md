# 扩展指南

> 本文回答一个问题：**「我想加个东西，要改哪些文件？」**
> 目标是让绝大多数扩展只需要**写数据，不碰引擎**。

## 0. 动手之前

1. 读 [PROGRESS.md](PROGRESS.md) 确认当前进度，别做别人正在做的
2. 你要加的东西在 [00-design-spec.md](00-design-spec.md) 里有对应条款吗？
   - **有** → 照着实现，在提交信息里引用章节号
   - **没有** → 这是新设计。先在 PR 里说清楚为什么，并同步更新
     [10-acceptance-tracking.md](10-acceptance-tracking.md) 的「已知偏差」
3. 跑一遍 `pnpm test && pnpm typecheck`，确认你是在一个绿的基线上开始

---

## 1. 加一个技能

**改一个文件**：`packages/shared/src/data/classes/<职业>.ts`

在 `skills` 数组里加一个 `SkillDef`。TypeScript 会强制你填齐附录A#3 的九项：

```ts
{
  id: asSkillId('warrior.shockwave'),
  name: '震荡波',
  classId: CLASS_ID,

  // ① 目标类型  ② 距离  ③ 形状
  targeting: Targeting.Cone,
  targetFilter: TargetFilter.Enemy,
  range: { min: 0, max: 10 },
  shape: { kind: 'cone', angleDeg: 60, range: 10 },

  // ④ 施放时间  ⑤ 是否可移动  ⑥ 是否可打断
  cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },

  // ⑦ 学派  ⑧ 冷却
  school: School.Physical,
  cooldown: 40,
  triggersGcd: true,
  cost: { resource: Resource.Rage, amount: 30 },

  // ⑨ 反制方式 —— 写人话，这段会直接进 HUD tooltip 和自动生成的检查表
  counters: '锥形范围，站到侧后方即可完全规避；昏迷受控制递减，可被战斗意志解除。',

  effects: [
    { kind: 'damage', school: School.Physical, amount: { weaponPercent: 0.75 } },
    { kind: 'stun', duration: 2 },
  ],
  description: '震荡身前扇形范围内的敌人，造成伤害并昏迷 2 秒。',
}
```

然后：

```bash
pnpm test    # 数据完整性测试会检查 id 前缀、counters 长度、距离上限等
pnpm docs    # 重新生成 docs/04-class-skill-matrix.md
```

**不需要**改引擎，只要你用的 `EffectDef.kind` 都是已注册的。

### 常见坑

| 坑 | 规则 |
|---|---|
| 打断技能填了 `triggersGcd: true` | 7.2：专用打断不触发公共冷却。测试会拦下 |
| 瞬发技能填了 `interruptible: true` | 7.1：瞬发不能被普通打断。测试会拦下 |
| `range.max` 填了 50 | 6.1：最大选中距离 45 米。测试会拦下 |
| `counters` 写「无」或留空 | 附录A#3 要求写明反制方式。测试会拦下 |
| 减速填成了 `drCategory: Root` | 8.2：定身与普通减速是**两条独立的链**，减速不参与递减 |

---

## 2. 加一个职业

**两个文件**：

1. 新建 `packages/shared/src/data/classes/<新职业>.ts`
   —— 复制 `warrior.ts` 作为模板，它是刻意维护的范本
2. 在 `packages/shared/src/data/index.ts` 的 `ALL_CLASSES` 里加一行

必须满足（测试会检查）：

- 恰好 3 套武器方案，其中恰好 1 套 `isDefault: true`
- 恰好 1 套 `isDefault: true` 的护甲（用 `makeArmorSet` 工厂生成全套）
- **至少一个专用打断或等价沉默**（验收 #21）
- 所有技能 id 以 `<职业id>.` 开头
- 有明确的 `role` / `strengths` / `weaknesses`

**不需要**改：注册表索引、文档、UI 职业列表 —— 全部从 `ALL_CLASSES` 派生。

---

## 3. 加一件武器或护甲

**改一个文件**：对应职业文件的 `weapons` / `armors` 数组。

附录A#4 强制六项：所属职业、攻击间隔、距离、优势、代价、改变的技能。

**关键约束（验收 #32 / 规格书 17.1）**：必须是**横向取舍**。
测试会断言没有任何护甲同时提高防御、移动和输出。武器同理 ——
如果你加的武器在每个维度都不比现有的差，那它就是上位装备，不该存在。

```ts
{
  id: asWeaponId('warrior.polearm'),
  name: '长柄战斧',
  classId: CLASS_ID,
  isDefault: false,
  handedness: 'twoHand',
  swingInterval: 2.6,        // 慢
  swingPercent: 1.7,         // 但单击最高
  reach: RANGE.MELEE_POLEARM, // 3.8 米，触及最远
  modifiers: { damageTaken: 1.12, moveSpeed: 0.95 },  // ← 代价
  advantage: '触及距离最远，单击伤害最高',
  cost: '攻速最慢，防御 -12%，移动 -5%',
  grantsSkills: [asSkillId('warrior.sweeping_strike')],
  removesSkills: [asSkillId('warrior.shield_slam')],
}
```

护甲请优先用 `makeArmorSet` 的 `overrides` 参数微调，而不是手写整套 ——
工厂保证了五种原型之间的取舍结构一致。

---

## 4. 加一种全新机制（需要动引擎）

只有当现有 `EffectDef.kind` 都表达不了时才走这条路。**两步，都是「加」不是「改」**：

### 第 1 步：在 `schema.ts` 的 `EffectDef` 联合类型里加一个成员

```ts
export type EffectDef =
  | …
  /** 把目标的一个增益偷到自己身上 */
  | { kind: 'stealBuff'; count: number; onlyDispellable: boolean };
```

### 第 2 步：在 `sim/effects/` 注册处理器

```ts
registerEffect('stealBuff', (ctx, effect, targets) => { … });
```

`EffectDef` 是可辨识联合，**漏注册会编译报错**，不会静默失效。

### 逃生舱：`{ kind: 'custom', handler: '…' }`

确实一次性、确实无法数据化的机制（例如德鲁伊野性冲锋按形态分三种位移），
可以用 custom handler，但**必须在代码注释里写明为什么不能数据化**。

当前所有 custom handler 及其原因登记在 [PROGRESS.md](PROGRESS.md) 的「技术债」一节。
如果同一类 custom 出现了三次以上，说明 schema 缺一个正式 kind —— 请提炼它。

---

## 5. 加一张地图

**改一个文件**：新建 `packages/shared/src/data/maps/<地图>.ts`

地图是 AABB 组合 + 出生点 + 补给点 + 旗帜点 + 复活区。详见
[06-modes-and-maps.md](06-modes-and-maps.md) 的地图数据格式一节。

必须满足（规格书 11.3 公平约束）：

- 双方出生点到中央与主要补给点的距离基本一致
- 柱子和墙体提供视线博弈，但**不能形成无限绕柱或永久安全点**
- 不设置只有特定位移职业才能到达的高台
- 玩家不能重新进入准备区躲避；地图边界和观众席不可进入
- 低矮栏杆记得标 `blocksSight: false`（6.4：不应频繁造成「无视线」）

---

## 6. 加一种视觉表现

**改一个文件**：`packages/client/src/vfx/` 的注册表。

技能数据里的 `vfx` 字段是一个字符串键，客户端按键查表。
键不存在时回退到该学派的默认表现，**不会崩溃也不会不可见** ——
14.4 要求关键信息在任何情况下都不能消失。

必须满足 14.3：

- 地面危险区域的**真实边界**在整个有效期内持续显示，装饰粒子可以淡出，边界不能消失
- 环形技能必须**同时**显示内圈和外圈
- 延迟技能显示落点和倒计时
- 定身附着脚部、昏迷显示头顶标记、沉默与恐惧使用**不同**视觉
- 护盾需要激活/承伤/衰减/破裂四种不同反馈

---

## 7. 素材（模型、贴图、音效、图标、字体）

**先登记，后使用。** 顺序不能反。

1. 在 [09-asset-license.md](09-asset-license.md) 里登记：名称、作者、来源、许可证、
   署名要求、商业使用、修改和再分发条件
2. 确认是 CC0 或明确允许本项目用途的许可证
3. 才能把文件放进 `assets/`

**绝对不能进仓库的**：
- 暴雪的角色模型、纹理、技能图标、地图文件、Logo、音频（规格书 18.3）
- CraftPix 技能图标、参考项目的定制武器/商店图/成就图标/品牌标识（18.2）
- 任何未登记或授权不清晰的素材（18.2 / 验收 #51）

---

## 8. 提交前检查清单

```bash
pnpm typecheck   # 全量类型检查
pnpm test        # 数据完整性 + 几何判定 + 战斗规则
pnpm docs        # 若改了职业数据，重新生成检查表
```

然后确认：

- [ ] 数值改动在 [00-design-spec.md](00-design-spec.md) 里有依据，或已登记为「已知偏差」
- [ ] 没有在客户端单独实现任何命中判定（必须调用 `shared/math/geometry.ts`）
- [ ] 没有让客户端决定伤害、命中、拾取归属
- [ ] 更新了 [PROGRESS.md](PROGRESS.md)
- [ ] 若完成了某条验收标准，更新了 [10-acceptance-tracking.md](10-acceptance-tracking.md)
- [ ] **没有用伪代码或占位图冒充完成**（附录A#7）

## 9. 代码风格

- 注释用中文，说明**为什么**而不是**做什么**；引用规格书章节号
- 数值常量放 `constants/combat.ts`，不要散落在各处魔法数字
- `shared` 不许 import 任何 `three`、DOM API 或 Node 内置模块
- 测试文件与实现同目录，命名 `<模块>.test.ts`
- 一个测试 describe 对应一条规格书规则或一条验收标准，标题里写清楚是哪条
