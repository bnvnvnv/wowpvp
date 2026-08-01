/**
 * 断线与重连。规格书 11.5 / 17.3，docs/08 §6。
 *
 * docs/08 §6 的三条：
 *
 *   连接断开 → 角色**留在原地，继续参与模拟，可被攻击，不获得无敌**
 *              服务器保留其状态与一个重连令牌
 *   重连     → 下发完整快照，客户端丢弃所有本地状态，恢复控制
 *   超时     → 按淘汰处理。标准比赛**不由机器人接管**
 *
 * ★★ **「断线不提供无敌」是怎么被钉死的：这个模块拿不到实体。**
 *
 *   它的依赖里没有 `World`、没有 `CombatEntity`、没有 `AuraStore` ——
 *   只有玩家 id、令牌和时刻。所以「断线时顺手给个免伤光环」
 *   或者「断线时把角色移出世界」在这里**写不出来**，
 *   必须先给这个模块加一个它现在没有的依赖，而那是一次显眼的改动。
 *
 *   11.5 那条规则的正确实现方式就是**什么都不做** ——
 *   而「什么都不做」最难在代码审查里被看见，所以这里靠依赖的缺失来表达它。
 *   与 `sim/match/room.ts` 的 `markDisconnected()` 只改一个布尔值同源。
 *
 * ★ 超时的**判定**在这里，超时的**后果**（淘汰）留在调用方 ——
 *   与 M2 的 `applyInterrupt()` 不碰冷却是同一个手法：
 *   11.5 要求「超时按淘汰处理，不能通过退出规避死亡统计」，
 *   把淘汰留在调用点上，就没法被一个 `if (还想再等等)` 分支绕过。
 */

/** 重连宽限期，秒。docs/08 §6 只说「限时内」，没给数值 —— 取值理由见下 */
export const RECONNECT_GRACE_SECONDS = 90;

/**
 * 为什么是 90 秒：
 *   · 比一局竞技场的常规时长（6 分钟）短得多，不会让对手干等半场
 *   · 比一次波次复活间隔（12.6，最长 30 秒）长，所以夺旗里断线重连回来
 *     还能赶上下一波，不至于「断一次等于这局结束」
 *   · 家用网络的一次重连（DHCP 续约、Wi-Fi 漫游）通常在 30 秒内完成
 *
 * ⚠️ 这段时间里角色**站在原地被打**（11.5），所以它不能太长 ——
 *    否则「断线」会变成一种送人头的惩罚而不是容错。
 */

export interface DisconnectedPlayer {
  playerId: string;
  /** 重连令牌。重连时必须原样带回 */
  token: string;
  disconnectedAt: number;
  expiresAt: number;
}

export interface ReconnectRegistry {
  /** 令牌 → 断线记录 */
  byToken: Map<string, DisconnectedPlayer>;
  /** 玩家 id → 令牌，用于「同一个人又断一次」时替换旧令牌 */
  byPlayer: Map<string, string>;
}

export const createReconnectRegistry = (): ReconnectRegistry => ({
  byToken: new Map(),
  byPlayer: new Map(),
});

/**
 * 令牌工厂。默认用 `crypto.randomUUID()`。
 *
 * 做成可注入，是为了测试能给出确定性的令牌 ——
 * 而不是为了让生产环境有机会换成一个可猜的实现。
 */
export type TokenFactory = () => string;

const defaultTokenFactory: TokenFactory = () => crypto.randomUUID();

/**
 * 登记一次断线。
 *
 * ★ 注意这个函数**只**产生一条记录。它不碰角色、不碰模拟、不给任何光环 ——
 *   角色继续留在世界里被打，这正是 11.5 要的（见文件头）。
 */
export const registerDisconnect = (
  registry: ReconnectRegistry,
  playerId: string,
  now: number,
  opts: { graceSeconds?: number; tokenFactory?: TokenFactory } = {},
): DisconnectedPlayer => {
  // 同一个人又断一次：旧令牌立即作废，否则一个人会攒下多个可用令牌
  const previous = registry.byPlayer.get(playerId);
  if (previous !== undefined) registry.byToken.delete(previous);

  const grace = opts.graceSeconds ?? RECONNECT_GRACE_SECONDS;
  const record: DisconnectedPlayer = {
    playerId,
    token: (opts.tokenFactory ?? defaultTokenFactory)(),
    disconnectedAt: now,
    expiresAt: now + grace,
  };
  registry.byToken.set(record.token, record);
  registry.byPlayer.set(playerId, record.token);
  return record;
};

export type ReconnectResult =
  | {
      ok: true;
      playerId: string;
      /**
       * ★ 类型写死成 `true`。docs/08 §6：重连必须「下发完整快照，
       *   客户端丢弃所有本地状态」—— 增量恢复会让客户端带着一份
       *   已经错了的预测状态继续跑。想做增量得先改这个类型。
       */
      fullSnapshotRequired: true;
    }
  | { ok: false; reason: 'unknownToken' | 'expired' };

/**
 * 用令牌重连。
 *
 * ⚠️ 成功后调用方还要做两件这个模块做不到的事：
 *   1. `markReconnected(room, playerId)`（房间层的连接状态）
 *   2. 下发一份完整快照（`buildSnapshot(deps, viewer)`）
 */
export const redeemReconnect = (
  registry: ReconnectRegistry,
  token: string,
  now: number,
): ReconnectResult => {
  const record = registry.byToken.get(token);
  if (!record) return { ok: false, reason: 'unknownToken' };

  if (now > record.expiresAt) {
    // 过期令牌立刻清掉 —— 留着只会让下一次调用得到同一个错误
    registry.byToken.delete(token);
    registry.byPlayer.delete(record.playerId);
    return { ok: false, reason: 'expired' };
  }

  registry.byToken.delete(token);
  registry.byPlayer.delete(record.playerId);
  return { ok: true, playerId: record.playerId, fullSnapshotRequired: true };
};

/**
 * 取出所有已超时的断线玩家，并从登记表里移除。
 *
 * ★ 返回**待淘汰名单**而不是自己执行淘汰。
 *   11.5：「超时按淘汰处理」「主动退出立即按淘汰处理，不能通过退出规避死亡统计」——
 *   淘汰要写死亡统计、要触发死亡结算（`sim/death.ts`），那些都在调用方。
 *   把后果留在调用点上，它就没法被一个「再宽限一下」的分支悄悄绕过。
 *
 * ★ 同时也是「标准比赛**不由机器人接管**」的实现方式：本模块只会产出
 *   「淘汰这个人」，产不出「派个 AI 顶上」—— 后者需要一个它没有的依赖。
 */
export const takeExpired = (registry: ReconnectRegistry, now: number): string[] => {
  const expired: string[] = [];
  for (const [token, record] of [...registry.byToken]) {
    if (now <= record.expiresAt) continue;
    expired.push(record.playerId);
    registry.byToken.delete(token);
    registry.byPlayer.delete(record.playerId);
  }
  return expired;
};

/** 某玩家当前是否处于断线宽限期内 */
export const isAwaitingReconnect = (registry: ReconnectRegistry, playerId: string): boolean => {
  const token = registry.byPlayer.get(playerId);
  return token !== undefined && registry.byToken.has(token);
};

/** 剩余宽限秒数，供 HUD 显示「队友掉线中（还剩 42 秒）」。不在宽限期内返回 undefined */
export const graceRemaining = (
  registry: ReconnectRegistry,
  playerId: string,
  now: number,
): number | undefined => {
  const token = registry.byPlayer.get(playerId);
  const record = token === undefined ? undefined : registry.byToken.get(token);
  return record ? Math.max(0, record.expiresAt - now) : undefined;
};

/**
 * 11.5：主动退出**立即**按淘汰处理，不进宽限期。
 *
 * ★ 单列成一个函数而不是「用 graceSeconds: 0 调 registerDisconnect」——
 *   后者能work，但读代码的人看不出这是一条规则。
 *   规格书原话是「不能通过退出规避死亡统计」，所以退出返回的是
 *   「立即淘汰」这个明确结论，而不是一条会过期的记录。
 */
export const leaveImmediately = (
  registry: ReconnectRegistry,
  playerId: string,
): { eliminate: true; playerId: string } => {
  const token = registry.byPlayer.get(playerId);
  if (token !== undefined) registry.byToken.delete(token);
  registry.byPlayer.delete(playerId);
  return { eliminate: true, playerId };
};
