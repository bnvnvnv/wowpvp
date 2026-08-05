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
# 克隆用部分克隆 —— 历史里的素材 blob（~560MB）按需才拉，省一大半传输
# （2026-08-05 拍板：LFS/素材出库的最终方案与发布前 F2 素材投递一并定）
git clone --filter=blob:none https://github.com/bnvnvnv/wowpvp.git

# 需要 Node >= 20
npm i -g pnpm            # 若尚未安装
pnpm install

pnpm dev:server          # 权威服务器，默认 ws://localhost:8080
pnpm dev:client          # 客户端，默认 http://localhost:5173

pnpm test                # 单元测试（1109 条：几何、命中、施法状态机、统计、快照裁剪…）
pnpm typecheck           # 全量类型检查，★ 含测试文件本身（见下）

# 阶段验收脚本（每个里程碑一支，对应 docs/10 的验收标准）
pnpm verify:m1           # M1–M4 驱动真实浏览器，需要先跑起客户端
pnpm verify:m5           # M5–M7 / M9 是纯逻辑，直接跑
pnpm verify:m7           # 夺旗：跑一整局真实比赛（真地图、真碰撞、20Hz）
pnpm verify:m8           # 表现层：HUD 四区、逐档画质、带旗开无敌先掉旗
pnpm verify:m9           # 统计与安全边界：潜行不进快照、战后统计、七项最佳玩家
pnpm verify:m10          # 联网：起真服务器 + 两个真 ws 客户端，逐条试着作弊
pnpm verify:m12          # 美术与音效：素材登记、模型不改碰撞体、低画质不藏关键信息
pnpm verify:m16          # 临时武装：军械箱三选一、职业锁定、拾取、消耗品（起真服务器 + 两个真 ws 客户端）
```

**★ 一条容易踩的分工**：`verify:m1`–`m10` 默认带 `?art=off` 跑
（画面精确回落到 M11 的全程序化表现），因为它们验的是**规则接线**，
而美术层在软件渲染下会把帧率从 27 压到 4，让它们因为跑不动而超时 ——
那是测量环境的伪影，不是代码的问题。
**美术层本身由 `verify:m12` 验**（它跑在默认的 `?art=on`）。
理由写在 `packages/client/src/settings/artMode.ts`。

**三层验证各有分工，缺一层就会漏一类 bug**（这是九个里程碑攒出来的经验）：

| 层 | 命令 | 它能抓到什么 |
|---|---|---|
| 单元测试 | `pnpm test` | **规则**对不对 |
| 端到端验收 | `pnpm verify:m1`…`m9` | 规则**有没有被调用**。本项目四次遇到「规则写对了、单测全绿、但没人调用它」 |
| 类型检查 | `pnpm typecheck` | **测试自己有没有说谎**。测试文件不过类型检查时，import 一个不存在的导出会得到 `undefined` 而非报错 —— 测试可能因为错误的原因通过 |

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
│  ├─ 12-fairness-review.md     公平性设计审查（验收 #52）
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
- **素材**：见 [docs/09-asset-license.md](docs/09-asset-license.md)。
  - **GitHub 已公开分发的美术/音频**：可拉取、**可入库（commit/push）**、**可进发布包**（档位 GH → `assets/art/`、`assets/music/`）。
  - 仅非 GitHub 且禁止再分发的文件进 `assets/local/`（gitignore）。
  - 代码 MIT 不改写媒体来源声明；§4 按包登记即可。
- 本项目**不使用**暴雪的角色模型、纹理、图标、地图文件、Logo 或音频。
