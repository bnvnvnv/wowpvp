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
| 传输 | WebSocket（`ws`），二进制帧 | 浏览器唯一可靠的低延迟双向通道 |
| 服务器 tick | 20 Hz（`SIM.TICK_RATE`） | 目标制战斗不需要 60Hz；20Hz 足以让 0.75 秒的最短昏迷有 15 个 tick 的分辨率 |
| 快照广播 | 20 Hz | 与 tick 同频，客户端插值补足视觉平滑 |
| 客户端输入 | 每渲染帧发送，服务器按 tick 消费 | 输入不丢，但不加速模拟 |
| 插值缓冲 | 100 ms（`SIM.INTERP_DELAY`） | 两个快照的间隔是 50ms，缓冲 100ms 容忍一次丢包 |

## 2. 权威边界

| 谁决定 | 内容 |
|---|---|
| **仅服务器** | 伤害、治疗、命中与否、控制生效与时长、施法成功/失败、拾取归属、旗帜状态、死亡、存活人数、装备栏内容 |
| **客户端预测 + 服务器纠正** | 自己的位置与朝向 |
| **仅客户端** | 镜头、特效、音效、HUD 布局、画质档位、按键映射 |

客户端**永远不发送**「我造成了 X 伤害」这类结果，只发送意图（`CastRequest`、`MoveInput`）。

## 3. 消息类型

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
      school: School; absorbed?: number; blocked?: boolean; dodged?: boolean; immune?: boolean }
  | { t: 'Heal'; sourceId: EntityId; targetId: EntityId; amount: number; overheal: number }
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

## 7. 序列化

首版用 JSON，够用且可读性高，便于调试。

M7 之后若 12v12 快照体积成为瓶颈，再切换到二进制（建议手写 `DataView` 编解码而非引入 schema 框架，
因为字段集合完全由我们控制）。切换时**协议语义不变**，只换编码层 ——
所以 `net/` 目录下要把「消息定义」和「编解码」分成两个文件，不要混在一起。

预估：12v12 单个快照约 24 个实体 × ~200 字节 = 4.8 KB，20 Hz → 96 KB/s。
JSON 大约是这个的 2–3 倍，仍在可接受范围内，但接近上限，所以要留好切换路径。
