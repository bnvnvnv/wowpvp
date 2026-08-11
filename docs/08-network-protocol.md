# 网络协议

> 规格书不规定网络架构（1.2），本文是工程侧决策。
> 但有两条规则**必须**由网络层保障，做不到就等于验收不通过：
> - 验收 #5：未被发现的潜行目标不能被点击、Tab、姓名板或小地图选中
> - 验收 #36：敌人能识别当前武器和护甲，但**不能查看备用装备**
>
> 这两条如果只在客户端过滤，改一行前端代码就能作弊。**它们是安全边界，不是显示逻辑。**

## 1. 传输与频率

| 项 | 值 | 理由 |
|---|---|---|
| 传输 | WebSocket（`ws`），文本帧 + `permessage-deflate` | 浏览器唯一可靠的低延迟双向通道；压缩参数见 §8.1 |
| 服务器 tick | 20 Hz（`SIM.TICK_RATE`） | 目标制战斗不需要 60Hz；20Hz 足以让 0.75 秒的最短昏迷有 15 个 tick 的分辨率 |
| 快照广播 | **10 Hz**（`SIM.SNAPSHOT_RATE`，P11 波2 从 20 降下来）| **模拟仍是 20Hz**，只是状态每 100ms 发一份；事件消息仍逐 tick 即时发，打击反馈不变钝 |
| 客户端输入 | 每渲染帧发送，服务器按 tick 消费 | 输入不丢，但不加速模拟 |
| 插值缓冲 | **150 ms**（`SIM.INTERP_DELAY`，P11 波2 从 100ms 提上来）| 快照间隔变成 100ms 后，0.1 的窗刚好压在帧边界上，一点抖动就退化；0.15 = 1.5× 快照间隔，是插值稳定的最小安全余量 |

> ⚠️ 后两行**联动**，改一个必须一起看另一个：`SNAPSHOT_RATE` 必须整除
> `TICK_RATE`（`MatchLoop` 按 `tick % divisor` 分频），而插值窗必须 >
> 快照间隔 + 抖动余量，否则插值器频繁落进「没有更新的帧」的退化分支，
> 动画会闪。代价如实记：**远端实体**的显示比权威世界晚 150ms（原 100ms）；
> 自己的移动走预测（§5），不受此影响。

## 2. 权威边界

| 谁决定 | 内容 |
|---|---|
| **仅服务器** | 伤害、治疗、命中与否、**暴击**（偏差 #7）、控制生效与时长、施法成功/失败、拾取归属、旗帜状态、死亡、存活人数、装备栏内容 |
| **客户端预测 + 服务器纠正** | 自己的位置与朝向 |
| **仅客户端** | 镜头、特效、音效、HUD 布局、画质档位、按键映射 |

客户端**永远不发送**「我造成了 X 伤害」这类结果，只发送意图（`CastRequest`、`MoveInput`）。

## 3. 消息类型

> ⚠️ **本节两段代码是 M0 立的基线，不是当前的完整清单。** 此后陆续加了
> 房间设置（`SetRoomPreset`/`SetRoomMode`/`SetRoomMap`/`SetFillWithBots`/
> `SetRoomBotDifficulty`/`SetRoomBoss`）、军械箱（`OpenArmory`/`ChooseArsenal`/`ArsenalOffer`/`PickupResult`）、
> 战后统计（`MatchStats`）、断线三条（`Peer*`），以及 **P11–P13 的那一批**（见 §8）。
> 权威清单永远是 `packages/shared/src/net/protocol.ts` 的两个联合类型 +
> 与之同步的 `ALL_CLIENT_MESSAGE_KINDS` / `ALL_SERVER_MESSAGE_KINDS`
> （穷尽性由测试强制）。

### 3.1 客户端 → 服务器

```ts
type ClientMessage =
  // 房间阶段
  | { t: 'JoinRoom'; roomId: string; name: string }
  | { t: 'SelectTeam'; team: 'red' | 'blue' | 'spectator' }
  | { t: 'SelectClass'; classId: ClassId; appearance?: string }
  | { t: 'SetReady'; ready: boolean }

  // 战斗阶段
  /** 每渲染帧发送。seq 用于服务器纠正时告诉客户端「已确认到第几号输入」 */
  | { t: 'Input'; seq: number; dt: number
      move: { forward: number; strafe: number }   // -1..1
      characterYaw: number                         // 角色朝向，不是镜头朝向
      jump: boolean }

  /** 目标选择。服务器校验目标是否在该客户端的可见集合里 */
  | { t: 'SetTarget'; slot: 'hard' | 'focus'; entityId: EntityId | null }
  | { t: 'TabTarget'; reverse: boolean }

  /** 释放技能。groundPoint 仅地面技能需要；facing 仅方向技能需要 */
  | { t: 'CastRequest'; skillId: SkillId; targetId?: EntityId
      groundPoint?: Vec3; facing?: number }
  /** 7.5 假读条：主动取消 */
  | { t: 'CancelCast' }
  /** 8.3 通用解控 */
  | { t: 'UseTrinket' }

  // 交互与装备
  | { t: 'InteractStart'; entityId: EntityId }   // 拾取/拔旗/归还/开箱
  | { t: 'InteractCancel' }
  | { t: 'SwapWeapon'; slot: number }
  | { t: 'SwapArmor'; slot: number }
  | { t: 'UseConsumable'; slot: number };
```

### 3.2 服务器 → 客户端

```ts
type ServerMessage =
  | { t: 'RoomState'; players: RoomPlayer[]; mode: GameMode; preset: ArenaPreset; mapId: MapId }
  | { t: 'MatchStart'; mapId: MapId; you: EntityId; startsAt: number }

  /** 每 tick 广播。见 §4 视野裁剪 */
  | { t: 'Snapshot'; tick: number; ackSeq: number; entities: EntitySnapshot[]
      match: MatchSnapshot }

  // 事件流：用于播放表现和写战后统计，不参与状态重建
  | { t: 'CastStarted'; casterId: EntityId; skillId: SkillId; duration: number
      interruptible: boolean; school: School; castKind: CastKind }
  | { t: 'CastInterrupted'; casterId: EntityId; source: InterruptSource
      schoolLock?: { school: School; until: number } }
  | { t: 'CastFailed'; skillId: SkillId; reason: CastFailure }
  | { t: 'Damage'; sourceId: EntityId; targetId: EntityId; amount: number
      school: School; absorbed?: number; blocked?: boolean; dodged?: boolean; immune?: boolean
      // 打击感改造（偏差 #7/#8 的表现信号）：crit 条件携带；
      // overkill>0 = 致命一击（随后必有公开 Death，零泄露）
      crit?: boolean; overkill: number }
  | { t: 'Heal'; sourceId: EntityId; targetId: EntityId; amount: number; overheal: number
      crit?: boolean }
  | { t: 'AuraApplied'; targetId: EntityId; auraId: string; duration: number; stacks: number }
  | { t: 'AuraRemoved'; targetId: EntityId; auraId: string; reason: 'expired' | 'dispelled' | 'broken' | 'cancelled' }
  | { t: 'Death'; entityId: EntityId; killerId?: EntityId }
  | { t: 'FlagEvent'; flagTeam: TeamId; state: FlagState; carrierId?: EntityId; position?: Vec3 }
  | { t: 'RoundEnd'; winner: TeamId | 'draw'; stats: MatchStats }
  | { t: 'MatchEnd'; winner: TeamId; stats: MatchStats };
```

### 3.3 为什么把「事件」和「快照」分开

快照负责**状态**（生命、位置、光环列表），事件负责**瞬时表现**（这一刻打出了 250 点火焰伤害、护盾破裂了）。

如果只发快照，客户端只能看到「生命从 800 变成 550」，无法知道是一次 250 的火焰伤害
还是两次 125 的物理 —— 而 14.1 的命中反馈和 16.1 的战后统计都需要这个信息。

如果只发事件，丢一个包状态就永久错位。

快照是**权威真相**，客户端状态以它为准；事件只驱动特效、飘字和统计，**丢了不影响正确性**。

## 4. 视野裁剪 —— 安全边界

服务器为**每个客户端**单独裁剪快照。以下内容根据接收者不同而不同：

### 4.1 潜行（验收 #5 / 规格书 5.3）

```
对接收者 R，实体 E 是否进入快照：
  E 未潜行                          → 进
  E 已潜行 且 E 与 R 同队            → 进（队友能看见自己人潜行）
  E 已潜行 且 已被 R 所在队伍发现     → 进（3 米内、照明弹区域内、主动攻击后）
  否则                              → 完全不进快照
```

**不是把 `stealthed: true` 发过去让客户端隐藏** —— 那样改前端就能透视。
未被发现的潜行者对该客户端而言**不存在**。

### 4.2 备用装备（验收 #36 / 规格书 10.6）

```
对接收者 R，实体 E 的装备字段：
  E 与 R 同队 → 完整 loadout（当前 + 备用 + 道具）
  E 是敌人    → 只发 currentWeaponId、armorArchetype、正在换装的进度
                备用装备槽位一律不发
```

### 4.3 其他按接收者裁剪的内容

| 内容 | 规则 | 依据 |
|---|---|---|
| 死亡观战视角 | 只发己方存活玩家周边的实体 | 11.4：不能自由镜头穿墙找潜行目标 |
| 敌方资源值 | 发送（目标框需要显示） | 15.2 |
| 敌方技能冷却 | **不发** | 规格书未要求，且会削弱博弈 |
| 决胜阶段位置 | 发送所有玩家大致位置 | 8.5：决胜阶段所有玩家大致位置可见 |
| 旗手位置 | **始终发给双方** | 12.2：旗手位置对双方持续可见 |

> 注意 12.2 与 4.1 的交互：**旗手不能潜行**（12.3），
> 使用潜行/消失/完全无敌时**先掉旗**（8.4），所以两条规则不会冲突。

## 5. 客户端预测与纠正

只预测**自己的移动**。技能效果一律等服务器确认 —— 预测伤害会导致「打出去了又收回」的糟糕体验，
而目标制战斗的技能延迟本来就有施法条掩盖。

```
客户端每帧：
  1. 采集输入，seq++
  2. 立刻用本地 movement.step() 推进自己的位置（预测）
  3. 把输入连同 seq 存入 pendingInputs，发给服务器

收到 Snapshot{ackSeq} 时：
  4. 丢弃 pendingInputs 中 seq <= ackSeq 的部分
  5. 把自己的位置重置为快照中的权威值
  6. 重放剩余 pendingInputs（用同一份 shared/sim/movement）
  7. 若重放结果与预测差距 > 阈值，平滑插值过去，不瞬移
```

第 6 步能成立的前提是 **`movement.step()` 在客户端和服务器是同一份代码**，
这也是 `packages/shared` 必须零依赖的原因之一。

其他玩家的位置**不预测**，用 100ms 延迟缓冲做插值 —— 13.4 明确要求
「传送、位置纠正和大位移不能被识别为高速跑步」，插值时要检测大跳变并直接瞬移而非插值。

## 6. 断线与重连（规格书 17.3 / 11.5）

```
连接断开
  → 角色留在原地，继续参与模拟，**可被攻击，不获得无敌**
  → 服务器保留其状态与一个重连令牌

重连（限时内）
  → 下发完整快照，客户端丢弃所有本地状态
  → 恢复控制

超时
  → 按淘汰处理。标准比赛**不由机器人接管**
  → 主动退出立即按淘汰处理，不能通过退出规避死亡统计
```

> ⚠️ **上面这段是规格书口径，实装已经偏离，登记在 docs/10 已知偏差 #14**：
> M16b 起**断线瞬间由人机接管**、重连即交还。组队模式（竞技场/夺旗）的宽限
> 长于任何一局（`TAKEOVER_GRACE_SECONDS`），于是「超时淘汰」不再发生；
> **大乱斗是例外** —— P13 给它 90 秒（`FFA.DISCONNECT_GRACE_SECONDS`），
> 到期走既有 `takeExpired → eliminate` 链弃权判死，动机是「bot 不能替第一名
> 夺冠」。语义细节见 docs/06 §11.8。★ 「主动退出立即淘汰」那半句原样成立。

## 7. 序列化

首版用 JSON，够用且可读性高，便于调试。

M7 之后若 12v12 快照体积成为瓶颈，再切换到二进制（建议手写 `DataView` 编解码而非引入 schema 框架，
因为字段集合完全由我们控制）。切换时**协议语义不变**，只换编码层 ——
所以 `net/` 目录下要把「消息定义」和「编解码」分成两个文件，不要混在一起。

预估：12v12 单个快照约 24 个实体 × ~200 字节 = 4.8 KB，20 Hz → 96 KB/s。
JSON 大约是这个的 2–3 倍，仍在可接受范围内，但接近上限，所以要留好切换路径。

> **实测把这个预估打脸了**（P11，2026-08-07 容量探针）：真实下行是
> **306 KB/s/客户端**，12v12 单房 60 Mbps —— 比预估肥 3 倍还多。
> 编码**仍然是 JSON**（`encodeServerMessage` = `JSON.stringify`），
> 二进制那条路没走：P11 三波先把体积本身砍掉了 76×（§8.1），
> deflate 接管跨帧冗余后，delta 与二进制的边际收益大减，暂缓。
> 「消息定义与编解码分两个文件」这条路径依然留着。

---

## 8. P11–P13 协议现状（2026-08-08 起）

> 上面 §1–§7 是 M0 立的基线，本节记的是**此后协议面真实发生的变化**，
> 一律以 `packages/shared/src/net/protocol.ts` 与 `codec.ts` 的源码为准。
> 三条老规矩一条没松：codec 校验入站、`FORBIDDEN_CLIENT_FIELDS` 不放宽、
> 带 `EntityId` 的服务器消息必须在 `referencedEntities()` 里登记（fail-closed）。

### 8.1 快照瘦身三波（P11）—— 语义不变，字节变小

带宽是部署的第一约束（细节与实测数字见 [15-debt-registry.md](15-debt-registry.md) 的 **P11** 行）。
三波都遵守同一条红线：**压缩/共享/差分都不得绕过 `redactFor` 的裁剪**（§4）。

| 波 | 做了什么 | 协议面的表现 |
|---|---|---|
| 波1 | 快照 schema 瘦身：`flags` 位掩码、一局不变的静态块**首见即发**、装备走独立通道、数值量化 | 快照里不再每 tick 重复静态字段；`verify:m10` 的 #1/#2 重定向到新通道（不重定向会恒真） |
| 波2 | `permessage-deflate` + 快照降到 10 Hz | 见 §1 与下方压缩参数 |
| 波3 | **实体段按队伍共享构建** + 逐人字段收进 `Snapshot.self` | `SnapshotMessage` 多了可选的 `self` 段，见 §8.2 |

`permessage-deflate` 的参数是量过的，不是抄的默认值：
`level 1`（连续快照 ~80% 是重复结构，**上下文接管**让上一份留在窗口里 ——「穷人的 delta」；
level 6 只多约 0.1× 压缩比但 CPU 翻倍）、`serverMaxWindowBits 13` + `memLevel 6`
（每连接出站上下文 ~64KB，wb15 快 30% 但要 256KB/连接）、`threshold 1024`
（事件消息 ~150B 不压，单条收益抵不过 zlib 调度）、`clientNoContextTakeover`
（入站只有 ~150B 的 `Input`，不需要跨消息窗口）。
浏览器端自动协商解压，**零客户端改动**；CPU 紧张的部署可用 `perMessageDeflate: false` 关掉。

### 8.2 快照的共享段 / self 段拆分（P11 波3）

支点是一条可测的事实：**实体段是「(世界, 队伍)」的函数**，与具体是哪个接收者无关
（有「同队逐字节相同」的测试钉住它）。于是服务器每队 `build` + `stringify` 一次，
全队拼接复用 —— 24 次/tick 降到 2 次。

逐人的部分收进新的可选段：

```ts
interface SnapshotMessage {
  t: 'Snapshot'; tick: number; time: number; ackSeq: number; you: EntityId;
  /** P11 波3：每人私有段（冷却/GCD/焦点/重放状态/可拾取列表）*/
  self?: SelfStateSnapshot;
  /** ★ 全队共享的字节 —— 私有的都在 self 里 */
  entities: readonly EntitySnapshot[];
  projectiles: readonly ProjectileSnapshot[];
  grounds: readonly GroundAreaSnapshot[];
  drops: readonly DropSnapshot[];      // pickable 已挪进 self.pickableDropIds
  armories: readonly ArmorySnapshot[];
  match: MatchSnapshot;
}
```

★ 观战跟随时整段是**被跟随队友的** —— 11.4 的语义原样。
★ 裁剪红线不变：`verify:m10` 的 check2/check3 与 `verify:m16` 的 check6/8/11b 已随之重定向。

### 8.3 每会话通道：`EntityMeta`

装备（153 B/实体）与一局不变的静态块（~90 B/实体）被 20Hz 重发，曾合占快照四成。
现在它们**不进快照**，走一条独立的服务器消息：

```ts
| { t: 'EntityMeta'
    items: readonly { entityId: EntityId
      statics?: EntityStaticsSnapshot
      equipment?: AllyEquipmentSnapshot | EnemyEquipmentSnapshot }[] }
```

节奏：服务器在发快照**之前**发它；**首见**带 `statics + equipment`，之后只在
「该接收者视角下的装备视图指纹变了」时带 `equipment`。

★ **裁剪语义原样**：`items` 里只有该接收者本份快照可见的实体，敌人拿到的是
`EnemyEquipmentSnapshot`（无备用槽位，§4.2 / 验收 #36）—— `verify:m10` 第 2 条
现在盯的就是这条消息流。
★ 它**不走 `dispatch()` 广播**，与 `Snapshot` 同为按接收者构建的私信；
`referencedEntities()` 因此把它归在「不走 dispatch」一列（出现在 dispatch 里本身就是接线错误）。

客户端侧的还原边界是 **`SnapshotHydrator`**（`client/src/net/SnapshotHydrator.ts`）：
按 `entityId` 缓存 `EntityMeta`，在 hydrate 时把静态块与装备合回实体、
把位掩码展开回 `DisplayFlags`、把 `self.pickableDropIds` 合回 `drops.pickable`。
**缓存里没有静态块的实体本帧跳过并告警** —— 宁可少画一帧，也不画一个字段缺失的实体。

### 8.4 房间与大厅：`ListRooms` / `RoomList` / `QueueStatus`（P12）

```ts
// 客户端 → 服务器
| { t: 'ListRooms' }                      // 只读、无参数、任何阶段可发
| { t: 'SetRoomMode'; mode: GameMode }    // 只有房主、只在开赛前

// 服务器 → 客户端
| { t: 'RoomList'
    rooms: readonly { roomId: string; mode: GameMode; players: number
      capacity: number; started: boolean; fillWithBots: boolean }[] }
| { t: 'QueueStatus'; ahead: number }
```

- **`RoomList` 只含房间摘要，不含玩家名单**，上限 50 条按人数降序。
  与「`/healthz` 刻意不列房间码」（S6）不冲突：那是无鉴权 HTTP 端点会被扫描器批量抓，
  这条走 ws 会话、是大厅的产品功能 —— 房间本就公开可加入（`JoinRoom` 无密码），
  浏览只是把既有事实做成可见。将来加密码房时在此按 visibility 过滤。
- **`SetRoomMode` 的形状没变**：P12 把 `GameMode` 从 6 档放开到 15 档
  （`arena1v1`–`arena12v12` + `ffa` + 夺旗三档），但仍然「一个尺寸一个模式值」，
  `RoomState` / `SetRoomMode` 字段零迁移，**codec 白名单从枚举派生**自动放行
  （`ALL_GAME_MODES = Object.values(GameMode)` —— 手写数组会让新模式静默被拒）。
- **`QueueStatus` 是「服务器满了」的新答案**：不再 1013 一关了之，连接进等待队列，
  队伍每次变动全队重报，有人下线按序接纳。排队期间客户端发的消息**服务器缓存重放**
  （上限 64 条）—— 客户端 open 就发的 `JoinRoom` 不会丢，排队对它透明，
  等到 `Welcome` 就是轮到了。容量分母因此从「全部连接」换成「已接纳连接」
  （排队的不占名额分母，否则队伍自己把门堵死）；队列自身有上限（`QUEUE_MAX = 200`），超出仍 1013。

### 8.5 大乱斗消息族（P13）

规则见 [06-modes-and-maps.md](06-modes-and-maps.md) §11，这里只记协议面。

```ts
// 客户端 → 服务器（MATCH_ONLY，已登记进阶段白名单 —— A8 的教训）
| { t: 'FfaBuy'; offerId: string }

// 服务器 → 客户端
| { t: 'FfaKill'; killerName: string; victimName: string
    streak: number; bounty: number; killerScore: number }
| { t: 'FfaShop'; balance: number; offers: readonly FfaOffer[] }
| { t: 'BossEvent'; kind: 'spawned' | 'enraged' | 'slain'; entityId: EntityId
    name: string; position?: Vec3; killerId?: EntityId; bounty?: number }
```

四条各自的红线：

- **`FfaBuy` 只发商品编号。** 价格、余额、「我买到了什么」三样都是**结果**（§2 的第一条）——
  带上价格就是一件 0 分的武器。协议往返测试里有一条「伪造 cost 进不了 sim」。
- **`FfaKill` 只有名字没有实体 id。** 与决胜阶段模糊点同一手法：击杀公告是全场信息，
  但不该顺手给出一个「可选中的 id」。`referencedEntities('FfaKill')` 因此返回空数组，
  而这是**结构上**成立的空，不是漏登记。
- **`FfaShop` 是私信不是广播。** 货架按**接收者的职业**生成（卖给战士一把法杖没有意义），
  余额是他一个人的账，广播出去等于把全场经济摊开。节奏是「进对局发一次 + 余额一变就重发」，
  客户端因此**从不自己减账**（本地先减的话，被拒绝的那次购买会让面板与真账长期错开）。
- **`BossEvent` 一条消息带一个 `kind`** 而不是拆三条：三者共享同一组字段，客户端处理
  也只有「往播报条上写一行」一种。它**不带血量/伤害**（那些在快照里，事件流不参与状态重建，§3.3）；
  `bounty` 是**已经发生的记账结果**，服务器→客户端方向，客户端永远不许上报。
  它在 `redactFor` 里有自己的**抹而不丢**分支，`referencedEntities` 登记 `entityId` 是兜底。

BOSS 的**可达性**靠一条房主开关消息 `SetRoomBoss{enabled}`（与 `SetRoomPreset` /
`SetRoomMode` 同一个存在理由：没有这条消息，`sim/boss.ts` 的全部规则在真实对局里
一次都不会发生）。默认关；大乱斗地图不看这个开关，默认就带 BOSS。

★ 两张 `kinds` 表（`ALL_CLIENT_MESSAGE_KINDS` / `ALL_SERVER_MESSAGE_KINDS`）都已登记，
穷尽性测试盯着 —— 加消息忘了登记是编译期/测试期红，不是运行时静默失效。
★ `referencedEntities()` 的穷尽 switch 同样表过态：`FfaKill` 返回空数组
（**结构上**没有实体引用，不是漏登记）、`BossEvent` 登记 `entityId` 作兜底、
`FfaShop` 归在「不走 dispatch 的私信」一列。fail-closed 不放宽，
`satisfies never` 让新消息忘归类时编译不过。

### 8.6 用户拍板批新增（2026-08-10）

```ts
// 客户端 → 服务器（ROOM_ONLY，已登记进阶段白名单 —— A8 的教训）
| { t: 'SetRoomMap'; mapId: MapId }

// 服务器 → 客户端（私信，不广播）
| { t: 'CastQueueExpired'; skillId: SkillId; waited: number }
```

- **`SetRoomMap`**（P5 选图的可达性）：房主在房间页换一张**当前模式适配**的地图，
  与 `SetRoomPreset` / `SetRoomMode` / `SetRoomBoss` 同一个存在理由 —— 没有它，
  P5 那四张主题图（`mapsForMode(mode)` 里排在试炼环之后）玩家一张都进不去。
  只带 id，不带名字/尺寸/preset：那些都在地图注册表里，两端按 id 查
  （`MAP_BY_ID.get(id)`，绝不按数组下标 —— m5 #24）。**codec 只验「1–32 字符的字符串」**
  （与 `JoinRoom.roomId` 同族的长度约束，S2）；「存不存在、适不适配当前人数档」
  由 sim 的 `setMap()` 判，**不合法一律诚实拒绝，绝不静默换成一张能用的**
  （静默改的表现是「我明明选了熔岩裂谷，开局却在试炼环」）。`RoomState.mapId`
  本来就在广播，所以没有新的服务器消息；**降档回落**（当前图不适配新人数档时退回
  `mapsForMode(mode)[0]`）留在 `setMode()` 里 —— 那一步玩家知道自己动了什么。
  它是客户端消息，`referencedEntities()` 那张服务器侧的穷尽表因此不涉及。
- **`CastQueueExpired`**（X21 的答案）：0.4s 施法排队窗过期、排入的按键作废时私发给
  施法者本人。`waited` 是从按下到作废的实际秒数，给 HUD 判「差一点」还是「早就凉了」。
  刻意**不**给 `CastFailure` 加枚举值 —— 客户端 `Record<CastFailure, string>` 会编译不过，
  跨包破坏；排队过期也确实不是「施法失败」（那次按键从未成为施法）。
- **快照两个新可选字段**（A17 夺旗时限）：`match.timeRemaining?: number`
  （限时局才有；加时期间语义换成「距加时硬上限还剩多久」）与
  `match.overtime?: boolean`（进加时才出现）。竞技场视图不带它们 —— 15.4
  两视图不相交的既有设计不破。HUD 消费待接（见 docs/15 A17 行余账）。
