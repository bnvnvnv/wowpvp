# wowpvp — 网页 3D 多人 PVP 竞技场与夺旗战场

> 3D 自由镜头 · 2v2/3v3/5v5 歼灭竞技场 · 6v6/8v8/12v12 夺旗战场 · 八职业 · MMORPG 目标制战斗 · 临时武器/护甲/增益争夺

这是一款运行于浏览器的完整 3D 多人 PVP 游戏。战斗不是 FPS 准星射击，也不是 MOBA 俯视点击，
而是**「选择目标、判断距离与视线、释放技能、控制与打断、临场换装」**的职业制 PVP。

---

## 🚨 新会话／新贡献者从这里开始

如果你是**零上下文**接手这个项目的人（或 AI），请严格按顺序读这三份文件，不要跳读：

| 顺序 | 文件 | 你会得到什么 |
|---|---|---|
| 1 | **[docs/PROGRESS.md](docs/PROGRESS.md)** | 当前进度、已完成/未完成清单、**下一步该做什么** |
| 2 | **[docs/01-development-plan.md](docs/01-development-plan.md)** | 里程碑 M0–M9 拆解、每个里程碑的交付物与验收 |
| 3 | **[docs/02-architecture.md](docs/02-architecture.md)** | 分层、包边界、数据流、「加一个职业要改哪些文件」 |

然后按需查阅 [docs/README.md](docs/README.md) 里的完整文档索引。

**唯一权威设计基线是 [docs/00-design-spec.md](docs/00-design-spec.md)**（原始规格书 V1.0）。
任何实现与它冲突时，以它为准；确实需要偏离时，必须在
[docs/10-acceptance-tracking.md](docs/10-acceptance-tracking.md) 里登记「已知偏差」，不能默默改。

---

## 快速开始

```bash
# 需要 Node >= 20
npm i -g pnpm            # 若尚未安装
pnpm install

pnpm dev:server          # 权威服务器，默认 ws://localhost:8080
pnpm dev:client          # 客户端，默认 http://localhost:5173

pnpm test                # 单元测试（几何、命中、施法状态机、数据完整性）
pnpm typecheck           # 全量类型检查
```

## 仓库结构

```
wowpvp/
├─ docs/                      设计与开发文档（唯一事实来源）
│  ├─ 00-design-spec.md         原始设计规格书 V1.0（权威基线）
│  ├─ 01-development-plan.md    开发计划书
│  ├─ 02-architecture.md        技术架构
│  ├─ 03-combat-system.md       战斗系统实现设计
│  ├─ 04-class-skill-matrix.md  八职业技能检查表（附录A#2/#3 要求）
│  ├─ 05-equipment-system.md    武器/护甲/增益系统（附录A#4 要求）
│  ├─ 06-modes-and-maps.md      模式规则与地图
│  ├─ 07-client-render-camera.md 渲染、镜头、动画、移动物理
│  ├─ 08-network-protocol.md    网络协议
│  ├─ 09-asset-license.md       素材许可清单（附录A#6 要求）
│  ├─ 10-acceptance-tracking.md 52 条验收标准追踪表
│  ├─ 11-contributing.md        扩展指南：如何加职业/技能/武器/地图
│  └─ PROGRESS.md               完成情况与下一步
└─ packages/
   ├─ shared/   纯逻辑：数据定义、几何命中、战斗模拟核心（可单测，无渲染依赖）
   ├─ server/   权威服务器：房间、20Hz tick、状态广播
   └─ client/   浏览器：three.js 渲染、镜头、输入、HUD
```

## 设计红线（来自规格书附录A，不可违反）

1. 本文件夹下的规格书是玩法和验收的**唯一基线**；不得擅自把目标制战斗改成 FPS 或 MOBA。
2. 每个技能必须标注：目标类型、距离、形状、施放时间、是否可移动、是否可打断、学派、冷却、反制方式。
   —— 已由 `packages/shared/src/data/schema.ts` 的 `SkillDef` **在编译期强制**。
3. 每件武器和护甲必须标注所属职业、攻击间隔、距离、优势、代价和改变的技能。
   —— 已由 `WeaponDef` / `ArmorDef` 强制。
4. 不得让跨职业拾取、换装重置技能、攻击后摇取消、旗帜消失、镜头穿墙、地面范围与判定不一致进入可验收版本。
5. 素材必须先完成许可清单；未明确授权的图标、模型、音效和字体不得进入正式包。
6. 每个阶段完成后运行对应验收用例，列出已完成、未完成和已知偏差；**不能用伪代码或占位图冒充完成**。

## 许可

- **代码**：MIT（见 [LICENSE](LICENSE)）
- **素材**：逐项独立管理，见 [docs/09-asset-license.md](docs/09-asset-license.md)。
  代码许可证与媒体资产许可证分开；未登记的素材不得进入发布包。
- 本项目**不使用**暴雪的角色模型、纹理、图标、地图文件、Logo 或音频。
