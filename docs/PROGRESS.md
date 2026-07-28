# 完成情况与下一步

> **这是零上下文接手时应该读的第一份文件。**
> 每完成一块工作都要更新这里。宁可写「未完成」，也不要写「已完成（待完善）」（附录A#7）。

**最后更新**：2026-07-28
**当前里程碑**：M0 与 M1 已完成，M2 未开始

---

## 一句话现状

**游戏能跑了。** `pnpm dev:client` 打开就是一个可操作的 3D 试验场：
角色能跑跳、沿墙滑、走楼梯、爬不上陡坡，镜头可以从第一人称连续拉到 18 米、
被墙挡住会拉近、左键环绕不改变角色朝向。

八职业的 91 个技能与装备数据、命中几何库、移动物理都已落地，
**117 个单元测试 + 14 项浏览器端到端验收全绿**。

还没有的：目标选择、施法、打断、战斗（M2–M4），联网对战（服务器仍是 M0 的连通性桩）。

---

## 里程碑状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 文档体系与工程骨架 | ✅ **已完成** |
| **M1** | 3D 场景、自由镜头、移动物理 | ✅ **已完成** |
| M2 | 目标系统、施法生命周期、打断 | ⬜ 未开始 ← **下一步** |
| M3 | 六类瞄准、距离视线、范围形状 | ⬜ 未开始 |
| M4 | 八职业技能真正跑起来、控制递减、驱散免疫 | ⬜ 未开始 |
| M5 | 竞技场模式与地图 | ⬜ 未开始 |
| M6 | 临时武装：军械箱、拾取、换装 | ⬜ 未开始 |
| M7 | 夺旗战场 | ⬜ 未开始 |
| M8 | 特效、可读性、HUD、画质档位 | ⬜ 未开始 |
| M9 | 统计、观战、重连、可访问性、素材许可 | ⬜ 未开始 |

验收标准逐条状态见 [10-acceptance-tracking.md](10-acceptance-tracking.md)：
**52 条中 11 条已完成、1 条进行中、40 条未开始**。

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

## 👉 下一步：M2（目标系统、施法生命周期、打断）

**目标**：完整反制链的骨架。这是全项目最核心的一块，52 条验收里有 8 条集中在这。

### 建议的实现顺序

严格按 [03-combat-system.md](03-combat-system.md) §5「实现顺序建议」走：

1. **`shared/src/sim/targeting.ts`** —— 五个目标槽位 + Tab 循环（45 米 / 前方 140° / 五级优先级）
   - 测试：潜行不进候选、身后不进首轮、被遮挡仍保持选中
2. **`shared/src/sim/casting.ts`** —— 7.4 施法生命周期状态机
   - ★ 开始和完成必须调用**同一个** `validate()`（验收 #19）
   - ★ 取消读条退资源和冷却，但**已经过的 GCD 不返还**（7.4 第 6 条）
3. **`shared/src/sim/interrupt.ts`** —— 专用打断 + 学派锁定
   - ★ 物理射击被打断**不产生**学派锁定（验收 #16）
   - ★ 打断落空/目标没在施法/技能不可打断，**仍进冷却**（7.2）
4. **`client/src/hud/CastBar.ts`** —— 施法条，必须显示技能名、学派、剩余时间、
   可否打断（不可打断带**盾牌标记**，7.5）

### M2 的验收判据

`pnpm test` 覆盖验收 #13–#20，并新增 `scripts/verify-m2.mjs` 覆盖 #4、#6 的端到端行为。
完成后更新本文件与 [10-acceptance-tracking.md](10-acceptance-tracking.md)。

M2 只需要两个职业（战士 + 法师）就能验证完整反制链 —— 数据早在 M0 就写好了，
不要等八职业都接完再验证手感。

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

### 4. 待设计侧确认：镜头最远距离

规格书 4.1 同时要求「角色高度约占画面 4%–8%」和「不能一次看到整张地图」。
60° FOV 下这两条互相冲突（8% 需要 21.6 米镜头距离，那样 2v2 小地图会被一眼看完）。
当前取 18 米优先满足后者，推导过程见
[07-client-render-camera.md](07-client-render-camera.md) §1.2，
已登记为 [10-acceptance-tracking.md](10-acceptance-tracking.md) 的 Q7。
**改一个常量即可切换，不涉及逻辑改动**，但 M1 开工前最好有答复。

### 5. 技能名需要原创化改写

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
2. 读 [01-development-plan.md](01-development-plan.md) 的 M1 一节和
   [07-client-render-camera.md](07-client-render-camera.md)
3. 动手前看一眼 [11-contributing.md](11-contributing.md) 的提交前检查清单
4. **不要改 [00-design-spec.md](00-design-spec.md)** —— 它是基线。
   要偏离就去 [10-acceptance-tracking.md](10-acceptance-tracking.md) 登记
5. 完成后回来更新本文件、验收追踪表，以及（如计划有变）开发计划书
