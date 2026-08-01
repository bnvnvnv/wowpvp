/**
 * 试验场里的夺旗演示。规格书 12.x 的**客户端接线**，验收 #38–#43 / #49 的人工载体。
 *
 * ★ 为什么需要它：M7 把夺旗规则全做在 `shared/sim/match/flag.ts` 里，
 *   跑的是单元测试和 `verify:m7` 的纯逻辑模拟 —— 规则是对的，
 *   但**从来没有一个人用鼠标键盘拔过一次旗**。
 *   15.4 的夺旗 HUD、小地图旗帜标记、验收 #49 的「最远镜头下旗手清晰」
 *   全都要真的有一面旗在场上才能验。
 *
 * ⚠️ 这是**试验场演示**，不是正式比赛。它刻意做得很薄：
 *   两面旗放在试验场地图的固定位置，没有复活波次、没有比分上限判负、
 *   没有交旗区几何（用基地半径 6 米近似）。
 *   正式的夺旗对局跑在 `ctf_twin_bridges` 地图上，由服务器驱动（M9 之后）。
 *   所有旗帜状态转移**仍然走 `flag.ts` 的同一套函数** —— 这里不重新实现任何规则。
 */

import {
  FlagState,
  TEAM_BLUE,
  TEAM_RED,
  beginFlagInteract,
  createCtf,
  ctfWinner,
  dropFlagBeforeSkill,
  flagOf,
  flagViews,
  tickFlags,
  type CombatEntity,
  type CtfState,
  type FlagView,
  type TeamId,
  type Vec3,
  type World,
} from '@wowpvp/shared';

/**
 * 两面旗在试验场里的位置。
 *
 * 刻意都放在出生点两侧的开阔地上（各 11 米），不放到场地另一端 ——
 * 试验场中间有建筑，直线跑过去会撞墙，而这里要验的是**旗帜状态机**，
 * 不是寻路。走两步就能拔到旗，才能在一分钟内把七个状态都过一遍。
 */
const RED_BASE: Vec3 = { x: -11, y: 0, z: 28 };
const BLUE_BASE: Vec3 = { x: 11, y: 0, z: 28 };
/** 交旗区半径（米）。试验场用圆形近似，正式地图用旗帜房体积 */
const ZONE_RADIUS = 6;

export class CtfDemo {
  readonly ctf: CtfState;
  /** 最近一次交互结果，供 HUD 提示 */
  lastMessage: string | null = null;
  private messageUntil = 0;

  constructor(private readonly world: World) {
    this.ctf = createCtf(RED_BASE, BLUE_BASE, 3);
  }

  get redBase(): Vec3 {
    return RED_BASE;
  }
  get blueBase(): Vec3 {
    return BLUE_BASE;
  }

  private inZone(team: TeamId, p: Vec3): boolean {
    const base = (team as number) === (TEAM_RED as number) ? RED_BASE : BLUE_BASE;
    return Math.hypot(p.x - base.x, p.z - base.z) <= ZONE_RADIUS;
  }

  /** 每 tick 推进。★ 必须在移动与死亡结算**之后**调用（12.2）*/
  tick(now: number): void {
    tickFlags(
      this.ctf,
      {
        world: this.world,
        captureZoneContains: (team, p) => this.inZone(team, p),
        isLegalPosition: (p) => p.y > -4,
      },
      now,
    );
    if (this.lastMessage && now > this.messageUntil) this.lastMessage = null;
  }

  /**
   * 玩家按下交互键。自动判断是拔旗、归还还是交旗 ——
   * 判断逻辑在 `beginFlagInteract` 里，这里只负责传参和显示结果。
   */
  interact(player: CombatEntity, now: number): void {
    // 先试敌方旗（拔旗/交旗），再试己方旗（归还）
    const targets = [flagOf(this.ctf, TEAM_BLUE), flagOf(this.ctf, TEAM_RED)];
    for (const flag of targets) {
      const r = beginFlagInteract(this.ctf, player, flag, now, (p) =>
        this.inZone(player.team, p),
      );
      if (r.ok) {
        this.say(
          { pickup: '开始拔旗', return: '开始归还', capture: '开始交旗' }[r.action],
          now,
        );
        return;
      }
    }
    // 全都失败时报最近的那个原因 —— 比"什么都没发生"有用得多
    const r = beginFlagInteract(this.ctf, player, targets[0]!, now, (p) =>
      this.inZone(player.team, p),
    );
    if (!r.ok) this.say(r.reason, now);
  }

  /** ★ 12.3 / 验收 #40：使用无敌/潜行技能前先掉旗 */
  onSkillThatDropsFlag(player: CombatEntity, now: number): void {
    if (dropFlagBeforeSkill(this.ctf, player, now)) this.say('旗帜掉落（12.3）', now);
  }

  private say(text: string, now: number): void {
    this.lastMessage = text;
    this.messageUntil = now + 2.5;
  }

  views(): FlagView[] {
    return flagViews(this.ctf, this.world);
  }

  scoreOf(team: TeamId): number {
    return this.ctf.score[String(team as number)] ?? 0;
  }

  get winner(): TeamId | null {
    return ctfWinner(this.ctf);
  }

  /** 掉落在地上的旗，小地图要永久显示（15.4）*/
  droppedFlags(): FlagView[] {
    return this.views().filter((v) => v.state === FlagState.Dropped);
  }

  /** 正在被携带的旗，小地图要永久显示旗手（15.4 / 12.2 不受潜行影响）*/
  carriedFlags(): FlagView[] {
    return this.views().filter((v) => v.state === FlagState.Carried);
  }
}
