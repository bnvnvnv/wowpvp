# 完成情况与下一步

> **这是零上下文接手时应该读的第一份文件。**
> 每完成一块工作都要更新这里。宁可写「未完成」，也不要写「已完成（待完善）」（附录A#7）。

**最后更新**：2026-07-28
**当前里程碑**：M0–M4 已完成，M5 未开始

---

## 一句话现状

**完整反制链能玩了。** `pnpm dev:client` 打开就是一个可操作的 3D 试验场：
角色能跑跳走楼梯、镜头能从第一人称连拉到 18 米；场上有三个假人，
你可以 Tab 选目标、读条、被打断、用法术反制打断对方并看到学派锁定，
也可以起手读条再 Esc 骗掉对方的拳击 —— 骗成功后对方的打断落空但照样进 15 秒冷却。

**296 个单元测试 + 47 项浏览器端到端验收全绿**（M1 14 + M2 14 + M3 12 + M4 7）。

六类瞄准的输入流程也齐了：按 `5` 会进入落点预览，圆圈跟着鼠标走，
拖到墙后立刻变成**虚线 + 叉号 + 变暗 + 文字说明「缺少视线」**，左键点不下去。

**技能现在真的造成伤害了。** 火焰冲击打掉 150 点血、变形术连放三次时长按 4→2→1 递减、
寒冰屏障期间一切伤害显示「免疫」、陨石延迟 1.5 秒后落地结算。

还没有的：竞技场回合流程与地图（M5）、临时武装（M6）、夺旗（M7）、
联网对战（服务器仍是 M0 的连通性桩）。

---

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 文档体系与工程骨架 | ✅ **已完成** |
| **M1** | 3D 场景、自由镜头、移动物理 | ✅ **已完成** |
| **M2** | 目标系统、施法生命周期、打断 | ✅ **已完成** |
| **M3** | 六类瞄准、地面指示器、两类投射物 | ✅ **已完成** |
| **M4** | 效果系统、光环、控制递减、驱散免疫 | ✅ **已完成** |
| M5 | 竞技场模式与地图 | ⬜ 未开始 ← **下一步** |
| M6 | 临时武装：军械箱、拾取、换装 | ⬜ 未开始 |
| M7 | 夺旗战场 | ⬜ 未开始 |
| M8 | 特效、可读性、HUD、画质档位 | ⬜ 未开始 |
| M9 | 统计、观战、重连、可访问性、素材许可 | ⬜ 未开始 |

验收标准逐条状态见 [10-acceptance-tracking.md](10-acceptance-tracking.md)：
**52 条中 27 条已完成、25 条未开始**。

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

## M1 已交付清单

### 代码

| 模块 | 文件 | 说明 |
|---|---|---|
| **移动物理** | `shared/src/sim/movement.ts` | 13.5 全部八条。纯函数、确定性，客户端预测回放的前提 |
| 地图数据契约 | `shared/src/data/maps/schema.ts` | 按 docs/06 §8 落地的 `MapDef` |
| 试验场地图 | `shared/src/data/maps/testbed.ts` | 每个物件对应一条要验证的规则 |
| **镜头控制器** | `client/src/camera/CameraController.ts` | 4.1–4.3 全部。两个独立 yaw、非对称碰撞插值 |
| 输入层 | `client/src/input/InputManager.ts` | 4.2 按键表，全部可重绑（17.2） |
| **动作状态机** | `client/src/entity/AnimationController.ts` | 13.3/13.4，双阈值迟滞 + 传送不误判 |
| 角色表现 | `client/src/entity/CharacterView.ts` | 程序化几何体，尺寸直接取自 `GEOMETRY` 常量 |
| 地图渲染 | `client/src/render/MapRenderer.ts` | 网格**完全由 `MapDef.geometry` 生成** |
| 固定步长循环 | `client/src/render/GameLoop.ts` | 20Hz 模拟 + 渲染插值 |
| 试验场装配 | `client/src/scenes/TestbedScene.ts` | M1 的人工验收载体 |

### 验证

- **117 个单元测试**（`pnpm test`）：几何 23 + 数据 26 + 移动 40 + 动作 11 + 镜头 15 + 其他
- **14 项浏览器端到端验收**（`pnpm verify:m1`）：驱动真实浏览器里的真实游戏，
  用键盘鼠标操作角色、读 HUD 真实数值。附录A#7 要求的「阶段验收用例」

```
M1 验收：14/14 通过
```

### 本阶段发现并修掉的两个真 bug

1. **下落时穿过地面**：`findGroundY` 原本是点查询，而 60fps 下自由落体一帧就能位移
   0.16 米 —— 高速下落必然漏检。改成从本 tick 起点扫掠到终点的区间查询。
2. **下楼梯一路弹跳**：只处理了「落到地面」没处理「向下吸附」，
   走下 0.3 米的台阶会转入下落状态。补了 `snappedDown` 分支（13.5「脚部贴地」）。

两个都是先写测试暴露、再改实现，不是靠猜。

---

## M2 已交付清单

### 代码

| 模块 | 文件 | 说明 |
|---|---|---|
| 战斗实体 | `shared/src/sim/entity.ts` | 目标槽位、状态标志、冷却与学派锁定 |
| 世界容器 | `shared/src/sim/world.ts` | 刻意做得很薄，加系统不用改它 |
| **目标系统** | `shared/src/sim/targeting.ts` | 5.1 五槽位、5.3 Tab 五级优先级、5.6 取目标 |
| **施法生命周期** | `shared/src/sim/casting.ts` | 7.4 六阶段状态机，开始/完成共用同一个 `validate()` |
| **打断结算** | `shared/src/sim/interrupt.ts` | 7.2 学派锁定、沉默/缴械的边界 |
| 战斗调度 | `client/src/combat/CombatDirector.ts` | 本地模拟 + 三个演示反制链的假人 |
| 战斗 HUD | `client/src/hud/CombatHud.ts` | 15.2 目标框、施法条、技能栏、姓名板 |

### 验证

- **188 个单元测试**（`pnpm test`）：新增施法 37 + 目标 34
- **14 项浏览器端到端验收**（`pnpm verify:m2`），含完整的假读条闭环：
  起手读条 → Esc 取消 → 对方拳击落空 → 仍进 15 秒冷却

```
M2 验收：14/14 通过
```

### 三处刻意的实现选择

1. **`validateCast` 是唯一的校验入口**。开始、完成、HUD 图标变灰全走它。
   HUD 自己算一遍迟早会出现「图标是亮的但按下去失败」——最让人困惑的一类 bug。
2. **`applyInterrupt` 不碰冷却**。7.2 规定打断落空也进冷却，把冷却留在调用点上，
   就没法被 `if (命中)` 分支绕过。两个调用点（玩家、假人）都能看到这一句。
3. **`onDamageTaken()` 是个空函数**。验收 #14「普通伤害不打断施法」是一条
   *什么都不做* 的规则 —— 写成可搜索、可被测试引用的空函数，
   比留一片「碰巧没写」的空白更不容易在将来被误加逻辑。

### 假人 AI 的一个非平凡设计

战士假人的拳击有 **0.45 秒反应延迟**。这不是拟真装饰：反应时间为 0 的 AI 会在
读条开始的同一 tick 打断，人类玩家永远读不完任何条，7.5 的假读条博弈就**不存在**了。
规则实现对了，玩法却没了 —— 这是端到端验收才能发现的问题，单元测试发现不了。

---

## M3 已交付清单

### 代码

| 模块 | 文件 | 说明 |
|---|---|---|
| **两类投射物** | `shared/src/sim/projectile.ts` | 锁定 / 碰撞 / 延迟落点三类，反制方式各不相同 |
| **瞄准解算** | `shared/src/sim/aiming.ts` | 落点合法性、六种形状选目标、六类瞄准分流 |
| 地面指示器 | `client/src/targeting/GroundIndicator.ts` | 5.5 五项显示要求 + 17.2 三重非法提示 |
| 方向预览 | `client/src/targeting/DirectionIndicator.ts` | 锥形/直线，**签名里没有镜头 yaw** |
| 瞄准状态机 | `client/src/targeting/AimingController.ts` | 5.5 四种确认方式 |

### 验证

- **250 个单元测试**：新增投射物 17 + 瞄准 21 + 确认方式 12
- **12 项浏览器端到端验收**（`pnpm verify:m3`），含真正构造出的非法落点场景

```
M3 验收：12/12 通过
```

### 三处「靠结构而不是靠自觉」的保证

1. **`GroundIndicator` 不做任何几何计算。** 边界、半径、合法性全部来自
   `resolveGroundPlacement()` 的返回值 —— 也就是服务器判定用的同一个函数。
   验收 #8 要求「真实范围边界与实际判定一致」，保证它的方式是让客户端
   **无法**自己算一个不同的边界。
2. **`DirectionIndicator.show()` 的参数叫 `characterYaw`，且签名里根本没有镜头 yaw。**
   5.4 规定「镜头方向不能替代角色面向」—— 想传错都传不进来。
3. **非法落点用三个通道同时提示**：虚线边界（形状）、叉号（符号）、变暗（亮度），
   外加一条文字说明。17.2 要求「不能只依赖颜色」，这里做到的是任一通道单独就够用。

### 端到端跑出来的三个真 bug

单元测试全绿之后，第一次在浏览器里操作就发现：

1. **地面技能一直显示「需要目标」** —— HUD 用 `resolveSkillTarget` 判定可用性，
   但地面技能根本不需要硬目标。15.2 要求提示准确，这属于错误提示。
2. **冰霜新星报「需要目标」** —— 自身中心技能掉进了「直接目标」分支。
   5.6 明确说「自我技能和自身中心技能可直接使用」。补了 `usesNoTarget()`。
3. **鼠标抬到地平线以上时技能按了没反应** —— 射线不与地面相交就返回了 undefined。
   改成沿水平方向推到远处再交给上层钳制，行为与真实游戏一致。

三个都是「规则实现正确、接线接错」的类型。这类问题单元测试发现不了。

---

## M4 已交付清单

### 代码

| 模块 | 文件 | 说明 |
|---|---|---|
| **效果注册表** | `sim/effects/registry.ts` | 加机制只加不改；漏注册**启动即失败** |
| 伤害/治疗/控制/驱散 | `sim/effects/combat.ts` | 8.x 全部结算规则 |
| 位移与生成 | `sim/effects/displacement.ts` | 所有位移统一走 `moveTo()`（验收 #46） |
| **光环系统** | `sim/aura.ts` | 叠加、周期跳、受伤解除、护盾四态、衰减修正 |
| **控制递减** | `sim/dr.ts` | 8.2 五条链，窗口从控制**结束**算起 |
| **叠加规则** | `sim/modifiers.ts` | 8.4 / 17.1：减速与减伤取最强，增伤相乘 |
| 地面区域与陷阱 | `sim/groundArea.ts` | 烟雾弹阻挡选中、照明弹揭露潜行、陷阱单次触发 |

### 验证

- **296 个单元测试**：新增效果系统 46 项
- **`pnpm verify:m4` 7/7**：技能真的扣血、递减真的生效、陨石真的落地

### 三处结构性保证

1. **漏注册效果 = 启动即崩，不是静默无效。** `assertAllEffectsRegistered()` 在
   模块加载时跑。实际验证过：写完处理器后它精确报出「缺失: interrupt」。
   一个技能悄悄不产生效果，比崩溃难查一百倍。
2. **所有位移只有一个出口。** `displacement.ts` 里每个位移处理器都调用同一个
   `moveTo()`，而它是 `clampDisplacement` 的唯一调用点。想绕过验收 #46
   就必须显式绕开这个模块，代码审查一眼能看到。
3. **`StatusFlags` 由光环派生。** M2 时它是手动赋值的占位实现；M4 换成
   `deriveStatusFlags()` 每 tick 聚合 —— 而 casting / targeting / movement 的
   调用点**一行都没改**。这正是当初把它单列成结构的原因。

### 本阶段发现并修掉的四个真 bug

1. **读条技能完全不结算效果。** `beginCast` 传入的 `onCompleted` 只对**瞬发**技能
   生效，读条技能走的是 `tickCasting` 那一路 —— 两个事件出口我只接了一个。
   技能日志显示「完成」，但什么都没发生。已在 `casting.ts` 的 `CastEvents`
   上加了醒目警告，并把完成处理收敛到 `onCastCompleted()` 一处。
2. **假人法师打自己。** 统一完成入口时我从 `targets.hard` 重新取目标，
   但假人从没设过硬目标 → 回退到 `[caster]`。改为使用 `CastState.targetId`：
   施法开始时锁定的是谁，完成时就结算给谁。
3. **战士假人从 14 米外用 3 米技能打断。** 它直接调 `applyInterrupt`，
   绕过了 `validateCast` 的距离校验。改为先过 `validateCast` ——
   假人和玩家受同一套规则约束。
4. **假人永远转不了身。** yaw 恒为 0，玩家站在它背后时拳击被判 `WrongFacing`，
   于是它一次也打断不了。假人现在每 tick 面向玩家。

后两个都是「AI 走了后门 / 没走完整规则」的类型 —— 单元测试测不到，
因为它们测的是规则本身，而不是「谁在调用规则」。

### 一个性能修复

M4 接入后帧率从 22 掉到 12，导致 M1 的验收脚本超时。原因是 HUD 每帧重建
全部 `innerHTML`（目标框 + 技能栏 + 日志 + 4 个姓名板）。节流到 20Hz 后回到 21 FPS，
姓名板**位置**仍每帧更新以跟随镜头。

---

## 👉 下一步：M5（竞技场模式与地图）

**目标**：从「试验场」变成「一局比赛」。

### 建议的实现顺序

1. **`shared/src/sim/match/arena.ts`** —— 回合状态机
   - 准备区 → 开门 → 战斗 → 结算（11.1）
   - 每回合重置生命/资源/冷却/默认装备/地图状态（2.1）
   - ★ 死亡后**不能复活**（11.4）—— 试验场的 `reviveInTestbed()` 是临时规则，
     M5 要用真正的淘汰逻辑替换它
   - ★ 宠物/图腾/召唤物**不计入存活人数**（2.1）
   - ★ 双方最后一人在同一结算窗口内死亡判**平局**（2.1 / 验收 #26）
2. **`shared/src/sim/dampening.ts`** —— 8.5 战斗抑制
   - `effects/combat.ts` 里已经有 `setDampening()` 接口，M5 只需驱动它
   - 决胜阶段的压迫伤害要用 `bypassImmunity: true`（验收 #27）
3. **三张竞技场地图** —— `data/maps/arena{2v2,3v3,5v5}.ts`，尺寸按 11.2
4. **`server/src/room/`** —— 房间、队伍、自由职业选择（3.2 / 验收 #22）

### M5 的验收判据

覆盖验收 #22、#24、#25、#26、#27。

---

---

## 技术债

### 1. custom handler 待收敛（11 处，M4 未做）

八职业数据落地时，有些机制当时的 schema 表达不了，用了 `{ kind: 'custom' }` 逃生舱。
**schema v1.1 之后其中大部分已经可以数据化**。

M4 实现了效果系统但**没有做这次迁移** —— `custom` 处理器目前只记事件不报错
（`effects/displacement.ts` 末尾），所以这些技能能释放、能进冷却，但那部分特殊机制
不产生实际效果。这是有意的取舍：先让主链跑通并被验证，再逐个迁移。
迁移时每改一个就该补一条测试。

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

### 3. 施法失败原因的优先级

`validateCast` 按 7.4 步骤 1 的顺序把「资源」排在「距离/视线/朝向」之前。
后果：怒气为 0 的战士站在 30 米外，收到的提示是「资源不足」而不是「超出距离」。
两者都为真，但后者更可操作。

M8 做 HUD 时若要满足 15.2 的提示质量，建议**另加**一个 `describeCastBlockers()`
返回全部当前阻碍项供图标叠加显示，而**不要**改门禁顺序 ——
改了会影响 `CastFailure` 的语义与战后统计的归因。

### 4. 待设计侧确认的 6 个问题

见 [10-acceptance-tracking.md](10-acceptance-tracking.md) 的「待设计侧确认的问题」一节
（Q1–Q6：数值留白、牧师群体治疗技能缺失、寒冰护盾可否驱散、肾击连击点映射、
圣骑士盾击、德鲁伊长柄 reach 与距离基准不一致）。

这些不阻塞 M3，但在 M4 之前应该有答复。

### 5. 待设计侧确认：镜头最远距离

规格书 4.1 同时要求「角色高度约占画面 4%–8%」和「不能一次看到整张地图」。
60° FOV 下这两条互相冲突（8% 需要 21.6 米镜头距离，那样 2v2 小地图会被一眼看完）。
当前取 18 米优先满足后者，推导过程见
[07-client-render-camera.md](07-client-render-camera.md) §1.2，
已登记为 [10-acceptance-tracking.md](10-acceptance-tracking.md) 的 Q7。
**改一个常量即可切换，不涉及逻辑改动**，但 M1 开工前最好有答复。

### 6. 技能名需要原创化改写

当前技能名直接来自规格书，与《魔兽世界》高度重合。规格书 18.3 要求正式发布使用原创技能名。
改动成本很低（只在 `SkillDef.name` 一个字段），但**不要拖到发布前**。
详见 [09-asset-license.md](09-asset-license.md) §3。

---

## 环境备注

- 本项目在中国大陆网络环境下开发，**git 推送需要走本地代理**。
  仓库的 `.git/config` 里已配置 `http.proxy = http://127.0.0.1:7890`（Clash 默认端口）。
  如果你的代理端口不同，改这一项即可；不需要代理时用
  `git config --unset http.proxy && git config --unset https.proxy` 移除。
- Node ≥ 20，pnpm 10.x。

## 给下一个接手的人

1. 先跑 `pnpm install && pnpm test && pnpm typecheck`，确认基线是绿的
2. 读 [01-development-plan.md](01-development-plan.md) 的 M5 一节和
   [06-modes-and-maps.md](06-modes-and-maps.md)（回合状态机、地图数据格式、公平约束）
3. 动手前看一眼 [11-contributing.md](11-contributing.md) 的提交前检查清单
4. **不要改 [00-design-spec.md](00-design-spec.md)** —— 它是基线。
   要偏离就去 [10-acceptance-tracking.md](10-acceptance-tracking.md) 登记
5. 完成后回来更新本文件、验收追踪表，以及（如计划有变）开发计划书
