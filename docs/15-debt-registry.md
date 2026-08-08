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
| A1 | **`LeaveMatch` 淘汰绕过死亡漏斗**：`eliminate()` 直改 `alive/health` 字段，不产生 death 事件 → `deaths` 统计不加（**违反 11.5**，且函数上方注释声称在执行 11.5）、`settleDeaths()` 不跑（10.10 临时装备不清）、无 `Death` 广播。零测试覆盖 | `packages/server/src/room/RoomServer.ts` `eliminate()`；修法见 `sim/tick.ts` 第 0 步 `forfeits` | 统计失真 + 规则静默失效 | ✅ 批次一 1.1（2026-08-04，含变异测试） |
| A2 | **无输入实体不做物理积分**：`tickWorld` 第 2 步 `if (!input) continue` → 不积分重力、不软推开。停发 Input 即可空中悬停 + 单向卡位；正确性寄托在「客户端每 tick 都发」的自觉上 | `packages/shared/src/sim/tick.ts` 第 2 步（缺输入现按全零输入积分；「无 movement 条目不参与移动」边界不变） | 可被主动利用（悬空/卡位）；高丢包玩家持续微顿 | ✅ 批次一 1.2（2026-08-04，含变异测试；verify-m10 白盒摆位随之改用 teleportTo） |
| A3 | **无心跳/空闲超时**：半开连接（断电、NAT 超时）永远不被识别为断线 → **不触发人机接管**。偏差 #14「断线瞬间接管」只对优雅关闭的连接成立 | `packages/server/src/index.ts` 心跳（默认 30s ping × 2 次落空 → terminate，走既有 close→disconnect→接管路径） | 最常见的断线形态下队友是十几分钟的活靶 | ✅ 批次一 1.3（2026-08-04，含变异测试） |
| A4 | **人机决策拿全局信息**：`nearestFoe()` 遍历全部实体，不过可见性/视线 → 能感知潜行者精确坐标并据此走位。「故意断线换 AI 代打」附带信息优势 | `nearestFoe` 按 `isVisibleTo`（与快照裁剪/SetTarget 校验同一判定）过滤：人机看得见的 = 真人看得见的；全场只剩潜行者时原地待机（真人同处境，非瞎子）；被发现瞬间照常进候选 | 偏差 #14 论证了不规避统计，未论证不规避信息面 | ✅ P1a（2026-08-05，BotDriver 单测 ×4） |
| A5 | **朝向无转身速率限制**：`intent.facing` 在 `validateCast` 之前被无条件采信，移动的 `characterYaw` 同 → 脚本客户端永远满足朝向门禁（spinbot）；背刺「背后 120°」的转身博弈对作弊者不成立 | `packages/shared/src/sim/tick.ts`（≈:319）；`FORBIDDEN_CLIENT_FIELDS` 不含 yaw/facing | 反作弊边界的口子 | ⛔ |
| A6 | **跨房间 `Reconnect` 造成房间永久泄漏**：`onReconnect` 不查 `session.roomId/phase` 直接覆写 → 旧房间的旧 playerId 永不清理，`dropIfEmpty()` 恒 false | `packages/server/src/room/RoomServer.ts` `onReconnect()` 入口守卫（在房会话诚实拒绝，与 JoinRoom 同规矩） | 资源泄漏（非信息泄漏，playerId 全局唯一） | ✅ 批次一 1.4（2026-08-04，含阳性对照与变异测试） |
| A7 | **`referencedEntities()` fail-open**：`default: return []` → 新增带 EntityId 的服务器消息忘登记时，`redactFor` 原样放行。与 codec 侧 `satisfies never` 的穷尽保证是同一问题的相反做法；零测试 | `packages/server/src/MatchLoop.ts` 穷尽 switch（`satisfies never`，新消息不归类编译不过）+ `MatchLoop.test.ts` 逐类断言 | 防线本身没有防线 | ✅ 批次一 1.5（2026-08-04，编译期变异验证过） |
| A8 | **阶段白名单漏两条 + 房间函数漏守卫**：`MATCH_ONLY` 不含 `OpenArmory`/`ChooseArsenal`（当前被下游 `!sr?.loop` 兜住）；`setReady()` 是唯一没有 `room.started` 守卫的房间变更函数 | `Session.ts` MATCH_ONLY 补两条；`room.ts` `setReady()` 加 started 守卫 | 纵深防御各少一层 | ✅ 批次一 1.6（2026-08-04，断言钉住「阶段」层拒绝理由，双变异验证） |
| A9 | **`Death` 事件对「杀手不可见」的接收者整条丢弃** → 全队收不到死亡反馈，只能靠快照 `alive:false` 推断。偏差 #4 家族残留：`Damage` 已改「发但抹 sourceId」，`Death` 没跟 | `packages/server/src/MatchLoop.ts` `redactFor` default 分支 | 命中/死亡反馈缺失（14.1 同源） | ⛔ |
| A10 | **近战 `inRange` 把碰撞体重叠判为超距**（原 PROGRESS 技术债 §8 迁入）：负边距 + `min=0` 检查 → 站进模型里拳击永远 OutOfRange。修时先补「重叠时可施放」单测 | `packages/shared/src/math/geometry.ts` `edgeDistance` 注释 + `inRange()` | 需主动贴脸才触发，低频 | ⛔ |
| A11 | **死亡后客户端照常发输入、技能栏可点**（服务器静默拒绝）：`simulate` 只判 `started` 不判 `alive` | `packages/client/src/scenes/NetworkScene.ts` `simulate()`（≈:1139） | 无害但脏流量 + 死亡体验混乱（与 W5 联动） | ⛔ |
| A12 | **`antialias` 是死设置且有假绿测试**：档位表声明、`QualityController.apply()` 不消费、两个场景渲染器硬编码 `true`，而 `quality.test.ts` 断言这个无效字段 —— 「测试通过 ≠ 功能存在」的实例 | 字段与断言已删（quality.ts 留注释说明；真按档切 MSAA 随 P9 重建 renderer 时再加回并真消费） | 低端机 low 档拿不到承诺的收益；绿灯说谎 | ✅ 批次一 1.7（2026-08-04） |
| A13 | **切画质丢昼夜 preset**：两处 `env.apply(tier)` 不带 preset 参数，回落 day | `Environment.apply` 记住 `lastOpts`，不带 opts 沿用上次（两处调用点零改动） | 一行级；W15 做完后会显形 | ✅ 批次一 1.7（2026-08-04） |
| A14 | **`SWING_CLIPS` 含不存在的片段名** `Unarmed_Melee_Attack_Punch_A`（任何模型里都没有）；[1] 之后的条目全是死分支 | 死条目已删；按武器类型选片段归 W14 | 死数据误导后人 | ✅ 批次一 1.7（2026-08-04） |
| A15 | **粒子池容量注释过期互相矛盾**：注释写 32 格/40 格，实际事件池 40×48、细流池 48×32 | `ParticleBurst.ts` 活注释改正并指向构造参数为准；PROGRESS 二期章节的 32 格是**当时真实值**，按「历史数字不回填」规矩保留 | 文档说谎 | ✅ 批次一 1.7（2026-08-04） |
| A16 | **施法失败提示优先级**（原 PROGRESS 技术债 §3）：资源检查排在距离前 → 怒气 0 的战士在 30 米外收到「资源不足」。正解是**另加** `describeCastBlockers()` 全量提示，不改门禁顺序 —— 该函数 M11 写完后**零生产消费方**晾了五个里程碑 | `HudSkillSlot.blockers[]`：试验场由 `CombatDirector.skillSlots()` 调 `describeCastBlockers` 填全量，HUD 按「位置→视线→朝向→资源→冷却→状态」取首个 + 四类分级样式（颜色+边框字形双通道）；联网侧补距离/朝向判定（视线/学派锁定要服务器数据，如实注释） | 提示质量（15.2） | ✅ P10（2026-08-07，hud 单测钉六级顺序） |
| A17 | **夺旗时限/加时整条未实现**（W12 探路发现）：`CTF.DURATION`（12/15 分钟）与 `setOvertime()`（加时波次 16s）**零消费方**；规格 6.x「时间到比分高者胜、同分突然死亡加时」没有任何一层在跑 → 双方都不碰旗的联网夺旗**没有自然终点**（得分胜负已通，见 W12）。联网 HUD 因此如实不显示「剩余时间」（15.4 右列的比赛时间一栏空缺 —— 不画到零也不会发生任何事的倒计时，附录A#7）；试验场的 720s 是本地演示钟 | `packages/shared/src/constants/combat.ts` `CTF.DURATION`；`sim/match/respawn.ts` `setOvertime`；胜负出口在 `flag.ts`（照 arena.outcome 的结构补，MatchLoop 只消费） | 拖延战术无终点；15.4 比赛时间缺席 | ⛔ |

## S. 安全与公网部署

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| S1 | **无任何消息速率限制**：`inputQueue` 在 tick 间无上限；`pendingCommands` 无界且逐条执行（1000 条 TabTarget = 一 tick 内 1000 次全实体排序）。单客户端可拖慢同机全部房间 | 入站令牌桶（`Session.handleRaw` 解析**前**判、静默丢弃、持续滥用 terminate）+ 每玩家每 tick 命令数上限（`MatchLoop.enqueue`）。参数集中在 `limits.ts`，人机会话跳过 | **不需要游戏知识即可打穿**的路径 | ✅ 批次三 3.6（2026-08-05，Session.rate 单测 8 + verify:hardening 压测「灌 4000 条/s 他房仍 100% 20Hz」） |
| S2 | **无 `maxPayload`（ws 默认 100MiB）/ 无出站背压（不看 `bufferedAmount`）/ `roomId` 无长度上限**（会被当 Map 键长期持有） | `maxPayload` 16KB（ws 以 1009 关）+ **背压巡检**（`backpressureStrike` 纯函数：连续两个巡检间隔都超阈值才断 —— 瞬时冲高不误杀，白盒同步快进那一幕正是被它救的）+ codec `roomId ≤ 32` | 内存放大 / 慢读者拖爆出站缓冲 | ✅ 批次三 3.6（2026-08-05，背压判定 4 单测 + hardening maxPayload e2e） |
| S3 | **无 origin 校验、无连接/房间/房内人数上限**（观战席无限，每人每 tick 一份完整快照） | Origin 白名单（`verifyClient` 握手层拒绝，env `WOWPVP_ORIGINS`）+ 连接数（1013）/房间数（拒新建）/房内成员数（拒加入）三档上限 | 跨站连接 + 资源放大 | ✅ 批次三 3.6（2026-08-05，hardening e2e 5 条） |
| S4 | **无 TLS/WSS**：客户端硬编码 `ws://`；重连令牌明文过网且**整局 24h 有效** → 同网段嗅探一次即可在受害者断线时接管。令牌本身是 UUIDv4（够强），弱点全在传输层 | `packages/client/src/main.ts`（≈:139）；`room/RoomServer.ts` `TAKEOVER_GRACE_SECONDS`（≈:112） | 会话劫持面；HTTPS 页面下混合内容直接连不上 | ⛔ **归发布前 F3**（要配反向代理，与部署形态绑定） |
| S5 | **tick 循环无异常防护**：`setInterval(pump)` 无 try/catch、无 `uncaughtException`/SIGTERM 处理，而 `assertNoHiddenEntities` 设计上会抛 → 一个 bug = 全服进程崩、带走所有房间 | `MatchLoop.pump` try/catch（**爆炸半径 = 单房间**：出错房间判平局收场，其余照跑）+ 主入口 `uncaughtException`/`unhandledRejection`/SIGTERM/SIGINT（**只在直接运行时装**，import 时不装以免吞测试失败） | 单点全崩 | ✅ 批次三 3.6（2026-08-05，containment 4 单测：advance 抛 → onEnd(draw)、不二次抛、日志可见、onEnd 自身也抛的兜底） |
| S6 | **无监控/结构化日志/健康检查**：全部日志 6 行 console；追帧丢弃（超 5 tick 丢）是静默的，过载不可见 | JSON 行日志 `log.ts`（`onLog` 测试钩子）+ `/healthz`（聚合读数、**不带房间码**）+ tick 耗时/慢 tick/丢帧计数（`MatchLoop.stats`，过载告警 5s 节流）+ 半开/限流/背压/异常关闭全部留痕 | 运维盲区 | ✅ 批次三 3.6（2026-08-05，/healthz e2e + 各防线日志被压测断言） |
| S7 | **光环 id 全量下发泄露隐身攻击者的职业**：`Damage.sourceId` 抹了，但目标身上的 `auraId`（形如 `rogue.rupture`）与 `AuraApplied` 广播直接说出攻击者职业。「抹来源」防线的语义漏点，需拍板口径（与 X3 的 skillId 同题） | **口径：施加者不可见 → auraId 掩成 `HIDDEN_AURA_ID`（"hidden"）、连学派一起藏。** 两条通道都改：`snapshotEntity`（持续快照，按 aura sourceId 判可见性）+ `AuraApplied`（加可空 sourceId，`redactFor` 同款掩码，`referencedEntities` 兜底登记 fail-closed）。客户端所有按 auraId 分派（护盾/控制/化形/复活保护）都不匹配 "hidden"，自然回落中性显示 | 不违反任何验收，但未记录过 | ✅ 批次四（2026-08-05，visibility 掩码单测 ×3 + m10 #1e 字节级） |
| S8 | **`PeerDisconnected`/`PeerEliminated` 全房广播** → 敌方准确知道哪个对手正由 AI 操作（战术信息）。需设计拍板：是否只发给己方 | `room/RoomServer.ts`（≈:176-180、:509） | 与偏差 #14 耦合 | ⛔ |
| S9 | **文档债**：无延迟补偿（判定用服务器当前 tick，高延迟纯吃亏）是合理取舍但 docs/08 **没写**；「20Hz 够用」的论证只覆盖控制时长分辨率，没覆盖输入 50ms 量化对打断窗口的影响 | `docs/08-network-protocol.md` §5 | 取舍未记档 = 将来被当 bug 反复排查 | ⛔ |

## W. 接线缺口（组件写完了、没人喂 ——「写对了没人调」家族存量）

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| W1 | **联网无队伍框**：`PartyFrame` 已构造、试验场在喂，`NetworkScene` 零调用 → 队友血量看不见，**治疗职业没法玩** | 投影收进 `PartyFrame.ts`（`partyViewOf`/`partyViewFromSnapshot` 共用一份 `partyMemberView`；控制优先级 `controlKindsOf` 顺带把目标框副本收拢）；`NetworkScene.renderParty()` 喂快照 | 极高感知 | ✅ 批次二 2.1（2026-08-04，双源一致性单测 + m13 #11 变异验证） |
| W2 | **联网无小地图**：`Minimap` 零调用；`'supply'`/`'objective'` blip 类型无生产者（M16 已记的军械点图标属此） | `NetworkScene.renderMinimap()` 喂快照（潜行免费继承验收 #5）+ **`suddenDeathBlips` 首个消费方**（8.5 模糊位置，距离启发式压一人两点噪音）。余账：旗帜 blip 已随 W12 清（批次三 3.5）；`supply`/`objective` blip 随军械图标 | 战场态势不可知 | ✅ 批次二 2.3（2026-08-05，m13 #13 像素级变异验证） |
| W3 | **联网无模式 HUD**：`ModeHud.renderCtf` 全仓唯一调用点在试验场；`respawnIn`/`supplyRespawnIn`（12.6 复活波次倒计时）**从未被任何一边喂过** | 竞技场侧批次二 2.2；夺旗侧（renderCtf + respawnIn，快照新字段驱动）批次三 3.5。**余账**：`supplyRespawnIn`（10.4 补给刷新倒计时，数据其实已在快照 `armories.availableAt`，差 renderArena 喂一口） | 比分/旗帜/复活已可见；补给倒计时仍欠 | 🔧 夺旗侧清（批次三 3.5，2026-08-05）；余 supplyRespawnIn |
| W4 | **`ModeHud.renderArena()` 两个场景都零调用** → 8.5 战斗抑制百分比与「决胜阶段」**从未显示给任何玩家** | `NetworkScene.renderModeHud()` 喂快照 `match.dampening/suddenDeath`（M10 起就在每份快照里）；存活数按可见口径（与记分板同规矩，如实不编全知计数）。⚠️ `suddenDeathBlips` 的消费**挪到 W2**（小地图才是它的归宿） | 核心节奏机制不可见 | ✅ 批次二 2.2（2026-08-05，m13 #12 变异验证 + 15.4 否定式断言） |
| W5 | **死亡后无去向 + 观战未接镜头**：无「你已阵亡」遮罩、无复活倒计时；`SpectateController` 规则/测试齐全但 V 键只 `console.info`，镜头从未切换（其 `:90` 注释指向一个不存在的死亡界面）。观战席玩家开局停在房间页（M13 边界）也归此 | 联网侧：死亡遮罩（textContent 防注入）+ V 键轮换（`nextSpectateTarget` 纯函数，服务器 `spectatableFor` 复核）+ 镜头改指被跟随者（`lastRemotePos` 插值同源）+ 被跟随者死亡自动换人。**余账**：观战镜头切换的 E2E 断言待 3 人局景（可用 fillWithBots）；CTF 复活倒计时已随 W12 清（批次三 3.5，verify:w12 #5）；试验场 V 键与观战席开局去向未动 | 「死后 20 秒」是最易流失时刻 | ✅ 联网侧清（批次二 2.4，2026-08-05，m13 #14 rAF 监视器变异验证） |
| W6 | **断线全程静默**：`NetworkScene` 自建连接的 `onClose` 是空实现；大厅只在放弃重试后 toast 一次；约 7.75s 退避重连零提示；全客户端无延迟/连接状态指示 | 断线横幅（纯轮询 `NetLink.connected`，两条入网路径同一份逻辑）+ 延迟指示（Input seq→快照 ackSeq 往返，EMA，含 50ms tick 批处理如实不减）。**顺带修掉 E2E 抓到的真 bug**：重连后服务器不告知恢复的 playerId → 大厅身份错位、赛后重开对重连过的人整个是坏的（重发 Welcome，零新协议） | 网络问题被误判成游戏 bug | ✅ 批次二 2.5（2026-08-05，m13 #15 服务器侧掐线闭环验证） |
| W7 | **键位事实上不可重绑**：`rebind()`/`getBindings()` 全仓零调用方、无持久化；技能栏 `<kbd>` 写死 1-8（接了重绑也会撒谎）。17.2 明文要求可重绑 | `settings/keybindings.ts`（存档 `wowpvp.keybindings.v1` + `rebindWithSwap` 冲突交换/拒绝 + `makeRebindController` 两场景共用）；`SceneShell` 开局 `loadBindings` 进 InputManager；`SettingsPanel` 键位表点行进捕获态、按键即改（含技能九格）；`CombatHud.skillKeyLabel` 读实时绑定不再写死 | 无障碍 + 非 QWERTY 玩家被挡 | ✅ 批次三 3.9（2026-08-05，keybindings 单测 ×14 + m13 #20/#21/#22：重绑往返/冲突检测/技能栏键号同步） |
| W8 | **三个已定义动作不可达**：`Trinket`（R 通用解控，8.3 —— **PVP 核心反制**，且 sim 侧 `UseTrinket` 结算也未接，M10 已知不足迁入）、`SelfCast`（Alt，5.6）、`Skill9`（两处 `SKILL_SLOT_COUNT=8` 截断第 9 格护盾） | R：tick 第 1c 步（`useTrinket` M9 零调用至今首条真实调用链；按下即进冷却保博弈；昏迷中可用）+ 协议路由 + 双场景 R 键与冷却预检 + `AuraRemoved` reason 加 'trinket'。Alt：`FrameInput.selfCastHeld`，双场景只对 Ally/Any 技能改写目标。**Skill9 系误报**：试验场四期已是 9 格，联网 8 格是快照技能栏设计口径 —— 登记时未核实，如实更正 | 被控只能干看着 | ✅ 批次二 2.7（2026-08-05，tick 四断言 + m13 #17 昏迷中解控 + 变异验证；Alt 的 E2E 待奶职业局景） |
| W9 | **无设置面板**：音量四通道（`setVolumes()` 零调用）、画质（F2 盲切、反馈在 console）、9 项无障碍（F3/F4 仅试验场响应，6 项在联网完全无法触达）——**数据层与持久化全部就绪，只差一个面板** | `settings/SettingsPanel.ts`（F10/大厅按钮；音量四通道 `setVolumes` 首个调用方、画质走 F2 同链、九项无障碍走各场景 `setAccessibility` 唯一入口、键位只读表 `getBindings()` 首个消费方）。面板不持状态。**余账**：键位重绑 UI 归 W7 | 投入产出比最高的单项 | ✅ 批次二 2.6（2026-08-05，m13 #16 落盘往返 + 变异验证） |
| W10 | **大厅路径的对局不装配键位帮助/状态面板**：`#help`/`#stats` 只在无参路径挂；`?net=` 老路帮助文案停在「M1 试验场」且 `#stats` 无人绘制 | 场景自带 `#net-hint` 一行提示（指向 F10 完整键位表，W9 是骨干）+ 延迟标签补帧率显示；`?net=` 撤掉误导的试验场帮助与空 #stats —— 两条入网路径同一份体验 | 新手主路径恰好是唯一没提示的 | ✅ 批次二 2.8（2026-08-05，m13 #18）；P10 起 `#net-hint` 迁至两场景共用的 SceneShell `#hint-bar`（m13 #18 断言随迁） |
| W11 | **教学↔联网断链**：毕业文案「去大厅找真人过招」但无回大厅按钮；大厅从不读 `wowpvp.tutorial.v1` | 毕业页「去大厅」按钮；大厅标题页按存档（done 含 graduate）区分「推荐先玩·尚未完成 / 已完成✓可重温」；存储键挪 steps.ts（轻模块）防大厅 chunk 拖重 | 转化漏斗断口 | ✅ 批次二 2.12（2026-08-05，m15 23/23 回归） |
| W12 | **夺旗联网线未通**：大厅无模式选择（预设仅经典/武装竞技场）→ 联网夺旗**无入口**；即便进入，`NetworkScene` 无 `FlagMarkers` import、无旗手 blip、无 CTF 面板 —— M7 整套规则 + M9 35 条验收只活在 sim 与试验场演示里 | 协议 `SetRoomMode` + sim `setMode()`（换图/换档/超编拒绝）+ 大厅模式行 + `NetworkScene` 接 FlagMarkers/renderCtf/旗帜 blip/死亡遮罩倒计时/FlagEvent 日志 + 快照补 `scoreToWin/focusStacks/respawnIn`。消费侧前夜抓出三真 bug（ctfWinner 零调用、enqueueRespawn 零调用、复活不写 movement）+ 墓地 yaw 反向，详见 PROGRESS 3.5 章 | 一整个游戏模式联网不可玩 | ✅ 批次三 3.5（2026-08-05，`verify:w12` 11/11 + 13 条新单测；时限/加时缺口另立 A17） |
| W13 | **音频接线欠账**：BGM 战斗切换未做（`lastCombatAt` 数据在、audio 层零引用；19 首曲子只播 `combat_1`）；10 个 `amb_*` 环境音零使用；脚步只有 `foot_stone` 单材质；联网无脚步/跳跃/落地/驱散/位移音 | **BGM 半已清**（批次二 2.9）：`MusicDirector`（试验场读 sim 权威 `lastCombatAt`、联网按可见 Damage/Heal，脱战 8 秒滞后）+ 每图氛围曲表 + `playMusic` 交叉淡化。**余账**：`amb_*` 环境音（需 AudioManager 加环境循环通道）、脚步材质、联网脚步/跳落/驱散/位移音 | 氛围与反馈缺层（速赢清单项已销） | 🔧 BGM 清（2026-08-05，+4 单测）；余账在册 |
| W14 | **8 个动画片段零调用**（`Spellcast_Raise`/`Spellcast_Shoot`/`2H_Ranged_Shoot`/`Block`/`Dualwield_Melee_Attack_Chop`/`Lie_Idle`/`Sit×2`）；**跑动中施法无上半身表现**（`applyClip` 单片段全身淡化，只有 Idle 才播施法姿态，无骨骼分层/additive） | **上半身叠加分层已交付**（`entity/animLayer.ts`：脊柱子树遮罩 + `makeClipAdditive`；`CharacterView.buildCastLayer`/`setCasting` 叠加权重淡入淡出，腿照跑手施法；骨架无脊柱时安全回落旧行为）。核心算法 6 单测（用**真骨架名** hips/spine/chest/upperarm.r/upperleg.l，从 GLB 逐一核对）；art=on 无运行时错误（m12 #12d）。**真机观感截图待确认**（additive 参考帧若不自然，可换 Idle[0]）。**余账**：8 个零调用片段里除 `Spellcasting` 外仍未接（需要施法分阶段/格挡/远程等触发信号）| 每分钟都发生的表现缺失；工作量大 | 🔧 批次三 3.8（2026-08-05，分层机制清；standalone 片段待接） |
| W15 | **昼夜 preset 全闲置**：5 个 HDR preset 只用 `day`，`MapDef` 无 preset 字段（速赢清单「每张图配一个」连数据入口都没开）；`EnvironmentOptions.sky` 从未被传 false | `MapDef.envPreset`（纯表现字段）+ 每图配档（试验场 day 红线不动 / 教学 dawn / 竞技场 dusk·day·overcast / 夺旗 dawn）+ `presetOf` 校验回落 + 双端消费；防拼错测试钉住每图的值。`sky:false` 仍无消费者（无室内图，如实留） | 四张图长得一样 | ✅ 批次二 2.10（2026-08-05，速赢清单销账） |
| W16 | **复活保护无渲染器**：`spawnProtection` 是 14.4 essential 八项里唯一「保证不被隐藏、但从来没被画过」的角色 | `StatusMarkers` 金色地环+柔光柱（纯程序化，`?art=off` 同构造）；双端按光环 id `system.spawnProtection` 检测（快照 auras 全公开，与化形同通道）。organically 要等 W12 的夺旗复活波次，白盒断言先钉住 | 保护期不可见 → 玩家误判 | ✅ 批次二 2.11（2026-08-05，单测 ×2 + m13 #19 白盒变异验证） |
| W17 | **协议缺 `Damage.avoided`**：联网侧闪避/招架/格挡无区分 → 规避三态特效与音全缺（M12 已知不足迁入，「如实地少一层」） | `Damage` 加 `avoided?`（sim 早有，只差下发）；`pushEvent` 转发；`NetworkScene` 传给 `HitFeedback.onHit`（闪避/招架/格挡浮字 + 音，其消费早有单测）。规避是被攻击者信息，无泄露争议 | 一笔协议债，照 M10 规矩还 | ✅ 批次四（2026-08-05，codec 往返 + HitFeedback avoided 单测） |
| W18 | **待复核**：他人姓名板施法条在联网侧是否有数据源（M10 已知不足记「快照无他人施法状态」；特效二期接了 `CastStarted` 事件流后 HUD 侧是否跟上未核实） | **复核结论：数据源已在，销账。** `CastStarted` → `SnapshotCombatView.beginCast()` 注册表 → `castOf(e)`，被 `renderUnitFrame`（目标/焦点框）**与** `renderNameplates`（`.np-cast`）双双消费。M10 缺口早由特效二期事件流补上 | 复核后要么销账要么转正 | ✅ 批次四复核销账（2026-08-05，m13 #23：B 通过事件流看到 A 施法） |
| W19 | **鼠标指向（mouseover）施法整条链路是死的**（P10 审计）：`targets.mouseover` 全仓声明三处、**零赋值**；`allowMouseover` 生产代码零调用 —— 5.6 写明的「治疗/驱散/保护支持鼠标指向施法」在游戏里不存在，悬停只换光标图案 | `sim/entity.ts:93` 声明；`targeting.ts:275` 读；两场景 mousemove 均不写。修法：hover 命中写 `targets.mouseover` + 治疗/驱散/保护类技能标 `allowMouseover` | 治疗手感（队伍框可点后优先级降低） | ⛔ |
| W20 | **联网硬目标不从快照回读**：服务器拒绝 `SetTarget`（不可选/超距）后本地仍显示选中态 —— P10 给超距补了 `Rejected` 回话，但目标框的乐观显示没有回滚。focusId 已走「快照回读」口径（P10），hardTargetId 没跟 | `net/SnapshotCombatView.ts`；修法与 `EntitySnapshot.focusId` 同手法加 `hardTargetId` | 拒绝后 UI 与服务器不一致（低频：姓名板 45m 剔除后常规路径撞不到） | ⛔ |

## X. 表现与内容打磨

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| X1 | **夺旗图 0 件装饰** —— 唯一没有 `decor` 字段的图（速赢清单「下一铲」） | `makeCtfDecor()`：30 件，地图常量的确定性函数、红蓝中心对称；否定式约束测试钉住「不挡中路/地道口/旗房/墓地」 | 灰盒观感 | ✅ 批次二 2.10（2026-08-05，速赢清单销账） |
| X2 | 教学图装饰仅 6 件「够用不够看」；走位环无专用地形 | `maps/tutorial.ts`；`PROGRESS.md` 教学分家章节 | 第一印象 | ⛔ |
| X3 | **死亡回顾无技能名**：协议 `Damage` 只带 school，需加 `skillId`（与 S7 的泄露口径一起拍板） | `Damage` 加 `skillId?`（`CombatEvent` damage 加 `skillId`，`dealDamage` 三处带 `ctx.skillId`）；死亡回顾用 `getSkill(skillId).name`（`autoAttack`→「普通攻击」，查不到退学派）。**泄露口径**：来源不可见时 `redactFor` 连 skillId 一起抹 | 协议债 | ✅ 批次四（2026-08-05，m13 #24 回顾显示技能名 + m10 #1e 抹除断言） |
| X4 | 结算面板无夺旗专属列（携旗距离/护送时长 sim 里都有）；连杀播报无「终结连杀」提示（数据够 UI 没做） | 夺旗列已清：`MatchStatsRow` 补夺旗/归还/截旗三列，面板按模式开关（15.4 否定式反向断言）。**余账**：携旗距离/护送时长等深度列、「终结连杀」提示 | 夺旗列 ✅；终结连杀仍欠 | 🔧 上半批次三 3.5（2026-08-05） |
| X5 | 装备满槽无「选哪件换掉」对比 UI（10.5 后半，M16 已知不足） | `hud/ArsenalHud.ts` | 武装竞技场体验 | ⛔ |
| X6 | 引导条 HUD 仍是读条口径（4 秒满格）——3D 法阵已按引导独立时间轴走，HUD 没跟 | 引导条按剩余时间**向左缩**（WoW 口径）+「引导」标记，玩家/目标/姓名板三处同源；普通读条逐字节不变。⚠️ 实现靠 index.html 的 `@keyframes cast-fill` 保形（测试只锁名字，锁不住内容 —— 改那条关键帧前先看 CombatHud 引导段注释） | 引导技能读条骗人 | ✅ P3（2026-08-07，hud 单测钉方向） |
| X7 | 盾自然过期无收束动作（过期不是破裂，是对的；但壳直接消失没有淡出） | 自然过期 0.3s 收束淡出（破裂仍是破裂动作，语义分开） | 小 | ✅ P3（2026-08-07） |
| X8 | 音效无技能级分化：91 技能共用 7 组学派音；盘里 `cast_chain_heal`/`cast_lightning_bolt` 等专用音零使用 | P3 签名系统：`av/skillSignature.ts` 双层（推导散列 + 八职业手写表 100% 覆盖），playCastFor/playImpactFor 换文件/变速/叠层；磁盘断链逐键测试 + 全局唯一性零例外门禁 + main.ts 入口源码锁。⚠️ 数值全是占位判断，听感校准归 **X23** | 大招没有专属声音签名 | ✅ P3（2026-08-07，11 agent） |
| X9 | 粒子次级动作（同爆发内各层错开 40-80ms）未做；池饱和度断言未补（三期已知不足） | `vfx/ParticleBurst.ts`；`SpellVfx.ts`（≈:464）注释 | 观感上限 | ⛔ |
| X10 | **真 GPU 上从未验证观感与帧率**：全部验收跑在 swiftshader 软渲染（空闲 4 FPS）下，「够不够炫」「掉不掉帧」都没有真机数据 | **压测台已就绪**（P2）：`?stress[=n]` 24 实体同屏 + 帧时间分布面板（平均/p95/最差 + drawcall/三角面/画质档），`verify:stress` 6/6 自检。**余下的是人跑一轮** —— 步骤见 docs/17 末「P2 真机压测：怎么跑」 | 12v12 帧率是未知数 | 🔧 台子✅（P2，2026-08-05）／真机数据仍缺 |
| X11 | 多语言未做（HUD/大厅/教学全中文硬编码，无 i18n 层） | M13/M15 已知不足 | 发布范围决定 | ⛔ |
| X12 | 武器无背后收纳（`ui_weapon_sheathe` 音效已备好） | M12 已知不足 | 小 | ⛔ |
| X13 | **法师没有任何群体减速/脱身手段**（用户实测：「被一堆近战追着打很快就嘎了」）：只有霜矢的单体减速 + 5 米霜爆新星（18s）+ 瞬闪（15s）。WoW 的冰锥术（锥形群体减速）在规格 9.x 的法师技能表里**本来就没有** —— 是**设计缺口不是 bug**，加不加需要拍板（同类问题可能也存在于其他远程职业） | `data/classes/mage.ts` 技能表；docs/00 §9.x | 远程职业面对多近战时无解 | ⛔ **待拍板** |
| X14 | **阵营区分只做了姓名板**（P3a）：规格 00 §777 要求「姓名板、**脚下标记**、**轮廓**和 UI」四个通道，本轮补了姓名板（阵营色 + ▲/◆ 字形）。P10 补了 **UI 通道**（目标框敌我：语义色 + ▲/◆ + 「友方/敌方」标签 + 血条随阵营变色）。**余账**：全体脚下阵营标记（现在只有当前目标有 TargetRing）、角色轮廓 | `hud/CombatHud.ts` `renderNameplates`/`renderUnitFrame`（已做）；`vfx/TargetRing.ts`（只服务当前目标） | 12v12 可读性 | 🔧 姓名板✅（P3a）+ 目标框✅（P10）／脚下标记与轮廓⛔ |
| X15 | **无指针锁定**：右键拖转身被窗口宽度封顶（1366px 窗实测拖 1200px 只转出 149°，光标顶到屏幕边缘 movementX 归零），贴身缠斗转半圈就得松手重来。全仓零 `requestPointerLock` | P10 审计（真机量化）。⚠️ **刻意没在 P10 修**：verify 脚本靠合成鼠标事件驱动镜头，指针锁定改吃 movementX 后合成事件口径要整体重定 —— 动 verify 基建的事单独一批做，不混进 60 文件的 UX 批 | 镜头手感的地基缺口 | ⛔ |
| X16 | **镜头/输入参数全部写死且不可设置**：鼠标灵敏度（0.0045）、转身速率（3.2）、FOV（60）、Y 轴反转、自动跟随全无 setter，设置面板零暴露；「全部按键可重绑」（17.2）也没做到 —— 移动六键/Home/K/F1/F3/F4 都不在可重绑表里（左手党/AZERTY 最需要的恰是移动键） | `CameraController.ts` CAMERA 常量；`InputManager.ts:122`；`SettingsPanel.ts` ACTION_LABELS | 无障碍与手感个性化 | ⛔ |
| X17 | **目标框/自身框无光环行**：DoT 剩几秒、有没有吸收盾、我的减益掉没掉 —— 全靠战斗日志一条通道（P10 已把日志改成显示名，但这仍是日志不是面板）。`HudUnit` 没有 auras 投影，`controlBadges` 只出 5 个控制旗标 | `hud/CombatView.ts` HudUnit；试验场数据源 `aurasOf`、联网 `AuraSnapshot` 都是现成的，缺的是投影 + 一行图标 UI | 目标制 PVP 的核心信息盲区 | ⛔ |
| X18 | **姓名板三件小账**：互相重叠无避让（12v12 实测 3 对重叠、血条压别人名字上）；底部锚定导致读条出现/消失时整板上跳 6px（点击热区在光标下移动）；4px 血条无数字/低血变色（「谁进斩杀线」看不出） | P10 审计（`CombatHud.renderNameplates`；index.html `.np-hp`） | 混战可读性 | ⛔ |
| X19 | **走进另一个角色被彻底顶住**，与代码自称的「软推开…可以穿过」相反：`SEPARATION_STRENGTH: 8` > `MOVE.BASE_SPEED: 7`，高重叠时分离推力恒压过自走速度（实测按 W 三秒只前进 2.9m 后卡死）。⚠️ **平衡敏感刻意未动**：分离度改动会波及所有近战 bot 缠斗，必须走「单独一步 + balance 归因 + 恶化回滚」的流程，不混 UX 批 | `sim/movement.ts:36`；修法候选：降到 3–4，或去掉玩家 wish 方向分量只留侧滑 | 近战贴身手感 | ⛔ **需单独归因批** |
| X20 | **新手教学固定法师**：教学分支不吃 `?class=`，选了战士进教学还是法师（P10 已在按钮文案标注） | `main.ts` 教学分支 | 教学与所选职业脱节 | ⛔ |
| X21 | **排队窗过期无反馈**：0.4s 排队窗（P10）过期后按键仍是静默消失 —— 迟到 0.4 秒的失败提示可能比沉默更误导，**要不要提示、提示什么需拍板**，不是漏做 | `sim/casting.ts` 排队消费处注释 | 「按了没反应」残留的最后一角 | ⛔ **待拍板** |
| X22 | **命中爆发的视觉签名未穿线**：P3 的 tint/scale/form 生效在释放爆发/弹道/落地三处，**命中**爆发退回纯学派色 —— `SpellVfxEvent.damage` 不带 skillId（协议 Damage 与 sim damage 事件里都有，X3 起），穿线即可；⚠️ 来源不可见时协议抹 skillId，回落学派是正确行为（音频侧同口径已实现，照抄 HitFeedback 的写法） | `vfx/SpellVfx.ts` damage 分支；喂数据两场景各一处 | 命中一瞬的技能识别度 | ⛔ |
| X23 | **P3 签名的听感校准轮从未有人耳听过**：全部 castRate/impactRate/音色选择都是按文件名语义推的占位判断（各表已逐条标注）。最高风险三类：mob_* 吼叫的原始时长（死骑凛冬领域/凛冬号叫/缚魂拽三条 bark 压速后可能拖尾）、ui_* 取材的出戏风险（猎人 ui_weapon_unsheathe 绞盘、德鲁伊 ui_sheep 风笼、盗贼 ui_craft_* 两条）、foley 音量基准（德鲁伊 move_land 形态落地可能被战斗混音压没）。与 X10 真机轮合并跑最省 —— 一边看帧率一边听签名 | 八张 `av/signatures/*.ts` 的 ⚠️ 注释就是校准清单 | 签名批的真正验收 | ⛔ **需真机 + 人耳** |
| X24 | **联网 CastResolved 不响施法音**：试验场 resolved 时响一声签名施法音、联网只播近战 swing —— 两场景不对称（P3 之前就存在，P3 只穿线没改行为）。补的话在 NetworkScene CastResolved 分支用 playCastFor | `scenes/NetworkScene.ts` CastResolved | 联网瞬发技能比试验场「哑」 | ⛔ |

## P. 性能

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| P1 | **`listEntities()` 每次 spread 新数组且被放进嵌套循环**：tick 软推开对每个移动实体再 spread 全体（O(n²) + 24 人 48 数组/tick）；groundArea 三层嵌套；projectile 每子步 3 次数组分配。`tick.ts` 内层调用是**循环不变量，提出去一行即消** | 三处循环内调用已 hoist（各步顶层的现取**保留** —— 第 3–5 步的效果可能生成实体） | 20Hz × 所有房间的基础成本 | ✅ 批次一 1.8（2026-08-04，balance 逐位不变） |
| P2 | **人机会话拿完整快照 + 裁剪 + `JSON.stringify` 后在 socket 层丢弃** → 满人机房开销 = 满人房。`BotDriver` 注释自认欠账但低估了成本（stringify 也跑了） | `BotSocket.isBot` 标记 + `broadcastSnapshots` 跳过（跳的是浪费不是裁剪语义，M16b 红线原样） | 补位与接管都走这条路 | ✅ 批次一 1.8（2026-08-04，m16 29/29） |
| P3 | **快照中与视角无关的部分逐接收者重建**：projectiles/grounds/flags/score/armories/suddenDeathBlips 每人重算；每实体 `Object.fromEntries(resources)`×2 → 24 人 ≈ 2.3 万对象/秒 | `shared/src/net/visibility.ts`（≈:489-547、:566-573） | GC 压力主源 | ⛔ |
| P4 | `assertNoHiddenEntities` 在生产环境把 O(sessions×entities) 可见性再跑一遍（成本 ×2）。🔵 「宁可掉线不能透视」的决定**保留**，但成本应可度量，可改采样/轮转校验 | `MatchLoop.ts`（≈:697-700） | 有意但未度量 | 🔵/⛔ |
| P5 | **广播对同一消息 stringify N 次**（RoomState/MatchEnd/统计等全量广播）。修法零风险：stringify 一次 + `sendRaw(string)` | `Session.sendRaw()` + `broadcast()`/`broadcastStats()` 共享编码 | 白算 | ✅ 批次一 1.8（2026-08-04） |
| P6 | **全员掉线的对局照跑 20Hz 到终局**：started 分支不调 `dropIfEmpty`，且人机会话占着 `sessions` 让判空恒 false → 无人房间跑完整局（夺旗半小时量级），叠加 P2 | `disconnect()` 判**零真人 session**（`humanSessionCount`，人机 `isBot` 不算）→ `scheduleAbandon` 排 30s 宽限计时器 → 窗口过完仍零人则 `abandonMatch`（停循环+遣散人机+回收房间）。★ 宽限而非立刻拆：集体闪断（verify:m13 §4b 一次掐断双方）要留重连的路，`onReconnect` 里 `cancelAbandon` 撤销 | 可被外部触发的资源占用 | ✅ 批次三 3.7（2026-08-05，RoomServer 单测 ×3：回收/单人不误杀/宽限内重连救回；m13 19/19 不掉） |
| P7 | 重连令牌查找 O(rooms) 线性扫（`[...rooms.values()].find(...)`），应建 token→room 索引 | `room/RoomServer.ts`（≈:580） | 小 | ⛔ |
| P8 | 无 instancing（全仓 0 处 `InstancedMesh`）；模型材质逐 mesh `.clone()`（为受击闪白）破坏合批 —— 可改顶点色/uniform | `entity/ModelLibrary.ts`（≈:143-145）；`arsenal/ArsenalView.ts` 等 | draw call 随掉落物线性涨 | ⛔ |
| P9 | **无自动画质降档**：两场景默认 High（2048 阴影 + 2x 像素比），FPS 已量但无反馈回路，低端机只能自己按 F2 | `render/QualityController.ts`；`GameLoop.ts` fps | 低端机第一印象 | ⛔ |
| P10 | 每帧小额浪费：`NetworkScene` 多处线性 `find/some`（有 Map 不用）；记分板可见时每帧重建对象数组 | `NetworkScene.ts`（≈:1101,1173,1218-1225,1310） | 低 | ⛔ |
| P11 | **快照下行带宽 ~306 KB/s/客户端（≈2.4 Mbps）—— 比同类网游肥 10~30 倍**，是部署容量的第一约束。实测（2026-08-07 容量探针，真 ws 客户端 + 20Hz 输入）：12v12 单房下行合计 **60 Mbps**（≈27 GB/小时）；CPU 反而便宜（13.6% 桌面核/房，线性，零慢 tick）；RSS 88MB 基底 + 7MB/房。根因链 = 20Hz × 全量 JSON 快照 × 逐接收者重建（P3 是它的 GC 面）：无 delta 编码、无二进制、无 permessage-deflate。**这也是弱网真人玩家的问题**（手机/弱 WiFi 扛不住 2.4 Mbps 常驻流）。修的杠杆按性价比：① ws 开 permessage-deflate（JSON 重复键可压 5~10×，代价 CPU）② 非自身实体降到 10Hz ③ delta 快照（典型 10~50×）④ 二进制编码。⚠️ 修哪个都要过 m10 的裁剪红线（压缩/差分不得绕过 redactFor） | 容量探针数据（PROGRESS P3 后问答记录）；`shared/net/visibility.ts` 快照构建；`Session.sendRaw` | 12v12 部署与弱网体验的第一瓶颈 **波1 已落地（2026-08-08，perf/p11-wave1，四提交）**：schema 瘦身（flags 位掩码 + 静态块首见即发 + 装备 EntityLoadouts 指纹通道 + 量化）+ sim 障碍物空间索引（128 AABB 线性扫描是 76% tickWorld / 83% bot 决策的根因，O(n²) separation 只占 6% —— 当初猜错方向）+ 事件广播跳 bot/共享编码。实测：12v12 快照 17.4KB→4.6KB，下行 313→67 KB/s/客户端（4.65×）；3v3 81→20 KB/s。m10 check1/2 重定向到 EntityLoadouts 流（不重定向会恒真）。剩余杠杆按序：按队伍共享构建（~9×快照 CPU）、10Hz 快照率（SIM.SNAPSHOT_RATE 已声明零读者；需先把 INTERP_DELAY 0.1→0.15 并接通 Welcome.interpDelay，否则插值窗静默破）、字段级 delta、二进制 | 🔶 波1已落地 |

## G. 工程与流程

| ID | 债 | 证据 | 影响 | 状态 |
|---|---|---|---|---|
| G1 | **无 CI**：1113 条单测 + 15 支验收全靠手跑，没有任何东西保证提交时它们被跑过 —— **所有其他债的放大器** | 仓库无 `.github/` | 回归网全靠自觉 | ✅ 批次三 3.1（2026-08-05，两 job：typecheck+单测 / 六支非浏览器验收+配平冒烟；浏览器验收上 CI 单独立项） |
| G2 | **无 linter/formatter**（eslint/biome/prettier 全无） | 各包无配置 | 风格与低级错误无门禁 | ✅ 批次三 3.2（2026-08-05，eslint flat config 零告警基线进 CI；formatter 未引入——55k 行统一格式化是独立决定，暂不混入） |
| G3 | **573MB 素材直接进 git、无 LFS**（`.git` 已 482MB、3861 个素材文件被跟踪）；其中**约 150MB 可证明死重**：`_2k.hdr` 126.7MB 代码从不加载（只拼 `_1k` 路径）+ 11 个未引用 `_1k` preset ≈22MB；`ui/` 1451 文件仅 ~93 个被引用 | `.gitattributes` 无 `filter=lfs`；`render/Environment.ts`（≈:86 硬编码 `_1k`、:24-31 仅 5 preset） | clone 成本；历史永久膨胀，转 LFS 越拖越贵 | ✅/🔵 批次三 3.3（2026-08-05）：**160MB 死重已删**（16 张 `_2k.hdr` + 11 个未引用 `_1k`，assets 572→412MB）；`ui/`+`music/` 盘点完（G3a）；**LFS 已拍板（🔵 用户决定）**：部分克隆过渡（README 改 `git clone --filter=blob:none`，零改写零额度），LFS/出库的最终方案与发布前 F2 素材投递一并定 —— 届时先删完 G3a 死重再迁移 |
| G3a | **盘点结果（3.3 中步产出，删除前需逐项过引用方式）**：`ui/` 1451 文件仅 skills 表 ~88 + 光标 3 被引用，**~27MB 死**（daily-rewards/deeds/dungeons/mobs/professions/ranks/store 等整目录是上游包搬来的无关功能；skills/ 未引用图标是未来选图的调色板，**不删**）；`music/` 987 文件按文件名反查仅 91 个基名被引用，**死重上限 ~147MB**（⚠️ 音频常见 `${base}_${n}` 变体拼名，删除前必须核对 sfx 表的拼接方式）；另发现零引用小件：`*_backdrop*.webp` ×6、`space_galaxy.jpg`（CREDITS 里登记过用途但代码从未接） | 本轮全仓 grep（2026-08-05）；引用面：`skillIconMap.ts`、`index.html` 光标、`AudioManager.ts` `/music/${kind}/${name}.mp3` | 死重继续膨胀历史 | ⛔ |
| G4 | **试验场与联网场景是 2779 行平行实现**：~24 个同名字段、`syncWeapon()` 逐字节重复（含同一句注释）、控制标记优先级逻辑写了两遍（联网侧注释声称「不会两条路各写一遍」但确实写了）。已有 `CombatView`/`loadoutViewFromSnapshot` 证明抽共享层可行 —— 这是「护盾判据分叉」类 bug 的持续温床 | `TestbedScene.ts`（1263 行）vs `NetworkScene.ts`（1516 行）；`:619-623` vs `:1455-1459`；`:755-766` vs `:1414-1425` | 每加一个表现都要写两遍、漏一边 | 🔧 批次三 3.4 第一铲（2026-08-05）：`SceneShell` 收走 renderer/画质/环境/镜头/输入/resize 构造 + 画质应用链（四处逐字重复→一份）+ NDC 换算（四处→一份），场景侧 getter 转发、壳唯一持有；八支浏览器验收全绿证零行为变化。**第二铲余账**：实体渲染循环（marker/护盾/化形 5 行×2）、`syncWeapon()`、控制标记优先级 —— 灯光两边数值刻意不同，**不属于**重复面。P10 又添一处：**射线拾取/悬停光标**两场景各写一份（联网侧补「点 3D 模型选中」时按任务范围本地实现，统一成可拾取注册表归本铲） |
| G5 | **债务不可 grep**：~150 处欠账以中文散文注释存在，无机器标记 → 无法统计、无法收敛。**本表即解法**；新债照登记规矩挂 `// DEBT(ID):` | 全仓 0 处 TODO/FIXME/HACK | 判断不了「还欠多少」 | 🔧 本表建立即开始清偿 |
| G6 | verify 脚本靠硬编码 sleep：14 支脚本静态累计 126.8 秒固定等待（m15 一支 27.4s/38 处）。**实测数据点**（P3 收口，2026-08-07）：m4 的控制递减段在 17 支连跑的高负载下偶发失败（递减窗口 15s 与固定 sleep 序列 ~14.8s 只差 0.2s 余量），单独跑 5/6 绿 —— 修的时候从这支下手 | `scripts/verify-*.{mjs,ts}`；`verify-m4.mjs` 递减段 | 手跑成本高、偶发脆弱 | ⛔ |
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
| B1 | `decideBotAction` 只支持单目标（选敌/换目标/保队友没做）；不会用地面技能（`CastIntent` 不产落点，「如实少一类」）；无寻路（撞死角就停）—— 3v3 以上人机可用性的前置 | **P1a 已清一半**（docs/17）：难度三档反应时间、看读条就打断（假读条 <0.35s 骗不出 normal 的踢）、normal/hard 按单发威力出招（冷却感知 + 自身中心 AOE 距离门 + 五种伤害形状估值）。**余账（P1b/P1c）**：**躲地面 AOE 已清**（P1b）；风筝需「先控再退」组合逻辑（纯后退实测恶化 33pp 已回滚）、连击点终结循环（两版尝试逐位同致盗贼 0%，回滚待诊断）、地面落点、换目标、寻路。**难度进大厅已清**（P5，2026-08-06：全链 + verify:p5，另修 canStart 不认识补位致单人开不了局；hard 留踢 + 战斗意志三调用方全接）。**P3b 又清一条**：零冷却 DoT 无限重挂已修（目标身上还在跳的 DoT 不再计周期伤害，`auras` 进 `BotPerception`；牧师基线 0.0%→71.4%）。★ P3b 顺带给「连击点」这条余账添了一个**精确证据**：盗贼割裂的 25 能量能让它基线从 21.4% 掉到 0.0%（改成 0 分毫不差回到 21.4%）—— 因为 bot 不会用终结技，这 25 点能量换来的流血永远兑不成击杀。修 bot 而不是修数值。**P4 大清账**（2026-08-06）：四类死键接通 —— 保命（血 35% 开减伤/吸收/免疫，不叠盾；`cannotAttack` 交易键只在对面读条时开）、控制（DR ≥50% 才出手 + 不叠控 + 免疫不空放；替补打断/peel/锁杀/自保四时机）、驱散（`dispelEligible` 只读资格判定，与结算共用一份规则，无目标不按）、位移（后撤跃/加速/冲锋/背刺传送 + **先控再退**条件版风筝：对手被硬控且拿近战武器且 <12m 才退，窗口内只放瞬发）。基线 90.5→71.4pp、盗贼 0→28.6%、无职业为 0，分步归因九行见 PROGRESS。**P8 再清两条**（2026-08-06）：**换目标已清**（hard 集火 pickFoe：血量评分+粘性，easy/normal 保持最近目标）、**知进退已清**（hard 苟住：弹尽粮绝转身满速跑，七道门）。**仍欠**：形态轮换、隐匿开场、挡援/保队友、瞬闪逃脱、连击点终结技、绕柱寻路 | 🔧 P1a（2026-08-05，botController 单测 ×12）· P3b（2026-08-06，DoT 重挂）· P4（2026-08-06，四类死键，行为单测 ×21）· P5（2026-08-06，难度进大厅 + 留踢 + 战斗意志）· P8（2026-08-06，集火 + 苟住） |
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
