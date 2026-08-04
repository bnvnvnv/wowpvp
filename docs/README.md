# 文档索引

## 🚨 零上下文接手？按这个顺序读

| # | 文件 | 你会得到 | 大约耗时 |
|---|---|---|---|
| 1 | **[PROGRESS.md](PROGRESS.md)** | 当前进度、已完成/未完成、**下一步做什么** | 5 分钟 |
| 2 | **[01-development-plan.md](01-development-plan.md)** | M0–M9 里程碑拆解与交付物 | 10 分钟 |
| 3 | **[02-architecture.md](02-architecture.md)** | 分层、包边界、数据流、加东西要改哪些文件 | 15 分钟 |
| 4 | **[11-contributing.md](11-contributing.md)** | 具体怎么加职业/技能/武器/地图 | 10 分钟 |

读完这四份就能开工。要做具体模块时再查下面对应的详细文档。

---

## 全部文档

### 基线

| 文件 | 内容 | 谁维护 |
|---|---|---|
| [00-design-spec.md](00-design-spec.md) | **原始设计规格书 V1.0，唯一权威基线** | 设计侧，实现方不得修改 |
| [source/](source/) | 原始 `.docx` 与提取的纯文本，备核对用 | 只读 |

> 实现与 00 冲突时以 00 为准。确需偏离必须在
> [10-acceptance-tracking.md](10-acceptance-tracking.md) 登记「已知偏差」，不得默默修改。

### 计划与架构

| 文件 | 内容 |
|---|---|
| [01-development-plan.md](01-development-plan.md) | 开发计划书：M0–M9 里程碑、交付物、验收用例、关键陷阱 |
| [02-architecture.md](02-architecture.md) | 技术架构：技术选型理由、分层、目录、数据流、效果注册表、权威与预测 |
| [PROGRESS.md](PROGRESS.md) | 完成情况与下一步（技术债已迁至 15 号总账，本文只留历史）|
| [13-roadmap-post-m9.md](13-roadmap-post-m9.md) | M9 之后的路线图：M10 联网 → M11 技术债 → M12 美术，含每阶段的完成判据（已全部完成）|
| [14-roadmap-post-m12.md](14-roadmap-post-m12.md) | M13 对局入口 → M14 配平 → M15 新手引导 → M16 对局完整性（**均已完成**）→ M17 留存钩子（方向）|
| [15-debt-registry.md](15-debt-registry.md) | **技术债总账（唯一活账本）**：全部欠账一行一债 + 登记规矩 + 已拍板的决定 |
| [16-roadmap-post-m16.md](16-roadmap-post-m16.md) | **当前执行计划**：清账与硬化四批次 + 发布前清单，每项带改法要点与判据 |

### 系统设计

| 文件 | 内容 | 对应规格书 |
|---|---|---|
| [03-combat-system.md](03-combat-system.md) | 目标系统、距离视线朝向、施法打断、控制递减、战斗抑制 | 5–8 章 |
| [06-modes-and-maps.md](06-modes-and-maps.md) | 模式规则、回合与旗帜状态机、地图数据格式与公平约束 | 2、3、11、12 章 |
| [07-client-render-camera.md](07-client-render-camera.md) | 镜头、输入、移动物理、动画状态机、特效与可读性、画质档位 | 4、13、14 章 |
| [08-network-protocol.md](08-network-protocol.md) | 消息定义、权威边界、**视野裁剪（安全边界）**、预测与纠正、断线重连 | — （规格书不规定） |
| [12-fairness-review.md](12-fairness-review.md) | 公平性设计审查：等级/永久装备/付费属性/外观稀有度四项逐条判据 | 17.1（验收 #52）|

### 自动生成的检查表

> ⚠️ **这两份不要手工编辑**，每次 `pnpm docs` 都会覆盖。
> 改数据（`packages/shared/src/data/classes/*.ts`）后重新生成即可。
> 这样它们永远等于代码里的真实状态 —— 附录A#2 要求的「完整检查表」不会过期。

| 文件 | 内容 | 对应规格书 |
|---|---|---|
| [04-class-skill-matrix.md](04-class-skill-matrix.md) | 八职业全部技能的九项标注 + 瞄准类型分布 | 附录A#2、A#3 |
| [05-equipment-system.md](05-equipment-system.md) | 武器与护甲的六项标注 + 横向取舍映射 | 附录A#4 |

### 流程与合规

| 文件 | 内容 |
|---|---|
| [09-asset-license.md](09-asset-license.md) | 素材许可清单、原创边界、引入流程、发布前审计 |
| [10-acceptance-tracking.md](10-acceptance-tracking.md) | 52 条验收标准逐条状态、已知偏差、待设计侧确认的问题 |
| [11-contributing.md](11-contributing.md) | 扩展指南：加技能/职业/武器/机制/地图/素材分别改哪里 |

---

## 常用命令

```bash
pnpm install
pnpm dev:server      # 权威服务器
pnpm dev:client      # 浏览器客户端
pnpm test            # 数据完整性 + 几何判定 + 战斗规则
pnpm typecheck       # 全量类型检查
pnpm docs            # 重新生成 04 / 05
```

## 几条不能破的规矩

来自规格书附录A，违反即验收不通过：

1. 规格书是唯一基线，不得把目标制战斗改成 FPS 或 MOBA
2. 每个技能必须标注九项（已由 `SkillDef` 编译期强制）
3. 每件武器护甲必须标注六项（已由 `WeaponDef`/`ArmorDef` 强制）
4. 跨职业拾取、换装重置技能、攻击后摇取消、旗帜消失、镜头穿墙、
   地面范围与判定不一致 —— 这六种缺陷不得进入可验收版本
5. 素材必须先完成许可清单
6. **不能用伪代码或占位图冒充完成**
