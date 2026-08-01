/**
 * 竞技场对局调度器。把 M5 的回合系统接到客户端。
 *
 * 与 `CombatDirector`（试验场）的关键区别：
 *   试验场   —— 死亡后立刻满血复活，方便反复测移动/镜头/技能
 *   竞技场   —— **死亡即淘汰**（11.4：当前回合死亡后不能普通复活、跑尸或被战斗复活）
 *
 * ⚠️ M5 这里仍是**本地模拟**。M5 的服务器部分（房间 + 权威 tick）还没做，
 *   见 docs/PROGRESS.md。战斗规则全在 shared/sim 里，接服务器时这个类只需
 *   把「自己算」换成「读快照」。
 */

import {
  ArenaPreset,
  GameMode,
  RoundPhase,
  School,
  TEAM_BLUE,
  TEAM_RED,
  aliveCount,
  arena3v3,
  createArena,
  createAuraStore,
  createCastingStore,
  createDrStore,
  createEntity,
  createGroundStore,
  createProjectileStore,
  createWorld,
  dealDamage,
  deriveStatusFlags,
  getClass,
  listEntities,
  resetRound,
  setDampening,
  startNextRound,
  tickArena,
  tickAuras,
  tickGround,
  tickProjectiles,
  addEntity,
  allocEntityId,
  asClassId,
  type ArenaState,
  type CombatEntity,
  type CombatEvent,
  type MapDef,
  type TeamId,
  type World,
} from '@wowpvp/shared';

export interface ArenaRosterEntry {
  name: string;
  classId: string;
  team: TeamId;
}

export interface ArenaLogEntry {
  time: number;
  text: string;
  kind: 'ok' | 'fail' | 'interrupt' | 'info';
}

/**
 * 一局竞技场。用于在客户端演示 M5 的回合流程 ——
 * 目前双方都是脚本控制的假人，玩家可以观战整局的推进。
 */
export class ArenaDirector {
  readonly world: World;
  readonly arena: ArenaState;
  readonly map: MapDef;
  readonly auras = createAuraStore();
  readonly dr = createDrStore();
  readonly projectiles = createProjectileStore();
  readonly ground = createGroundStore();
  readonly casting = createCastingStore();
  readonly log: ArenaLogEntry[] = [];

  constructor(
    map: MapDef = arena3v3,
    mode: GameMode = GameMode.Arena3v3,
    roster: ArenaRosterEntry[] = DEFAULT_ROSTER,
    opts: { roundsToWin?: number; duration?: number; preset?: ArenaPreset } = {},
  ) {
    this.map = map;
    this.world = createWorld(map.geometry);
    this.arena = createArena({
      mode,
      roundsToWin: opts.roundsToWin ?? 1,
      ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    });

    // 按地图的出生点摆人
    const spawnsByTeam = new Map<number, { position: { x: number; y: number; z: number }; yaw: number }[]>();
    for (const room of map.prepRooms ?? []) {
      spawnsByTeam.set(room.team as number, room.spawns.map((s) => ({ position: s.position, yaw: s.yaw })));
    }

    const used = new Map<number, number>();
    for (const entry of roster) {
      const cls = getClass(asClassId(entry.classId));
      if (!cls) continue;
      const teamKey = entry.team as number;
      const idx = used.get(teamKey) ?? 0;
      used.set(teamKey, idx + 1);
      const spawn = spawnsByTeam.get(teamKey)?.[idx];
      const e = addEntity(
        this.world,
        createEntity(
          allocEntityId(this.world),
          cls,
          entry.team,
          spawn?.position ?? { x: 0, y: 0, z: 0 },
          { name: entry.name, yaw: spawn?.yaw ?? 0 },
        ),
      );
      // 回合开始按 9.x 的初始资源
      for (const [r, max] of e.maxResources) e.resources.set(r, r === 'rage' || r === 'comboPoints' ? 0 : max);
    }

    this.push(
      `${map.name}：${roster.length} 名玩家入场，准备阶段开始（11.1）`,
      'info',
    );
  }

  private push(text: string, kind: ArenaLogEntry['kind']): void {
    this.log.unshift({ time: this.world.time, text, kind });
    if (this.log.length > 40) this.log.pop();
  }

  update(dt: number): void {
    this.world.time += dt;

    // 效果系统的每 tick 推进（与 CombatDirector 相同的顺序，见 docs/02 §3）
    for (const t of tickAuras(this.auras, this.world.time).ticks) void t;
    tickProjectiles(this.world, this.projectiles, dt);
    tickGround(this.world, this.ground);
    for (const e of listEntities(this.world)) e.flags = deriveStatusFlags(this.auras, e);

    // ★ 回合系统必须在死亡结算之后 —— 它读的是 CombatEntity.alive
    tickArena(this.arena, this, dt, {
      onPhaseChange: (from, to) => {
        if (to === RoundPhase.Combat) this.push('大门开启，战斗开始（11.1）', 'ok');
        if (to === RoundPhase.Resolved) this.push('回合结束', 'info');
      },
      onRoundEnd: (outcome, round) => {
        const text =
          outcome.winner === 'draw'
            ? `第 ${round} 回合 —— 平局（双方最后一人在同一结算窗口内死亡，2.1）`
            : `第 ${round} 回合 —— ${teamName(outcome.winner)}获胜`;
        this.push(text, outcome.winner === 'draw' ? 'interrupt' : 'ok');
      },
      onMatchEnd: (winner) => this.push(`比赛结束：${teamName(winner)}获胜`, 'ok'),
      onPressureDamage: (amount) => this.applyPressureDamage(amount),
    });

    // 8.5：把抑制交给效果层。它只影响治疗与吸收，不影响伤害
    setDampening({ amount: this.arena.dampening.amount });
  }

  /**
   * 8.5 / 验收 #27：竞技场压迫伤害**不可完全免疫**。
   *
   * ★ `bypassImmunity: true` 是这条规则的全部实现 ——
   *   少了它，圣盾术和寒冰屏障能把决胜阶段无限拖下去。
   */
  private applyPressureDamage(amount: number): void {
    const events: CombatEvent[] = [];
    const ctx = {
      world: this.world, auras: this.auras, dr: this.dr,
      projectiles: this.projectiles,
      groundAreas: this.ground.areas, traps: this.ground.traps,
      castingStore: this.casting,
      source: listEntities(this.world)[0]!, // 压迫伤害没有来源，借用任意实体做上下文
      skillId: 'arena.pressure',
      events,
      resolve: () => {},
    };
    for (const e of listEntities(this.world)) {
      if (!e.alive || e.isPet) continue;
      // canCrit:false —— 压迫伤害是赛制机制不是攻击，让它暴击等于让赛制随机
      dealDamage(ctx, e, amount, School.Physical, { bypassImmunity: true, canCrit: false });
    }
    for (const ev of events) {
      if (ev.t === 'death') {
        const victim = this.world.entities.get(ev.targetId);
        this.push(`${victim?.name ?? '?'} 被竞技场压迫伤害击杀`, 'interrupt');
      }
    }
  }

  /** 2.1 / 验收 #37：开始下一回合，清空全部临时状态 */
  nextRound(): void {
    startNextRound(this.arena, this);
    this.push(`第 ${this.arena.round} 回合开始（生命、资源、冷却、光环全部重置）`, 'info');
  }

  /** 重开当前回合 */
  restart(): void {
    resetRound(this.arena, this);
    this.push('回合已重置', 'info');
  }

  // ── 供 HUD 读取 ─────────────────────────────────────────────

  get scoreboard(): { red: number; blue: number } {
    return {
      red: this.arena.score[String(TEAM_RED)] ?? 0,
      blue: this.arena.score[String(TEAM_BLUE)] ?? 0,
    };
  }

  get aliveByTeam(): { red: number; blue: number } {
    return {
      red: aliveCount(this.world, TEAM_RED),
      blue: aliveCount(this.world, TEAM_BLUE),
    };
  }

  players(): CombatEntity[] {
    return listEntities(this.world).filter((e) => !e.isPet);
  }
}

const teamName = (t: TeamId): string => ((t as number) === (TEAM_RED as number) ? '红方' : '蓝方');

/** 默认演示阵容：3v3，双方各一治疗两输出 */
export const DEFAULT_ROSTER: ArenaRosterEntry[] = [
  { name: '红·战士', classId: 'warrior', team: TEAM_RED },
  { name: '红·法师', classId: 'mage', team: TEAM_RED },
  { name: '红·牧师', classId: 'priest', team: TEAM_RED },
  { name: '蓝·盗贼', classId: 'rogue', team: TEAM_BLUE },
  { name: '蓝·猎人', classId: 'hunter', team: TEAM_BLUE },
  { name: '蓝·圣骑士', classId: 'paladin', team: TEAM_BLUE },
];
