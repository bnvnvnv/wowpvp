# 技术债总账（唯一活账本）

> **这是全仓库技术债的唯一登记处。** 此前欠账散在四处：PROGRESS 技术债一节、
> 各里程碑章节的「已知不足」、docs/14 的「继承的技术债」、以及约 150 处
> 中文散文注释（「占位值」「欠条」「如实不画」「保守实现」）——
> **散文注释 grep 不出来，散账无法判断优先级**。2026-08-04 的全仓审计
> （四路：客户端 UX / 性能与债 / 服务器公平性 / 表现层对齐）把它们归并到这里。
>
> 与 [10-acceptance-tracking.md](10-acceptance-tracking.md) 的分工：
> **规格偏离**进它的「已知偏差」表、**设计留白**进它的 Q 表；「做了但欠着」的账进本表。
> 一件事最多在两边各有一行，互相引用，不重复叙述。

**创建**：2026-08-04（M16 完成后）
**行号口径**：证据列的行号是审计时点的快照，会漂移；**以文件 + 符号名为准**。

---

## 登记规矩（约束，随 [11-contributing.md](11-contributing.md) §8 检查清单执行）

1. **新债必须落账**：引入任何「先欠着」的取舍（占位值、保守实现、只做一半、
   写了没接线、协议缺字段…）时，在本表对应分类里加一行，领一个 ID。
2. **代码注释挂 ID**：新债在代码注释里写 `// DEBT(A1): 一句话`，从此可 grep。
   存量注释**不回改**（无行为收益、污染 blame）；触碰旧文件时顺手补标。
3. **还清改状态、不删行**：状态改 ✅ 并注明还债的轮次/提交，与 docs/10 偏差表同规矩。
   把已完成记成未完成、把未完成记成已完成同样有害（M16 军械箱之鉴：三处文档
   写着「数据类型都不存在」，实际 M11-6 就做完了）。
4. **决定 ≠ 债**：有意的边界标 🔵 并写理由（或链接），防止后人当成待办去「修」。
5. **PROGRESS 章节照常写叙事**，但每条「已知不足」必须同步在本表落一行 ——
   判断「还欠多少」只看这里。
6. **每个里程碑/批次收尾过一遍表**：状态列刷新，新增的债补登。

**状态图例**：⛔ 未处理 · 🔧 进行中 · ✅ 已清（注明轮次）· 🔵 决定（有意边界，非欠账）· ⚠️ 待复核

**执行计划**见 [16-roadmap-post-m16.md](16-roadmap-post-m16.md) —— 本表管「欠了什么」，计划管「何时还」。

---

## A. 正确性（实现与规则 bug）

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| A1 | **`LeaveMatch` 淘汰绕过死亡漏斗**：`eliminate()` 直改 `alive/health` 字段，不产生 death 事件 → `deaths` 统计不加（**违反 11.5**，且函数上方注释声称在执行 11.5）、`settleDeaths()` 不跑（10.10 临时装备不清）、无 `Death` 广播。零测试覆盖 | `packages/server/src/room/RoomServer.ts` `eliminate()`（≈:494）；对照 `shared/src/sim/stats.ts` death 分支、`sim/effects/combat.ts` 事件发射点、`sim/death.ts` | 统计失真 + 规则静默失效 | ⛔ |
| A2 | **无输入实体不做物理积分**：`tickWorld` 第 2 步 `if (!input) continue` → 不积分重力、不软推开。停发 Input 即可空中悬停 + 单向卡位；正确性寄托在「客户端每 tick 都发」的自觉上 | `packages/shared/src/sim/tick.ts`（≈:357）自带注释承认 | 可被主动利用（悬空/卡位）；高丢包玩家持续微顿 | ⛔ |
| A3 | **无心跳/空闲超时**：半开连接（断电、NAT 超时）永远不被识别为断线 → **不触发人机接管**。偏差 #14「断线瞬间接管」只对优雅关闭的连接成立 | `packages/server/src` 全包无 ping/pong/idle 检测 | 最常见的断线形态下队友是十几分钟的活靶 | ⛔ |
| A4 | **人机决策拿全局信息**：`nearestFoe()` 遍历全部实体，不过可见性/视线 → 能感知潜行者精确坐标并据此走位。「故意断线换 AI 代打」附带信息优势 | `packages/server/src/BotDriver.ts` `nearestFoe()`（≈:186） | 偏差 #14 论证了不规避统计，未论证不规避信息面 | ⛔ |
| A5 | **朝向无转身速率限制**：`intent.facing` 在 `validateCast` 之前被无条件采信，移动的 `characterYaw` 同 → 脚本客户端永远满足朝向门禁（spinbot）；背刺「背后 120°」的转身博弈对作弊者不成立 | `packages/shared/src/sim/tick.ts`（≈:319）；`FORBIDDEN_CLIENT_FIELDS` 不含 yaw/facing | 反作弊边界的口子 | ⛔ |
| A6 | **跨房间 `Reconnect` 造成房间永久泄漏**：`onReconnect` 不查 `session.roomId/phase` 直接覆写 → 旧房间的旧 playerId 永不清理，`dropIfEmpty()` 恒 false | `packages/server/src/room/RoomServer.ts` `onReconnect()`（≈:579-613） | 资源泄漏（非信息泄漏，playerId 全局唯一） | ⛔ |
| A7 | **`referencedEntities()` fail-open**：`default: return []` → 新增带 EntityId 的服务器消息忘登记时，`redactFor` 原样放行。与 codec 侧 `satisfies never` 的穷尽保证是同一问题的相反做法；零测试 | `packages/server/src/MatchLoop.ts`（≈:815-824） | 防线本身没有防线 | ⛔ |
| A8 | **阶段白名单漏两条 + 房间函数漏守卫**：`MATCH_ONLY` 不含 `OpenArmory`/`ChooseArsenal`（当前被下游 `!sr?.loop` 兜住）；`setReady()` 是唯一没有 `room.started` 守卫的房间变更函数 | `packages/server/src/room/Session.ts`（≈:56-60）；`shared/src/sim/match/room.ts` `setReady()` | 纵深防御各少一层 | ⛔ |
| A9 | **`Death` 事件对「杀手不可见」的接收者整条丢弃** → 全队收不到死亡反馈，只能靠快照 `alive:false` 推断。偏差 #4 家族残留：`Damage` 已改「发但抹 sourceId」，`Death` 没跟 | `packages/server/src/MatchLoop.ts` `redactFor` default 分支 | 命中/死亡反馈缺失（14.1 同源） | ⛔ |
| A10 | **近战 `inRange` 把碰撞体重叠判为超距**（原 PROGRESS 技术债 §8 迁入）：负边距 + `min=0` 检查 → 站进模型里拳击永远 OutOfRange。修时先补「重叠时可施放」单测 | `packages/shared/src/math/geometry.ts` `edgeDistance` 注释 + `inRange()` | 需主动贴脸才触发，低频 | ⛔ |
| A11 | **死亡后客户端照常发输入、技能栏可点**（服务器静默拒绝）：`simulate` 只判 `started` 不判 `alive` | `packages/client/src/scenes/NetworkScene.ts` `simulate()`（≈:1139） | 无害但脏流量 + 死亡体验混乱（与 W5 联动） | ⛔ |
| A12 | **`antialias` 是死设置且有假绿测试**：档位表声明、`QualityController.apply()` 不消费、两个场景渲染器硬编码 `true`，而 `quality.test.ts` 断言这个无效字段 —— 「测试通过 ≠ 功能存在」的实例 | `packages/client/src/render/quality.ts`（≈:167）、`QualityController.ts`（≈:65-71）、`quality.test.ts`（≈:97） | 低端机 low 档拿不到承诺的收益；绿灯说谎 | ⛔ |
| A13 | **切画质丢昼夜 preset**：两处 `env.apply(tier)` 不带 preset 参数，回落 day | `packages/client/src/scenes/TestbedScene.ts`（≈:916）、`NetworkScene.ts`（≈:811） | 一行级；W15 做完后会显形 | ⛔ |
| A14 | **`SWING_CLIPS` 含不存在的片段名** `Unarmed_Melee_Attack_Punch_A`（任何模型里都没有）；[1] 之后的条目全是死分支 | `packages/client/src/entity/CharacterView.ts`（≈:66-69） | 死数据误导后人 | ⛔ |
| A15 | **粒子池容量注释三处过期互相矛盾**：注释写 32 格/40 格，实际事件池 40×48、细流池 48×32 | `packages/client/src/vfx/ParticleBurst.ts`（≈:459-461）、`docs/PROGRESS.md`（≈:481） | 文档说谎 | ⛔ |
| A16 | **施法失败提示优先级**（原 PROGRESS 技术债 §3）：资源检查排在距离前 → 怒气 0 的战士在 30 米外收到「资源不足」。正解是**另加** `describeCastBlockers()` 全量提示，不改门禁顺序 | `packages/shared/src/sim/casting.ts` `validateCast()` 顺序 | 提示质量（15.2） | ⛔ |

## S. 安全与公网部署

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| S1 | **无任何消息速率限制**：`inputQueue` 在 tick 间无上限；`pendingCommands` 无界且逐条执行（1000 条 TabTarget = 一 tick 内 1000 次全实体排序）。单客户端可拖慢同机全部房间 | `packages/server/src/room/Session.ts` `handleRaw`；`MatchLoop.ts` `enqueue()`/`applyCommands()` | **不需要游戏知识即可打穿**的路径 | ⛔ |
| S2 | **无 `maxPayload`（ws 默认 100MiB）/ 无出站背压（不看 `bufferedAmount`）/ `roomId` 无长度上限**（会被当 Map 键长期持有） | `packages/server/src/index.ts`（≈:50、:23-27）；`shared/src/net/codec.ts` roomId 分支 | 内存放大 / 慢读者拖爆出站缓冲 | ⛔ |
| S3 | **无 origin 校验、无连接/房间/房内人数上限**（观战席无限，每人每 tick 一份完整快照） | `index.ts`（无 verifyClient）；`room/RoomServer.ts` `connect()`；`shared/src/sim/match/room.ts` `joinRoom()` | 跨站连接 + 资源放大 | ⛔ |
| S4 | **无 TLS/WSS**：客户端硬编码 `ws://`；重连令牌明文过网且**整局 24h 有效** → 同网段嗅探一次即可在受害者断线时接管。令牌本身是 UUIDv4（够强），弱点全在传输层 | `packages/client/src/main.ts`（≈:139）；`room/RoomServer.ts` `TAKEOVER_GRACE_SECONDS`（≈:112） | 会话劫持面；HTTPS 页面下混合内容直接连不上 | ⛔ |
| S5 | **tick 循环无异常防护**：`setInterval(pump)` 无 try/catch、无 `uncaughtException`/SIGTERM 处理，而 `assertNoHiddenEntities` 设计上会抛 → 一个 bug = 全服进程崩、带走所有房间 | `packages/server/src/MatchLoop.ts`（≈:152-157、:697） | 单点全崩 | ⛔ |
| S6 | **无监控/结构化日志/健康检查**：全部日志 6 行 console；追帧丢弃（超 5 tick 丢）是静默的，过载不可见 | `index.ts`；`MatchLoop.ts`（≈:171） | 运维盲区 | ⛔ |
| S7 | **光环 id 全量下发泄露隐身攻击者的职业**：`Damage.sourceId` 抹了，但目标身上的 `auraId`（形如 `rogue.rupture`）与 `AuraApplied` 广播直接说出攻击者职业。「抹来源」防线的语义漏点，需拍板口径（与 X3 的 skillId 同题） | `shared/src/net/visibility.ts` `snapshotEntity` auras 分支 | 不违反任何验收，但未记录过 | ⛔ |
| S8 | **`PeerDisconnected`/`PeerEliminated` 全房广播** → 敌方准确知道哪个对手正由 AI 操作（战术信息）。需设计拍板：是否只发给己方 | `room/RoomServer.ts`（≈:176-180、:509） | 与偏差 #14 耦合 | ⛔ |
| S9 | **文档债**：无延迟补偿（判定用服务器当前 tick，高延迟纯吃亏）是合理取舍但 docs/08 **没写**；「20Hz 够用」的论证只覆盖控制时长分辨率，没覆盖输入 50ms 量化对打断窗口的影响 | `docs/08-network-protocol.md` §5 | 取舍未记档 = 将来被当 bug 反复排查 | ⛔ |

## W. 接线缺口（组件写完了、没人喂 ——「写对了没人调」家族存量）

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| W1 | **联网无队伍框**：`PartyFrame` 已构造、试验场在喂，`NetworkScene` 零调用 → 队友血量看不见，**治疗职业没法玩** | `packages/client/src/hud/PartyFrame.ts`；`CombatHud.ts`（≈:125） | 极高感知 | ⛔ |
| W2 | **联网无小地图**：`Minimap` 零调用；`'supply'`/`'objective'` blip 类型无生产者（M16 已记的军械点图标属此） | `hud/Minimap.ts`（≈:31）；`hud/ModeHud.ts`（≈:175） | 战场态势不可知 | ⛔ |
| W3 | **联网无模式 HUD**：`ModeHud.renderCtf` 全仓唯一调用点在试验场；`respawnIn`/`supplyRespawnIn`（12.6 复活波次倒计时）**从未被任何一边喂过** | `hud/Scoreboard.ts:7-11` 注释自陈；`hud/ModeHud.ts`（≈:39,56） | 比分/计时/旗帜/复活全不可见 | ⛔ |
| W4 | **`ModeHud.renderArena()` 两个场景都零调用** → 8.5 战斗抑制百分比与「决胜阶段」**从未显示给任何玩家**；协议字段 `suddenDeathBlips` 客户端零消费 | `hud/ModeHud.ts`（≈:115-127）；`shared/src/net/visibility.ts`（≈:410） | 核心节奏机制不可见 | ⛔ |
| W5 | **死亡后无去向 + 观战未接镜头**：无「你已阵亡」遮罩、无复活倒计时；`SpectateController` 规则/测试齐全但 V 键只 `console.info`，镜头从未切换（其 `:90` 注释指向一个不存在的死亡界面）。观战席玩家开局停在房间页（M13 边界）也归此 | `spectate/SpectateController.ts`（≈:90）；`TestbedScene.ts`（≈:942）；`NetworkScene.ts`（≈:631-653） | 「死后 20 秒」是最易流失时刻 | ⛔ |
| W6 | **断线全程静默**：`NetworkScene` 自建连接的 `onClose` 是空实现；大厅只在放弃重试后 toast 一次；约 7.75s 退避重连零提示；全客户端无延迟/连接状态指示 | `NetworkScene.ts`（≈:357）；`lobby/LobbyShell.ts`（≈:126-129）；`net/Connection.ts` | 网络问题被误判成游戏 bug | ⛔ |
| W7 | **键位事实上不可重绑**：`rebind()`/`getBindings()` 全仓零调用方、无持久化；技能栏 `<kbd>` 写死 1-8（接了重绑也会撒谎）。17.2 明文要求可重绑 | `input/InputManager.ts`（≈:156-163）；`hud/CombatHud.ts`（≈:411） | 无障碍 + 非 QWERTY 玩家被挡 | ⛔ |
| W8 | **三个已定义动作不可达**：`Trinket`（R 通用解控，8.3 —— **PVP 核心反制**，且 sim 侧 `UseTrinket` 结算也未接，M10 已知不足迁入）、`SelfCast`（Alt，5.6）、`Skill9`（两处 `SKILL_SLOT_COUNT=8` 截断第 9 格护盾） | `input/InputManager.ts`（≈:90-101）；`NetworkScene.ts`（≈:98）；`TestbedScene.ts`（≈:965） | 被控只能干看着 | ⛔ |
| W9 | **无设置面板**：音量四通道（`setVolumes()` 零调用）、画质（F2 盲切、反馈在 console）、9 项无障碍（F3/F4 仅试验场响应，6 项在联网完全无法触达）——**数据层与持久化全部就绪，只差一个面板** | `audio/AudioManager.ts` `setVolumes`；`settings/accessibility.ts`；`settings/audioSettings.ts`；`CombatHud.ts:163` 注释指向不存在的面板 | 投入产出比最高的单项 | ⛔ |
| W10 | **大厅路径的对局不装配键位帮助/状态面板**：`#help`/`#stats` 只在无参路径挂；`?net=` 老路帮助文案停在「M1 试验场」且 `#stats` 无人绘制 | `main.ts`（≈:26-29、:174-178）；`LobbyShell.ts`（≈:493-499） | 新手主路径恰好是唯一没提示的 | ⛔ |
| W11 | **教学↔联网断链**：毕业文案「去大厅找真人过招」但无回大厅按钮；大厅从不读 `wowpvp.tutorial.v1` | `tutorial/TutorialHud.ts`（≈:51）；`lobby/LobbyShell.ts` | 转化漏斗断口 | ⛔ |
| W12 | **夺旗联网线未通**：大厅无模式选择（预设仅经典/武装竞技场）→ 联网夺旗**无入口**；即便进入，`NetworkScene` 无 `FlagMarkers` import、无旗手 blip、无 CTF 面板 —— M7 整套规则 + M9 35 条验收只活在 sim 与试验场演示里 | `NetworkScene.ts`（`match.flags` 仅用于判 isCtf ≈:1212）；`LobbyShell.ts` 预设开关 | 一整个游戏模式联网不可玩 | ⛔ |
| W13 | **音频接线欠账**：BGM 战斗切换未做（`lastCombatAt` 数据在、audio 层零引用；19 首曲子只播 `combat_1`）；10 个 `amb_*` 环境音零使用；脚步只有 `foot_stone` 单材质；联网无脚步/跳跃/落地/驱散/位移音 | `audio/AudioManager.ts`；`assets/music/`；`NetworkScene.ts` | 氛围与反馈缺层（速赢清单项） | ⛔ |
| W14 | **8 个动画片段零调用**（`Spellcast_Raise`/`Spellcast_Shoot`/`2H_Ranged_Shoot`/`Block`/`Dualwield_Melee_Attack_Chop`/`Lie_Idle`/`Sit×2`）；**跑动中施法无上半身表现**（`applyClip` 单片段全身淡化，只有 Idle 才播施法姿态，无骨骼分层/additive） | `entity/CharacterView.ts`（≈:540-576，:545-546） | 每分钟都发生的表现缺失；工作量大 | ⛔ |
| W15 | **昼夜 preset 全闲置**：5 个 HDR preset 只用 `day`，`MapDef` 无 preset 字段（速赢清单「每张图配一个」连数据入口都没开）；`EnvironmentOptions.sky` 从未被传 false | `render/Environment.ts`（≈:24-31）；4 处调用点全 day | 四张图长得一样 | ⛔ |
| W16 | **复活保护无渲染器**：`spawnProtection` 是 14.4 essential 八项里唯一「保证不被隐藏、但从来没被画过」的角色 | `render/quality.ts`（≈:57-58）全仓孤立引用 | 保护期不可见 → 玩家误判 | ⛔ |
| W17 | **协议缺 `Damage.avoided`**：联网侧闪避/招架/格挡无区分 → 规避三态特效与音全缺（M12 已知不足迁入，「如实地少一层」） | `NetworkScene.ts`（≈:585-601）；`shared/src/net/protocol.ts` | 一笔协议债，照 M10 规矩还 | ⛔ |
| W18 | **待复核**：他人姓名板施法条在联网侧是否有数据源（M10 已知不足记「快照无他人施法状态」；特效二期接了 `CastStarted` 事件流后 HUD 侧是否跟上未核实） | `net/SnapshotCombatView.ts` `castOf()` | 复核后要么销账要么转正 | ⚠️ |

## X. 表现与内容打磨

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| X1 | **夺旗图 0 件装饰** —— 唯一没有 `decor` 字段的图（速赢清单「下一铲」） | `shared/src/data/maps/ctf.ts` | 灰盒观感 | ⛔ |
| X2 | 教学图装饰仅 6 件「够用不够看」；走位环无专用地形 | `maps/tutorial.ts`；`PROGRESS.md` 教学分家章节 | 第一印象 | ⛔ |
| X3 | **死亡回顾无技能名**：协议 `Damage` 只带 school，需加 `skillId`（与 S7 的泄露口径一起拍板） | `NetworkScene.ts`（≈:604-608）；M16a 已知不足 | 协议债 | ⛔ |
| X4 | 结算面板无夺旗专属列（携旗距离/护送时长 sim 里都有）；连杀播报无「终结连杀」提示（数据够 UI 没做） | M16a 已知不足 | 夺旗线依赖 W12 | ⛔ |
| X5 | 装备满槽无「选哪件换掉」对比 UI（10.5 后半，M16 已知不足） | `hud/ArsenalHud.ts` | 武装竞技场体验 | ⛔ |
| X6 | 引导条 HUD 仍是读条口径（4 秒满格）——3D 法阵已按引导独立时间轴走，HUD 没跟 | `hud/CombatHud.ts` `endsAt - startedAt` 口径 | 引导技能读条骗人 | ⛔ |
| X7 | 盾自然过期无收束动作（过期不是破裂，是对的；但壳直接消失没有淡出） | 特效二期已知不足 | 小 | ⛔ |
| X8 | 音效无技能级分化：91 技能共用 7 组学派音；盘里 `cast_chain_heal`/`cast_lightning_bolt` 等专用音零使用 | `audio/AudioManager.ts` `CAST_SOUND`/`IMPACT_SOUND` | 大招没有专属声音签名 | ⛔ |
| X9 | 粒子次级动作（同爆发内各层错开 40-80ms）未做；池饱和度断言未补（三期已知不足） | `vfx/ParticleBurst.ts`；`SpellVfx.ts`（≈:464）注释 | 观感上限 | ⛔ |
| X10 | **真 GPU 上从未验证观感与帧率**：全部验收跑在 swiftshader 软渲染（空闲 4 FPS）下，「够不够炫」「掉不掉帧」都没有真机数据 | 三期已知不足；`verify-m8` 注释 | 12v12 帧率是未知数 | ⛔ |
| X11 | 多语言未做（HUD/大厅/教学全中文硬编码，无 i18n 层） | M13/M15 已知不足 | 发布范围决定 | ⛔ |
| X12 | 武器无背后收纳（`ui_weapon_sheathe` 音效已备好） | M12 已知不足 | 小 | ⛔ |

## P. 性能

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| P1 | **`listEntities()` 每次 spread 新数组且被放进嵌套循环**：tick 软推开对每个移动实体再 spread 全体（O(n²) + 24 人 48 数组/tick）；groundArea 三层嵌套；projectile 每子步 3 次数组分配。`tick.ts` 内层调用是**循环不变量，提出去一行即消** | `shared/src/sim/world.ts:92`；`sim/tick.ts`（≈:374-377）；`sim/groundArea.ts`（≈:86,96）；`sim/projectile.ts`（≈:255,283） | 20Hz × 所有房间的基础成本 | ⛔ |
| P2 | **人机会话拿完整快照 + 裁剪 + `JSON.stringify` 后在 socket 层丢弃** → 满人机房开销 = 满人房。`BotDriver` 注释自认欠账但低估了成本（stringify 也跑了） | `room/RoomServer.ts` `takeOverByBot`（塞进 sessions）；`MatchLoop.ts` `broadcastSnapshots`；`BotDriver.ts:50-58` | 补位与接管都走这条路 | ⛔ |
| P3 | **快照中与视角无关的部分逐接收者重建**：projectiles/grounds/flags/score/armories/suddenDeathBlips 每人重算；每实体 `Object.fromEntries(resources)`×2 → 24 人 ≈ 2.3 万对象/秒 | `shared/src/net/visibility.ts`（≈:489-547、:566-573） | GC 压力主源 | ⛔ |
| P4 | `assertNoHiddenEntities` 在生产环境把 O(sessions×entities) 可见性再跑一遍（成本 ×2）。🔵 「宁可掉线不能透视」的决定**保留**，但成本应可度量，可改采样/轮转校验 | `MatchLoop.ts`（≈:697-700） | 有意但未度量 | 🔵/⛔ |
| P5 | **广播对同一消息 stringify N 次**（RoomState/MatchEnd/统计等全量广播）。修法零风险：stringify 一次 + `sendRaw(string)` | `room/RoomServer.ts` `broadcast()`（≈:658）；`MatchLoop.ts` `broadcastStats()` | 白算 | ⛔ |
| P6 | **全员掉线的对局照跑 20Hz 到终局**：started 分支不调 `dropIfEmpty`，且人机会话占着 `sessions` 让判空恒 false → 无人房间跑完整局（夺旗半小时量级），叠加 P2 | `room/RoomServer.ts` `disconnect()`（≈:152-180、:189） | 可被外部触发的资源占用 | ⛔ |
| P7 | 重连令牌查找 O(rooms) 线性扫（`[...rooms.values()].find(...)`），应建 token→room 索引 | `room/RoomServer.ts`（≈:580） | 小 | ⛔ |
| P8 | 无 instancing（全仓 0 处 `InstancedMesh`）；模型材质逐 mesh `.clone()`（为受击闪白）破坏合批 —— 可改顶点色/uniform | `entity/ModelLibrary.ts`（≈:143-145）；`arsenal/ArsenalView.ts` 等 | draw call 随掉落物线性涨 | ⛔ |
| P9 | **无自动画质降档**：两场景默认 High（2048 阴影 + 2x 像素比），FPS 已量但无反馈回路，低端机只能自己按 F2 | `render/QualityController.ts`；`GameLoop.ts` fps | 低端机第一印象 | ⛔ |
| P10 | 每帧小额浪费：`NetworkScene` 多处线性 `find/some`（有 Map 不用）；记分板可见时每帧重建对象数组 | `NetworkScene.ts`（≈:1101,1173,1218-1225,1310） | 低 | ⛔ |

## G. 工程与流程

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| G1 | **无 CI**：1113 条单测 + 15 支验收全靠手跑，没有任何东西保证提交时它们被跑过 —— **所有其他债的放大器** | 仓库无 `.github/` | 回归网全靠自觉 | ⛔ |
| G2 | **无 linter/formatter**（eslint/biome/prettier 全无） | 各包无配置 | 风格与低级错误无门禁 | ⛔ |
| G3 | **573MB 素材直接进 git、无 LFS**（`.git` 已 482MB、3861 个素材文件被跟踪）；其中**约 150MB 可证明死重**：`_2k.hdr` 126.7MB 代码从不加载（只拼 `_1k` 路径）+ 11 个未引用 `_1k` preset ≈22MB；`ui/` 1451 文件仅 ~93 个被引用 | `.gitattributes` 无 `filter=lfs`；`render/Environment.ts`（≈:86 硬编码 `_1k`、:24-31 仅 5 preset） | clone 成本；历史永久膨胀，转 LFS 越拖越贵 | ⛔ |
| G4 | **试验场与联网场景是 2779 行平行实现**：~24 个同名字段、`syncWeapon()` 逐字节重复（含同一句注释）、控制标记优先级逻辑写了两遍（联网侧注释声称「不会两条路各写一遍」但确实写了）。已有 `CombatView`/`loadoutViewFromSnapshot` 证明抽共享层可行 —— 这是「护盾判据分叉」类 bug 的持续温床 | `TestbedScene.ts`（1263 行）vs `NetworkScene.ts`（1516 行）；`:619-623` vs `:1455-1459`；`:755-766` vs `:1414-1425` | 每加一个表现都要写两遍、漏一边 | ⛔ |
| G5 | **债务不可 grep**：~150 处欠账以中文散文注释存在，无机器标记 → 无法统计、无法收敛。**本表即解法**；新债照登记规矩挂 `// DEBT(ID):` | 全仓 0 处 TODO/FIXME/HACK | 判断不了「还欠多少」 | 🔧 本表建立即开始清偿 |
| G6 | verify 脚本靠硬编码 sleep：14 支脚本静态累计 126.8 秒固定等待（m15 一支 27.4s/38 处） | `scripts/verify-*.{mjs,ts}` | 手跑成本高、偶发脆弱 | ⛔ |
| G7 | `vite build` 无 `manualChunks`（three ~600KB 进首 chunk）；动态 import 只有 2 处（NetworkScene/LobbyShell），TestbedScene 静态打包 | `packages/client/vite.config.ts` 无 build 配置 | 首屏体积 | ⛔ |
| G8 | 小项：`exactOptionalPropertyTypes` 关闭（代码里大量 `...(x!==undefined?{x}:{})` 说明本可以开）；`ws` 版本两处不一致（^8.21.1 / ^8.18.1） | `tsconfig.base.json`；两处 package.json | 低 | ⛔ |

## F. 发布阻塞（对外发布的门禁，`docs/09` §7.2 同源）

| ID | 债 | 证据 | 状态 |
|---|---|---|---|
| F1 | **SkillId 与技能名原创化**：91 技能 85 个可辨识借用 WoW；**id 是承重的**（光环 id、vfx key、武器 grants/removes 全引用）→ 跨数据层重命名 + 创作决定（起名评审），规格书 18.3。「不要拖到发布前」 | PROGRESS 技术债 §7；`docs/09` §3 | ⛔ |
| F2 | **素材投递方案**：`vite build` 产物不含 assets（dev 靠中间件流式读），发布怎么带 573MB 未定（打包/CDN/按需加载） | `packages/client/vite.config.ts` 文件头注释；`docs/09` §7.2 | ⛔ |
| F3 | **公网硬化包全绿**（= S1–S6 + TLS 终结 + 客户端 URL 协议自适应） | 见 S 组 | ⛔ |
| F4 | **默认页翻成大厅**：现默认试验场（141 项验收载体的红线保持——发布用构建开关或独立入口，不动无参路径） | `main.ts` 路由；M13 已知不足 | ⛔ |
| F5 | **真人平衡实测**：`pnpm balance` 是回归工具不是平衡真相（bot 不会假读条/绕柱/风筝；种子间波动 ±6pp）——发布前需要真人对局轮 | `scripts/balance-report.ts` 自述；M14b 章节 | ⛔ |
| F6 | **真 GPU 帧率/观感验证轮**（= X10，发布门禁重列） | — | ⛔ |

## B. 平衡与 AI

| ID | 债 | 证据 | 状态 |
|---|---|---|---|
| B1 | `decideBotAction` 只支持单目标（选敌/换目标/保队友没做）；不会用地面技能（`CastIntent` 不产落点，「如实少一类」）；无寻路（撞死角就停）—— 3v3 以上人机可用性的前置 | `shared/src/ai/botController.ts` 自述注释；M16b 已知不足 | ⛔ |
| B2 | 配平测量边界：每对 3 场的离散度（种子 2 极差 40.5pp）；盗贼规避组合被 bot 高估 —— 已如实记录，扩大样本量是可选项 | M14 章节 | ⛔ |

---

## 🔵 已拍板的决定（不是欠账 —— 防止后人当成待办去「修」）

| 决定 | 理由出处 |
|---|---|
| custom handler 剩 2 处（`priest.leapOfFaithLandingGuard`、`druid.wild_charge`）**保留** | PROGRESS 技术债 §1：语义确实无法数据化 |
| 试验场**不建**军械箱 | 141 项验收的初始条件不能污染（M16 已知不足，牧师套盾打掉 M4a 之鉴） |
| 教学课程以法师栏位写死 | 教学载体是试验场，玩家就是法师（M15） |
| 联网技能栏可用性**保守判断**（只看冷却与资源） | 真门禁要 World，宁可多一次被拒的请求也不误报不可用（M10） |
| 音频用线性距离衰减，**不用** `PositionalAudio` | 方位音在镜头旋转时飘忽（`AudioManager.ts` 注释） |
| 不引入 rapier，物理手写确定性圆柱体 | 跨平台确定性是回放/配平前提（`movement.ts` 文件头） |
| `assertNoHiddenEntities` 生产环境开启 | 宁可掉线不能透视（docs/13）—— 成本问题走 P4，不关校验 |
| playwright 固定版本（唯一不带 `^` 的依赖） | 浏览器验收对版本敏感，可复现优先 |
| 人机照常收快照（不绕开裁剪） | 绕开 = 给人机透视；成本问题走 P2 的「按 session 类型跳过序列化」，**不是**跳过裁剪语义（M16b） |
| 大厅不是默认路径 | 无参路径是验收载体红线；发布时走 F4，不动这条 | 

---

## 归并说明（旧账去向）

| 旧出处 | 去向 |
|---|---|
| PROGRESS 技术债 §1（custom 收敛） | ✅ 已清至 2 处保留 → 🔵 决定表 |
| §2 数值占位 / §2b 普攻 | ✅ M14 / M11 已清（历史记录留在 PROGRESS） |
| §3 施法失败提示优先级 | → **A16** |
| §5 抗法护甲 schema | ✅ M11 已清 |
| §6 消耗品 | ✅ M11-6 + M16 已清 |
| §7 技能名/SkillId | → **F1** |
| §8 近战 inRange 负边距 | → **A10** |
| docs/14「继承的技术债」三条 | → 🔵（custom）/ **F2**（打包）/ **F1**（SkillId） |
| docs/14 速赢清单剩余三项 | → **W13**（BGM）/ **W15**（昼夜）/ **X1**（夺旗装饰） |
| 各里程碑章节「已知不足」仍开放的 | → A9/A11/W2-W8/W12/W16-W18/X2-X12/B1（逐条见上） |
| docs/10 已知偏差 #6/#7/#8/#9/#10/#11/#12 | **留在偏差表**（规格偏离，不是欠账）；#14 的实现缺口拆成 A3/A4/S8 |
| docs/10 待设计确认 Q1–Q15 | **留在 Q 表**（设计留白）；与本表交叉的只有 S7/X3 的泄露口径拍板 |
