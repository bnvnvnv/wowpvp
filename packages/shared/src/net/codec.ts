/**
 * 协议编解码与**入站校验**。docs/08 §7。
 *
 * ★ 与 `protocol.ts` 分成两个文件，是为了将来从 JSON 换成二进制时
 *   「协议语义不变，只换编码层」（docs/08 §7 原话）。
 *   首版用 JSON：够用、可读、便于调试。
 *
 * ★★ **`parseClientMessage()` 是不受信任输入的唯一入口。**
 *
 *   客户端消息来自浏览器，可以是任意 JSON —— 也可以是攻击者手写的。
 *   所以这个函数必须在消息碰到 sim 之前把它验完，而且验的不只是**形状**，
 *   还有**范围**：
 *     · `forward = 999`  → 不钳制就是速度外挂
 *     · `dt = 100`       → 不拒绝就是瞬移外挂（一帧走 700 米）
 *
 *   ★ 它**返回错误而不是抛异常**：一个畸形包不该让整个房间掉线。
 *     `verify:m10` 会真的发一条不存在的消息类型，断言服务器回 `Rejected`
 *     而连接**仍然活着**。
 */

import { asEntityId, asSkillId, asClassId, type EntityId } from '../types/ids.js';
import type { Vec3 } from '../math/vec3.js';
import {
  ALL_CLIENT_MESSAGE_KINDS,
  INPUT_LIMITS,
  type ClientMessage,
  type ClientMessageKind,
  type ServerMessage,
} from './protocol.js';

// ════════════════════════════════════════════════════════════════
//  编码
// ════════════════════════════════════════════════════════════════

export const encodeServerMessage = (msg: ServerMessage): string => JSON.stringify(msg);
export const encodeClientMessage = (msg: ClientMessage): string => JSON.stringify(msg);

/**
 * 解码服务器消息。客户端用。
 *
 * ★ 这一侧的信任模型与入站相反：服务器是权威的，所以这里只做形状检查，
 *   不做范围钳制 —— 如果服务器发来越界数据，那是服务器的 bug，
 *   客户端悄悄钳制会把它掩盖掉。
 */
export const decodeServerMessage = (raw: string): ServerMessage | undefined => {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isRecord(v) || typeof v['t'] !== 'string') return undefined;
    return v as ServerMessage;
  } catch {
    return undefined;
  }
};

// ════════════════════════════════════════════════════════════════
//  入站校验
// ════════════════════════════════════════════════════════════════

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  /**
   * `reason` 会原样回给客户端（`Rejected` 消息），所以它要能指出**哪里**不对，
   * 但**不能**泄露服务器内部状态 —— 例如不要在拒绝 SetTarget 时说
   * 「实体 7 不在你的可见集合里」，那等于确认了实体 7 存在。
   */
  | { ok: false; reason: string };

const bad = (reason: string): ParseResult => ({ ok: false, reason });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ★ 钳制而不是拒绝：摇杆偶尔给出 1.0000001 是正常的，没必要因此丢一帧输入 */
const clampAxis = (v: number): number =>
  Math.max(-INPUT_LIMITS.AXIS_ABS_MAX, Math.min(INPUT_LIMITS.AXIS_ABS_MAX, v));

const isKnownKind = (t: string): t is ClientMessageKind =>
  (ALL_CLIENT_MESSAGE_KINDS as readonly string[]).includes(t);

const parseVec3 = (v: unknown): Vec3 | undefined => {
  if (!isRecord(v)) return undefined;
  const { x, y, z } = v;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return undefined;
  return { x, y, z };
};

const parseEntityId = (v: unknown): EntityId | undefined => {
  // 实体 id 是从 1 开始的整数（world.ts 的 allocEntityId）
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 1) return undefined;
  return asEntityId(v);
};

/**
 * 解析一条客户端消息。
 *
 * ⚠️ 调用方**还要**做两件本函数做不到的事：
 *   1. 权限校验：这个连接当前处于房间阶段还是战斗阶段？
 *      （战斗中发 `SelectClass` 应当被拒绝）
 *   2. 可见性校验：`SetTarget` 的目标是否在**该客户端的可见集合**里（验收 #5）
 *      —— 本函数没有 world，判不了。
 *   这两件事留在调用点上，与 M2 的 `applyInterrupt` 不碰冷却是同一个手法。
 */
export const parseClientMessage = (raw: string): ParseResult => {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad('不是合法 JSON');
  }
  if (!isRecord(v)) return bad('消息必须是对象');

  const t = v['t'];
  if (typeof t !== 'string') return bad('缺少消息类型 t');
  if (!isKnownKind(t)) return bad(`未知消息类型：${t}`);

  switch (t) {
    case 'JoinRoom': {
      const roomId = v['roomId'];
      const name = v['name'];
      if (typeof roomId !== 'string' || roomId.length === 0) return bad('roomId 无效');
      if (typeof name !== 'string' || name.length === 0 || name.length > 24) {
        return bad('name 无效（1–24 字符）');
      }
      return { ok: true, msg: { t, roomId, name } };
    }

    case 'SelectTeam': {
      const team = v['team'];
      if (team !== 'red' && team !== 'blue' && team !== 'spectator') return bad('team 无效');
      return { ok: true, msg: { t, team } };
    }

    case 'SelectClass': {
      const classId = v['classId'];
      if (typeof classId !== 'string' || classId.length === 0) return bad('classId 无效');
      const appearance = v['appearance'];
      if (appearance !== undefined && typeof appearance !== 'string') return bad('appearance 无效');
      return {
        ok: true,
        msg: {
          t, classId: asClassId(classId),
          ...(appearance !== undefined ? { appearance } : {}),
        },
      };
    }

    case 'SetReady': {
      const ready = v['ready'];
      if (typeof ready !== 'boolean') return bad('ready 必须是布尔值');
      return { ok: true, msg: { t, ready } };
    }

    case 'Reconnect': {
      const token = v['token'];
      if (typeof token !== 'string' || token.length === 0 || token.length > 128) {
        return bad('token 无效');
      }
      return { ok: true, msg: { t, token } };
    }

    case 'Input': {
      const seq = v['seq'];
      const dt = v['dt'];
      const forward = v['forward'];
      const strafe = v['strafe'];
      const characterYaw = v['characterYaw'];
      const jump = v['jump'];

      if (!isFiniteNumber(seq) || !Number.isInteger(seq) || seq < 0) return bad('seq 无效');
      if (!isFiniteNumber(dt)) return bad('dt 无效');
      // ★★ 这一条是反作弊边界，不是防御性编程：dt=100 就是瞬移外挂
      if (dt <= INPUT_LIMITS.DT_MIN || dt > INPUT_LIMITS.DT_MAX) {
        return bad(`dt 超出允许区间 (${INPUT_LIMITS.DT_MIN}, ${INPUT_LIMITS.DT_MAX}]`);
      }
      if (!isFiniteNumber(forward) || !isFiniteNumber(strafe)) return bad('移动轴无效');
      if (!isFiniteNumber(characterYaw)) return bad('characterYaw 无效');
      if (typeof jump !== 'boolean') return bad('jump 必须是布尔值');

      return {
        ok: true,
        msg: {
          t, seq, dt,
          // ★★ 钳制而不是拒绝：forward=999 是速度外挂，但也可能是手柄漂移
          forward: clampAxis(forward),
          strafe: clampAxis(strafe),
          // yaw 归一化到 [-π, π]，避免累积出巨大数值造成三角函数精度问题
          characterYaw: normalizeAngle(characterYaw),
          jump,
        },
      };
    }

    case 'SetTarget': {
      const slot = v['slot'];
      if (slot !== 'hard' && slot !== 'focus') return bad('slot 无效');
      const rawId = v['entityId'];
      if (rawId === null) return { ok: true, msg: { t, slot, entityId: null } };
      const entityId = parseEntityId(rawId);
      if (entityId === undefined) return bad('entityId 无效');
      return { ok: true, msg: { t, slot, entityId } };
    }

    case 'TabTarget': {
      const reverse = v['reverse'];
      if (typeof reverse !== 'boolean') return bad('reverse 必须是布尔值');
      return { ok: true, msg: { t, reverse } };
    }

    case 'CastRequest': {
      const skillId = v['skillId'];
      if (typeof skillId !== 'string' || skillId.length === 0) return bad('skillId 无效');

      const rawTarget = v['targetId'];
      let targetId: EntityId | undefined;
      if (rawTarget !== undefined) {
        targetId = parseEntityId(rawTarget);
        if (targetId === undefined) return bad('targetId 无效');
      }

      const rawGround = v['groundPoint'];
      let groundPoint: Vec3 | undefined;
      if (rawGround !== undefined) {
        groundPoint = parseVec3(rawGround);
        if (groundPoint === undefined) return bad('groundPoint 无效');
      }

      const rawFacing = v['facing'];
      let facing: number | undefined;
      if (rawFacing !== undefined) {
        if (!isFiniteNumber(rawFacing)) return bad('facing 无效');
        facing = normalizeAngle(rawFacing);
      }

      return {
        ok: true,
        msg: {
          t, skillId: asSkillId(skillId),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(groundPoint !== undefined ? { groundPoint } : {}),
          ...(facing !== undefined ? { facing } : {}),
        },
      };
    }

    case 'InteractStart': {
      const entityId = parseEntityId(v['entityId']);
      if (entityId === undefined) return bad('entityId 无效');
      return { ok: true, msg: { t, entityId } };
    }

    case 'SpectateFollow': {
      const entityId = parseEntityId(v['entityId']);
      if (entityId === undefined) return bad('entityId 无效');
      return { ok: true, msg: { t, entityId } };
    }

    case 'SwapWeapon':
    case 'SwapArmor':
    case 'UseConsumable': {
      const slot = v['slot'];
      // 10.6：最多 2 套备用 + 默认 = 索引 0..2；道具 2 个
      if (!isFiniteNumber(slot) || !Number.isInteger(slot) || slot < 0 || slot > 2) {
        return bad('slot 超出范围（0–2）');
      }
      return { ok: true, msg: { t, slot } };
    }

    // 无参数消息
    case 'LeaveMatch':
    case 'CancelCast':
    case 'UseTrinket':
    case 'InteractCancel':
      return { ok: true, msg: { t } };

    default:
      // ★ 走到这里说明 ALL_CLIENT_MESSAGE_KINDS 里有一项忘了写解析分支。
      //   `protocol.test.ts` 有一条断言遍历全部 kind，所以这个分支
      //   在测试里会被发现，而不是等到线上某个消息静默失效。
      return bad(`消息类型 ${t satisfies never} 缺少解析分支`);
  }
};

/** 把角度归一化到 [-π, π] */
export const normalizeAngle = (a: number): number => {
  const twoPi = Math.PI * 2;
  let x = a % twoPi;
  if (x > Math.PI) x -= twoPi;
  if (x < -Math.PI) x += twoPi;
  return x;
};

/**
 * 一个 tick 内消费输入的条数上限（`INPUT_LIMITS.INPUTS_PER_TICK_MAX`）。
 *
 * ★ 防的是「攒一堆输入一次性发」：客户端故意不发 1 秒，
 *   然后一次发 20 条 dt=0.05 的输入 —— 每条单独看都合法，
 *   但服务器若全部消费，这个玩家就在一个 tick 内走了 1 秒的距离。
 *
 * ★ 超出的部分**丢弃最旧的**而不是最新的：玩家的意图是「我现在要往哪走」，
 *   保留最新的更接近他的真实意图，也更难被利用（丢新的等于给了他延迟优势）。
 */
export const takeInputsForTick = <T>(queue: T[]): T[] => {
  if (queue.length <= INPUT_LIMITS.INPUTS_PER_TICK_MAX) {
    const all = [...queue];
    queue.length = 0;
    return all;
  }
  const kept = queue.slice(queue.length - INPUT_LIMITS.INPUTS_PER_TICK_MAX);
  queue.length = 0;
  return kept;
};
