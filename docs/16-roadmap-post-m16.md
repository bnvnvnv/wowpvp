# M16 之后的执行计划：清账与硬化

> **背景**：M16 收官后（52 条验收全过、`verify:m16` 29/29），2026-08-04 做了一次
> 全仓审计，把散在各处的欠账归并进 [15-debt-registry.md](15-debt-registry.md)（唯一活账本）。
> 本文把总账里 ⛔ 的条目排成可执行批次：**一次做一项，每项有判据，做完销账**。
>
> 与 [14-roadmap-post-m12.md](14-roadmap-post-m12.md) 的关系：M13–M16 已全部完成，
> M17（留存钩子）依赖对局人口、判据届时再定 —— 本文是 **M17 之前该还的账**，
> 也是「能把链接发给陌生人」之前该补的底。
>
> 条目用总账 ID 引用（A1/W9/…），细节与证据一律看总账，本文只写**改法要点与判据**。

**创建**：2026-08-04

---

## 原则（沿用仓库既有规矩）

- **一个一个来**：每项一个提交（或一小串同主题提交），完成即更新总账状态列 + PROGRESS 叙事。
- **判据优先**：能写断言的写断言 —— 三层验证分工不变（单测验规则、端到端验接线、类型检查验测试自己）。
- **顺序即建议**：批内从上往下做；批与批可少量穿插，但**批次一先清**（都是正确性）。
- **红线不动**：无参默认路径 = 141 项验收载体；协议改动照 M10 规矩
  （codec 校验 + `FORBIDDEN_CLIENT_FIELDS` + `verify:m10` 零泄露断言不掉）。
- **改 shared/sim 任何规则先 grep 调用点**（老教训第七次之前拦住它）。

## 批次总览

| 批 | 主题 | 条目 | 出口判据 |
|---|---|---|---|
| **一** | 正确性修复 | A1 A2 A3 A6 A7 A8 A12 A13 A14 A15 + P1 P5 P2 | 全量单测 + 受影响 verify 全绿；`pnpm balance` 基线逐位不变 |
| **二** | 接线速赢（组件在、喂数据） | W1 W3 W4 W2 W5 W6 W9 W8 W10 W13 X1 W15 W16 W11 | 每项至少一条新断言或截图核验；m10/m12/m13 回归不掉 |
| **三** | 结构工程 | G1 G2 G3 G4 W12 S1–S6 W14 W7 P6 | CI 在线上跑绿；恶意脚本压测不影响他房 tick |
| **四** | 协议债小批 | W17 X3 S7 W18（+A5 A4 评估） | 一次协议版本改动打包；`verify:m10` 15/15 不掉 |
| **发布前** | 门禁清单 | F1–F6 | docs/09 §7.2 清单全勾 |

**没排进批次的**：A9 A10 A11 A16 S8 S9 P3 P4 P7–P10 X2 X4–X12 G6–G8 B1 B2 ——
体量小或依赖前序，见文末「机动池」，穿插着做即可。

---

# 批次一：正确性修复（先把说谎的地方修掉）

## 1.1 A1 —— `eliminate()` 走真实死亡漏斗

- **改法**：`LeaveMatch`/超时淘汰不再直改 `alive/health`，改为经由 sim 侧统一死亡结算：
  产生 `CombatEvent{t:'death'}`（killerId 为空 —— 主动退出没有凶手，如实）→
  统计折叠 → `settleDeaths()`（10.10 临时装备清理）→ `Death` 广播。
  收口点放 sim（新的 `forfeit(world, id)` 之类），服务器只调用。
- **判据**：新单测三条 —— LeaveMatch 后 `deaths +1`、临时装备清空、客户端收到 `Death` 消息；
  `verify:m10` #10 与 `verify:m16` 不掉。
- **⚠️ 注意**：11.5 与偏差 #14 的边界不变 —— 主动退出仍**立即**淘汰，断线仍走人机接管。

## 1.2 A2 —— 无输入实体也做物理积分

- **改法**：`tickWorld` 第 2 步对无输入条目的实体用**全零输入**继续走 `stepMovement`
  （重力、速度衰减、软推开照常）。「没登记 movement 的实体不动」这条边界保留。
- **判据**：两条 tick 断言 —— 空中实体停止喂输入仍会落地；无输入实体仍会被软推开。
  各过一次变异测试（改回 `continue`，断言变红）。
- **⚠️ 注意**：`Predictor` 的 `others` 近似输入不受影响；跑一遍 m1/m8（移动最敏感的两支）。

## 1.3 A3 —— ws 心跳与空闲超时

- **改法**：服务器 30s ping、两次无 pong 视为断线，走**既有**的 `disconnect()` →
  `takeOverByBot()` 同一条路（不开第二条断线路径）。
- **判据**：集成测试模拟半开连接（只握手不回 pong）→ 断言人机在超时窗口内接管。

## 1.4 A6 —— 跨房间 `Reconnect` 校验

- **改法**：`onReconnect` 先要求会话不在任何房间（已在房的先走完整 `onLeave` 清理再兑换令牌）。
- **判据**：单测 —— A 房会话用 B 房令牌重连：旧房名单被清理、`dropIfEmpty` 能生效。

## 1.5 A7 —— `referencedEntities()` 改 fail-closed

- **改法**：消息类型穷尽（`satisfies never`，与 codec 同手法）——
  新增带 EntityId 的服务器消息不登记就**编译不过**，而不是静默放行。
- **判据**：类型层保证 + 一条回归测试（现有消息逐类断言登记齐全）。

## 1.6 A8 —— 白名单与守卫补漏

- **改法**：`MATCH_ONLY` 补 `OpenArmory`/`ChooseArsenal`；`setReady()` 加 `room.started` 守卫。
- **判据**：两条单测（Room 阶段发战斗消息被拒；started 后 setReady 被拒）。

## 1.7 A12 + A13 + A14 + A15 —— 小修四连

- `antialias`：二选一 —— 真实现（切档重建 renderer）或从档位表删掉并删断言，**不留假绿**；
- 切画质保留昼夜 preset（`Environment` 记住当前 preset）；
- 删 `SWING_CLIPS` 不存在的片段名；
- 粒子池容量注释三处改正（含 PROGRESS ≈:481）。
- **判据**：`quality.test.ts` 不再断言无效字段；grep 确认死条目清零。

## 1.8 P1 + P5 + P2 —— 三个「一行级」性能修

- `tick.ts` 把循环不变量 `listEntities()` 提到循环外（groundArea/projectile 同法）；
- `broadcast()` stringify 一次 + `Session.sendRaw(string)`；
- `broadcastSnapshots` 对 Bot 会话跳过**构建与序列化**（⚠️ 跳的是浪费，不是可见性语义 —— 总账 🔵 表那条红线）。
- **判据**：行为零变化 —— `pnpm balance` 基线**逐位不变**、`verify:m10` 15/15、全量单测绿。

**批次一收尾动作**：全量回归（单测 + m1–m16 十五支）+ 总账状态列刷新 + PROGRESS 记一章。

---

# 批次二：接线速赢（按玩家感知排序，全部是「数据在、组件在、差喂一口」）

| # | ID | 项 | 改法要点 | 判据 |
|---|---|---|---|---|
| 2.1 | W1 | 联网队伍框 | 快照已有 team/health/classId，喂 `hud.party`（试验场 `:791` 那口的快照版） | verify 断言：双浏览器互见队友血条；治疗职业能按框选中 |
| 2.2 | W3+W4 | 联网模式 HUD + 决胜显示 | `match` 快照喂 `renderCtf`/**首次调用** `renderArena`（抑制百分比、决胜标志）；消费 `suddenDeathBlips` | m13 加断言：回合与比分可见；决胜阶段标志出现 |
| 2.3 | W2 | 联网小地图 | 快照实体喂 blips（潜行者天然不进快照，隐身安全免费获得） | 断言：隐身者不出现在小地图 |
| 2.4 | W5 | 死亡界面 + 观战镜头 | 死亡遮罩（竞技场「本回合已淘汰」/夺旗「复活波次 Ns」用 `respawnIn`）+ V 键把 `SpectateController.targetOf()` 真正接进镜头 | verify：死亡后遮罩出现、V 键镜头位置变化；活着时 V 无效 |
| 2.5 | W6 | 断线提示 + 延迟指示 | `onClose` 接 HUD 横幅「重连中（第 n 次）」；RTT 用快照 `serverTime` 差显示 | 手测拔网线 + 断言横幅 DOM 出现 |
| 2.6 | W9 | **设置面板** | 一个面板收口：音量四通道（`setVolumes` 首次有调用方）、画质档、9 项无障碍、键位表（只读展示，读 `getBindings()`）。入口：大厅按钮 + 对局内按键 | 断言：改动落 localStorage、刷新后生效；F3/F4 六项在联网对局可达 |
| 2.7 | W8 | R 解控 / Alt 自我施法 / 第 9 格 | `SKILL_SLOT_COUNT` 8→9 两处；Alt 按住把目标解析改自身；**R 解控先查 sim**：`UseTrinket` 结算缺一步 tick 接线（M10 已知不足），缺则先补 sim + 协议再接键 | 单测（战斗意志解控生效）+ verify（三个键都按得出来）；m12 技能栏计数断言同步改 |
| 2.8 | W10 | 大厅路径键位帮助 | 大厅进局装配 `#help`/`#stats`；`?net=` 老文案改掉 | 断言：大厅开局帮助可见且含 G/O/B/Z/X |
| 2.9 | W13 | BGM 战斗切换 + 环境音 | 客户端本地判定（近 N 秒有战斗事件 → combat 曲，脱战淡出回氛围曲）；每图配一首氛围曲 + 接 1-2 个 `amb_*` | 手测 + 断言曲目切换；速赢清单销账 |
| 2.10 | X1+W15 | 夺旗图装饰 + 昼夜 preset | `ctf.ts` 补 `decor`（`makeDecor` 管线现成）；`MapDef` 加 `preset` 字段、每图一档（依赖 1.7 的 A13 已修） | `verify:m12` 装饰断言家族扩一条；四图截图肉眼不同 |
| 2.11 | W16 | 复活保护表现 | essential 唯一无渲染器的角色：复活保护光环期间画一个标记（StatusMarkers 同族） | m12 断言：保护期标记可见、任何画质不消失 |
| 2.12 | W11 | 教学↔大厅闭环 | 毕业页加「回大厅」按钮；大厅读 `wowpvp.tutorial.v1`，未完成时在建房旁提示 | m15 23/23 不掉 + 新断言 |

**批次二红线**：只接**现有**协议数据；需要新字段的（规避三态、技能名）不在本批 —— 归批次四。

---

# 批次三：结构工程

| # | ID | 项 | 要点 | 判据 |
|---|---|---|---|---|
| 3.1 | G1 | **CI** | GitHub Actions：每 push 跑 `pnpm typecheck && pnpm test`；verify 脚本做成手动触发档（要起服务器+浏览器，先不进必跑） | 徽章绿；故意提交一个红测试验证会拦 |
| 3.2 | G2 | linter | eslint（flat config）或 biome，从零告警基线起步，进 CI | CI 含 lint 步骤 |
| 3.3 | G3 | 资产瘦身 + LFS | 先删可证明死重（`_2k.hdr` 全部 + 11 个未引用 preset ≈150MB）→ 盘点 `ui/` 死文件 → 拍板 LFS 迁移时机（**改写历史，越早越便宜**，需要所有克隆重拉） | `verify:m12` §1 素材校验不掉；clone 体积下降可量 |
| 3.4 | G4 | 双场景抽共享层 | **渐进不重写**：第一铲抽 `SceneShell`（renderer/env/quality/resize/canvas 输入接线），第二铲统一实体渲染循环（marker/护盾/化形那 5 行×2 收成一份），`syncWeapon` 只剩一份 | 行为零变化：全量 verify 不掉；重复清单逐项销 |
| 3.5 | W12 | **夺旗联网线** | 大厅加模式选择（协议扩 `SetRoomPreset` 或新消息，照 M10 规矩）→ `NetworkScene` 接 `FlagMarkers` + 旗手 blip + `renderCtf`（依赖 2.2/2.3 的底）→ 结算面板补夺旗列（X4 顺手） | **新 verify 脚本**：双浏览器纯 UI 开一场夺旗打到得分，全程断言旗帜可见 |
| 3.6 | S1–S6 | 公网硬化包 ✅ | 令牌桶限流、`maxPayload` 16KB、背压**巡检**断开（初版每 send 判被白盒快进误杀，改巡检式）、origin 白名单（`verifyClient` 握手层 + env）、连接/房间/成员三档上限 + `roomId ≤32`、tick try/catch（爆炸半径=单房间）+ `uncaughtException`（只主入口）+ JSON 日志 + `/healthz` + tick 耗时/丢帧计数 | ✅ `verify:hardening` 6/6：灌 4000 条/s 他房仍 100% 20Hz；限流/断开日志可见（2026-08-05） |
| 3.7 | P6 | 空房不空转 | 「零真人 session → 终止对局」判据（人机会话不算人） | 单测：全员掉线后 loop 停止、房间回收 |
| 3.8 | W14 | 上半身动画分层（大件，可并行慢做）🔧 | additive/骨骼遮罩已交付（脊柱子树遮罩 + makeClipAdditive，跑动施法上半身有姿态）；核心算法 6 单测（真骨架名）。**余账**：Block/Spellcast_Raise/Shoot/2H_Ranged 等 standalone 片段待接、真机观感截图待确认 | 🔧 分层机制清（2026-08-05，m12 art=on 无错）；截图 + standalone 片段留 |
| 3.9 | W7 | 键位重绑 UI + 持久化 | 设置面板 v2：`rebind()` 首次有调用方、localStorage 键、`<kbd>` 改读 `getBindings()` | 断言：重绑后提示同步、刷新保留、冲突检测 |

## W12 开工便签（2026-08-05 探路结论）

> **✅ 已完成（2026-08-05，同日）**：下面五步全部走完，`verify:w12` 11/11。
> 「数据侧几乎全通」判断成立但**只通到服务器为止** —— 消费侧前夜抓出三个
> 「写了没人调」真 bug（`ctfWinner` 服务器零调用 → 联网夺旗永远打不完；
> `enqueueRespawn` 生产路径零调用 → 死了永远躺着；`tickRespawn` 不写
> movement → 复活被拽回死点），外加墓地出生 yaw 反向。
> 时限/加时是探路时发现的独立缺口，另立总账 **A17**（不在本项内发明规则）。
> 交付细节与验证数字见 [PROGRESS.md](PROGRESS.md) 的 3.5 章。便签原文留档：

**比登记时预想的近**：数据侧几乎全通，缺的主要是消费方与模式选择。

已经在了（不用做）：
- 快照带旗帜：`MatchSnapshot.flags`（team/state/position/carrierId）与
  `score`（`shared/src/net/visibility.ts` ≈:412），竞技场为 undefined ——
  15.4 两视图不相交的既有设计
- `FlagEvent` 服务器消息（protocol.ts ≈:337）、minimap blip 已有
  `{ kind: 'flag' }`（≈:91）
- `SetRoomPreset` 客户端消息已存在（**只有 preset**，无 mode/mapId）
- 房间配置本就有 `mode/mapId`（`RoomServer.ts` DEFAULT_CONFIG，
  ⚠️ 地图 id 是 `ctf_*` 风格的**下划线**命名，别拿模式名当地图 id ——
  那个坑注释里有尸体）；`RoomState` 广播已带 mode/preset/mapId
- 试验场侧的成品可抄：`FlagMarkers`（vfx）、`ModeHud.renderCtf()`、
  夺旗 HUD 视图派生（`TestbedScene.ts` ≈:768-790）

要做的（按依赖顺序）：
1. **协议**：`SetRoomPreset` 扩成带 `mode`（或新 `SetRoomMode`，二选一后
   照 M10 规矩走全套：`ALL_CLIENT_MESSAGE_KINDS`、Session 阶段白名单、
   codec `satisfies never`、若新增带 EntityId 的服务器消息则
   `referencedEntities()` 必须登记 —— A7 教训）；服务器换 mode 时**连带换
   mapId 与合法人数档**，开赛前才可改（setReady 同款 started 守卫，A8）
2. **大厅**：模式选择 UI（房主可改，非房主只读展示；沿用 RoomState 既有
   广播链路）
3. **NetworkScene 消费**：`match.flags` → `FlagMarkers`（3D 旗）+
   minimap 旗帜/旗手 blip（W2 的底）+ `renderCtf`（W3/W4 的底）+
   CTF 复活倒计时（W5 余账一并清）
4. **结算面板**：夺旗列（X4 顺手，`MatchStats` 已有 flag 统计字段可查）
5. **新 verify 脚本**（判据）：双浏览器纯 UI 开一场夺旗打到得分，
   全程断言旗帜可见；可参考 verify-m13 的双浏览器骨架与 fillWithBots

红线：批次二那条「只接现有协议数据」在本项**解禁**（W12 本来就是协议项），
但改动打包进一次版本号变更，`verify:m10` 15/15 不掉。

---

# 批次四：协议债小批（攒成一次协议版本改动）

一起做的理由：都要过同一套流程（协议类型 + codec 校验 + 黑名单窗口 + 零泄露断言），
攒批做一次回归比零敲碎打便宜。

| ID | 项 | 拍板点 |
|---|---|---|
| W17 | `Damage.avoided`（闪避/招架/格挡三态） | 规避是**被攻击者**的信息，对攻击者可见是 8.x 的既有语义，无泄露争议 |
| X3 | `Damage.skillId`（死亡回顾显示技能名） | **与 S7 同题拍板**：隐身攻击者的技能/光环 id 是否泄露职业 —— 建议口径「来源不可见时 skillId 同 sourceId 一起抹，aura 同理」，一次定死 |
| S7 | 光环 id 的隐身泄露口径 | 同上；改动落 `snapshotEntity`/`AuraApplied` 裁剪 |
| W18 | 复核他人姓名板施法条数据源 | 复核结果要么销账、要么在本批补（快照或事件流二选一，倾向事件流 —— 快照加字段面更大） |
| A5/A4 | （评估项）转身速率上限 / 人机可见性过滤 | A5 动 sim 手感，需真机验证后定阈值；A4 给 `nearestFoe` 加视线/距离过滤，注意别把接管人机弄成瞎子 —— 两条评估后可放批次五 |

**判据**：`verify:m10` 15/15 不掉（黑名单窗口自检 + 零泄露断言）+ 每个新字段一条消费侧断言。

---

# 发布前清单（对外发布的门禁，做完批次一~四之后过）

| ID | 项 | 备注 |
|---|---|---|
| F1 | SkillId + 技能名原创化 | **创作决定先行**（起名评审），然后一次跨层重命名（id/光环/vfx key/武器表）；18.3。越晚越贵 |
| F2 | 素材投递方案 | 打包/CDN/按需加载三选一；与 G3 瘦身联动 |
| F3 | 公网硬化全绿 | = S 组销账 + TLS 终结（反代）+ 客户端 `wss://` 自适应 |
| F4 | 默认页翻成大厅 | 构建开关或独立入口；**无参验收路径红线不动** |
| F5 | 真人平衡实测轮 | bot 基线只是回归工具；组织真人局收数据再动数值（M14 规矩：先诊断根因） |
| F6 | 真 GPU 帧率/观感验证轮 | 12v12 最坏情况 + 特效分量对比（陨星 vs 霜矢 1.6 倍）在真机上肉眼过一遍 |

---

## 机动池（小体量，穿插做；全部见总账）

A9（Death 抹 id 下发）· A10（近战负边距，先补单测）· A11（死亡停发输入）·
A16（`describeCastBlockers`）· S8（掉线广播范围拍板）· S9（docs/08 补延迟补偿一节）·
P3（快照共享子结构）· P4（校验采样化）· P7（token 索引）· P8（instancing/材质）·
P9（自动降档）· P10（每帧小扫除）· X2（教学图装饰）· X5（满槽对比 UI）·
X6（引导条口径）· X7（盾过期收束）· X8（技能级音效）· X9（次级动作+池断言）·
X11（i18n，发布范围定）· X12（武器收纳）· G6（verify 去 sleep）· G7（manualChunks）·
G8（tsconfig/ws 版本）· B1（bot 决策升级，3v3 人机的前置）· B2（配平样本量）

---

## 每批收尾动作（老规矩，三处都要动）

1. [15-debt-registry.md](15-debt-registry.md) 状态列刷新（✅ 注明轮次，不删行）
2. [PROGRESS.md](PROGRESS.md) 记一章（验证数字如实：单测数、verify 结果、balance 基线）
3. 若涉验收语义，更新 [10-acceptance-tracking.md](10-acceptance-tracking.md)（偏差/Q 表）
