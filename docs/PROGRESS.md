# 完成情况与下一步

> **这是零上下文接手时应该读的第一份文件。**
> 每完成一块工作都要更新这里。宁可写「未完成」，也不要写「已完成（待完善）」（附录A#7）。

**最后更新**：2026-07-28
**当前里程碑**：M0 已完成，M1 未开始

---

## 一句话现状

八职业的全部技能与装备数据已落地并通过完整性测试，命中几何库已实现并通过测试，
文档体系齐备。**但游戏还不能跑** —— 还没有渲染、没有模拟循环、没有服务器。
下一步是 M1（3D 场景 + 镜头 + 移动物理）。

---

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 文档体系与工程骨架 | ✅ **已完成** |
| M1 | 3D 场景、自由镜头、移动物理 | ⬜ 未开始 ← **下一步** |
| M2 | 目标系统、施法生命周期、打断 | ⬜ 未开始 |
| M3 | 六类瞄准、距离视线、范围形状 | ⬜ 未开始 |
| M4 | 八职业技能真正跑起来、控制递减、驱散免疫 | ⬜ 未开始 |
| M5 | 竞技场模式与地图 | ⬜ 未开始 |
| M6 | 临时武装：军械箱、拾取、换装 | ⬜ 未开始 |
| M7 | 夺旗战场 | ⬜ 未开始 |
| M8 | 特效、可读性、HUD、画质档位 | ⬜ 未开始 |
| M9 | 统计、观战、重连、可访问性、素材许可 | ⬜ 未开始 |

验收标准逐条状态见 [10-acceptance-tracking.md](10-acceptance-tracking.md)：**52 条中 5 条已完成**。

---

## M0 已交付清单

### 工程

- [x] pnpm workspace，三个包（`shared` / `server` / `client`），TS 项目引用
- [x] `pnpm typecheck` 全绿
- [x] `pnpm test` 全绿 —— **47 个测试**
- [x] `pnpm docs` 从代码自动生成附录A 要求的检查表

### 文档（12 份）

- [x] `README.md`（仓库入口）、`docs/README.md`（文档索引）
- [x] `01-development-plan.md` 开发计划书（M0–M9）
- [x] `02-architecture.md` 技术架构
- [x] `03-combat-system.md` 战斗系统实现设计
- [x] `04-class-skill-matrix.md` **自动生成**，345 行
- [x] `05-equipment-system.md` **自动生成**，177 行
- [x] `06-modes-and-maps.md` 模式规则与地图设计
- [x] `07-client-render-camera.md` 渲染镜头动画
- [x] `08-network-protocol.md` 网络协议
- [x] `09-asset-license.md` 素材许可清单
- [x] `10-acceptance-tracking.md` 52 条验收追踪
- [x] `11-contributing.md` 扩展指南
- [x] `00-design-spec.md` 原始规格书 Markdown 转录

### 代码（`packages/shared`）

| 模块 | 文件 | 状态 |
|---|---|---|
| ID 类型 | `types/ids.ts` | ✅ |
| 枚举词汇表 | `types/enums.ts` | ✅ |
| 全局战斗常量 | `constants/combat.ts` | ✅ 6.1 距离 / 8.1 节奏 / 8.2 递减 / 8.5 抑制 / 12.x 夺旗 |
| 向量库 | `math/vec3.ts` | ✅ |
| **命中几何** | `math/geometry.ts` | ✅ 六形状 + 视线 + 朝向 + 投射物 + 合法落点，**23 个测试** |
| 数据 schema | `data/schema.ts` | ✅ v1.1 |
| 护甲工厂 | `data/armors.ts` | ✅ 10.8 五种横向原型 |
| **八职业数据** | `data/classes/*.ts` | ✅ 共 **91 个技能**、24 套武器、48 套护甲 |
| 注册表与校验 | `data/index.ts` | ✅ `validateData()` 跨对象约束检查 |

### 已验证的验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 9 | 五档距离基准统一 | `geometry.test.ts` + `data.test.ts` |
| 10 | 模型大小不改变碰撞体 | `geometry.test.ts` |
| 11 | 墙体挡视线、低矮物不误判 | `geometry.test.ts` |
| 21 | 八职业均有专用打断或等价沉默 | `data.test.ts` 逐职业断言 |
| 31 | 双手高单击低攻速、双持反之 | `data.test.ts` |
| 32 | 没有全面上位装备 | `data.test.ts` |

---

## 👉 下一步：M1

**目标**：一个角色能在有墙、有柱、有台阶的场景里跑起来，镜头手感对。

### 建议的实现顺序

1. **`packages/shared/src/sim/movement.ts`** —— 先做纯逻辑，可单测
   - 滑墙、跨越低障碍（`GEOMETRY.STEP_HEIGHT`）、坡度判定（`MAX_WALKABLE_SLOPE_DEG`）
   - 跳跃保留水平动量、有限空中修正、不能增速或瞬间反向（验收 #45）
   - 复用已有的 `geometry.segmentIntersectsAabb` / `clampDisplacement`
   - 配套 `movement.test.ts`

2. **`packages/shared/src/data/maps/testbed.ts`** —— 测试地图
   - AABB 组合：几面墙、几根柱子、一段楼梯、一个缓坡、一个陡坡、一个低栏杆
   - 低栏杆记得标 `blocksSight: false`

3. **`packages/client/src/render/`** —— three.js 场景与渲染循环
   - 固定时间步推进模拟，渲染插值
   - 程序化几何体，**不引入任何外部素材**（见 09-asset-license.md §5）

4. **`packages/client/src/camera/`** —— 镜头控制器（最难的一块）
   - 严格按 [07-client-render-camera.md](07-client-render-camera.md) 实现
   - 特别注意：`camera.yaw` 与 `character.yaw` **必须是两个独立变量**
   - 手动拖动期间停止自动跟随

5. **`packages/client/src/input/`** —— 可重绑的按键映射表

### M1 完成的判据

跑起来后能亲眼确认验收 #1、#2、#3、#44、#45、#47 六条，并在
[10-acceptance-tracking.md](10-acceptance-tracking.md) 里标 ✅。

---

## 技术债

### 1. custom handler 待收敛（11 处）

八职业数据落地时，有些机制当时的 schema 表达不了，用了 `{ kind: 'custom' }` 逃生舱。
**schema v1.1 之后其中大部分已经可以数据化**，M4 实现效果系统时应当迁移：

| handler | 所在 | 迁移方案 | 优先级 |
|---|---|---|---|
| `decayAuraModifier` | 死亡骑士·冰霜锁链 | → `AuraDef.decay`（v1.1 已加） | 高 |
| `applyMoveSpeedFloor` | 死亡骑士·死亡脚步 | → `AuraModifiers.moveSpeedFloor`（v1.1 已加） | 高 |
| `rogue.requireOutOfCombat` | 盗贼·潜行 | → `SkillDef.requires: [{ kind: 'outOfCombat' }]`（v1.1 已加） | 高 |
| `rogue.requireRecentParry` | 盗贼·反击刺 | → `requires: [{ kind: 'recentlyParried' }]`（v1.1 已加） | 高 |
| `rogue.clearSlowAndRoot` | 盗贼·消失 | → `{ kind: 'dispel', types: [Movement], count: 'all', from: 'ally' }`（v1.1 已加） | 高 |
| `paladin.judgementVulnerability` | 圣骑士·审判 | → `AuraDef.casterScoped`（v1.1 已加） | 高 |
| `paladin.dropFlagOnTarget` | 圣骑士·保护祝福 | → `{ kind: 'dropFlag', target: 'target' }`（v1.1 已加） | 高 |
| `druid.prowl` | 德鲁伊·猎豹形态 | → `requires: [{ kind: 'outOfCombat' }, { kind: 'notCarryingFlag' }]` | 高 |
| `hunter.sustainAutoShot` | 猎人·自动射击 | 保留 —— 普攻循环本就属于 sim 层常驻状态，不是一次性效果 | 低 |
| `priest.leapOfFaithLandingGuard` | 牧师·信仰飞跃 | 保留 —— 落点合法性校验属于 sim 层，但可考虑抽成通用的 `landingGuard` | 中 |
| `druid.wild_charge` | 德鲁伊·野性冲锋 | 保留 —— 一个键按形态分三种位移，确实无法数据化 | 低 |

> 判断标准（见 [11-contributing.md](11-contributing.md) §4）：同一类 custom 出现三次以上，
> 说明 schema 缺一个正式 kind。上表里「前置条件」类出现了 4 次 —— 这就是为什么 v1.1 加了 `ConditionDef`。

### 2. 数值是占位值，需要一轮专门配平

规格书 9.x 只给了少数具体数值（武器伤害百分比、冷却、持续时间），
大量伤害/治疗量只有「造成基础神圣伤害」「恢复大量生命」这类描述。

当前各职业文件里的 `flat` 数值是按生命/资源基线估的**占位值**，代码中逐条注释标明。
规格书 9. 开头也明确说了「以下数值用于首轮可玩原型和规则验收，不代表最终平衡结果」。

**配平必须在 M4（技能真正跑起来）之后做**，在此之前调数字没有意义。
调整时必须保持技能的瞄准类型、反制窗口和职业定位不变（规格书 9. 前言）。

### 3. 待设计侧确认的 6 个问题

见 [10-acceptance-tracking.md](10-acceptance-tracking.md) 的「待设计侧确认的问题」一节
（Q1–Q6：数值留白、牧师群体治疗技能缺失、寒冰护盾可否驱散、肾击连击点映射、
圣骑士盾击、德鲁伊长柄 reach 与距离基准不一致）。

这些不阻塞 M1–M3，但在 M4 之前应该有答复。

### 4. 技能名需要原创化改写

当前技能名直接来自规格书，与《魔兽世界》高度重合。规格书 18.3 要求正式发布使用原创技能名。
改动成本很低（只在 `SkillDef.name` 一个字段），但**不要拖到发布前**。
详见 [09-asset-license.md](09-asset-license.md) §3。

---

## 给下一个接手的人

1. 先跑 `pnpm install && pnpm test && pnpm typecheck`，确认基线是绿的
2. 读 [01-development-plan.md](01-development-plan.md) 的 M1 一节和
   [07-client-render-camera.md](07-client-render-camera.md)
3. 动手前看一眼 [11-contributing.md](11-contributing.md) 的提交前检查清单
4. **不要改 [00-design-spec.md](00-design-spec.md)** —— 它是基线。
   要偏离就去 [10-acceptance-tracking.md](10-acceptance-tracking.md) 登记
5. 完成后回来更新本文件、验收追踪表，以及（如计划有变）开发计划书
