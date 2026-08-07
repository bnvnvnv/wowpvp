/**
 * 新手引导的**纯逻辑核心**：步骤定义 + 推进规约（reducer）。docs/14 §M15。
 *
 * ★★ 与 `sim/stats.ts` 同一个设计：**纯折叠**。信号进来（事件流 + 每帧采样
 *   由 `TutorialDirector` 翻译成 `TutorialSignal`），状态出去，无副作用、
 *   无时钟依赖（时刻由信号携带）—— 所以整台状态机可以在 node 单测里
 *   一格一格拨着走，每一环的「不做对就不通过」都能写成断言。
 *
 * ★ 红线（docs/14 §M15）：**不动 sim 一行**。这里连 client 的战斗代码都
 *   不 import —— 只认信号。谁产生信号是 Director 的事。
 *
 * 课程结构（项目所有者拍板：不只教反制，要**完整**的任务教学）——
 * 十二环递进，完成一环亮下一环，顺序门控本身就是「提前做对也不算」的实现：
 *
 *   基础七环（怎么玩）：
 *     1 move      移动与跳跃
 *     2 camera    镜头环绕与缩放
 *     3 target    选中目标、读目标框
 *     4 firstCast 第一发读条技能（寒冰箭全流程）
 *     5 instant   瞬发与冷却（火焰冲击）
 *     6 ground    地面技能的落点预览与确认（5.5）
 *     7 defense   自保（冰霜新星 / 寒冰屏障）
 *   反制四环（怎么赢 —— 本作的核心博弈）：
 *     8 interrupt 打断法师读条 → 学派锁定
 *     9 locked    被战士打断 → 冰霜被锁 → 火焰还手
 *    10 feint     假读条骗拳击（7.5，本作灵魂）
 *    11 sidestep  站进陨石圈看倒计时走出去（14.3）
 *   毕业：
 *    12 graduate  低血量三假人速胜局
 */

/** 步骤推进只认这些信号。字段带**发生时刻**（sim 时钟），规约自己不看表 */
/**
 * 教学进度的 localStorage 键。★ 放在本文件（纯规约、零重依赖）——
 * 大厅要读它判断「教学做没做完」（W11），从 TutorialDirector 导入会把
 * 整个战斗指挥链拖进大厅 chunk。
 */
export const TUTORIAL_STORAGE_KEY = 'wowpvp.tutorial.v1';

export type TutorialSignal =
  // ── 采样类（Director 每帧折叠出来的里程碑）──
  | { t: 'moved'; meters: number }
  | { t: 'jumped' }
  | { t: 'cameraOrbited'; radians: number }
  | { t: 'cameraZoomed'; meters: number }
  | { t: 'targeted' }
  // ── 施法生命周期（玩家自己的）──
  | { t: 'playerCastStarted'; skillId: string; school: string; at: number }
  | { t: 'playerCastResolved'; skillId: string; school: string; at: number }
  | { t: 'playerCastCancelled'; skillId: string; at: number }
  /** 玩家的读条被打断（战士拳击）。lockedSchool 是被锁的学派 */
  | { t: 'playerInterrupted'; skillId: string; lockedSchool: string; lockUntil: number; at: number }
  // ── 打断与拳击 ──
  /** interrupt 战斗事件：sourceId 已由 Director 翻译成「是不是玩家干的」 */
  | { t: 'interruptLanded'; byPlayer: boolean; targetWasMageDummy: boolean; at: number }
  /** 战士假人挥出拳击的瞬间玩家**不在**读条（骗到了）/ 在读条（没骗到） */
  | { t: 'pummelSwung'; playerWasCasting: boolean; at: number }
  // ── 陨石环（Director 从地面区域状态采样）──
  | { t: 'meteorZoneEntered'; at: number }
  /** 陨石落地。playerInside = 落地瞬间玩家还在圈内 */
  | { t: 'meteorImpact'; playerInside: boolean; enteredBefore: boolean; at: number }
  // ── 毕业环 ──
  | { t: 'dummyDied'; entityId: number; at: number };

export type StepId =
  | 'move' | 'camera' | 'target' | 'firstCast' | 'instant' | 'ground' | 'defense'
  | 'interrupt' | 'locked' | 'feint' | 'sidestep' | 'graduate';

export const STEP_ORDER: readonly StepId[] = [
  'move', 'camera', 'target', 'firstCast', 'instant', 'ground', 'defense',
  'interrupt', 'locked', 'feint', 'sidestep', 'graduate',
];

export interface StepDef {
  id: StepId;
  title: string;
  /** 任务面板上的做法说明（写给玩家的人话）*/
  goal: string;
  /** 这一环教会的事 —— 完成时展示 */
  lesson: string;
  /** 有子勾的环在面板上逐项打勾 */
  subGoals?: readonly { key: string; label: string }[];
}

export const STEPS: readonly StepDef[] = [
  {
    id: 'move',
    title: '移动',
    goal: '用 W/S 前进后退、A/D 转向（按住右键时变侧移）走出 5 米，再按空格跳一次。',
    lesson: '后退只有 65% 速度 —— 想拉开距离要转身跑，不要倒着走。',
    subGoals: [
      { key: 'walk', label: '移动 5 米' },
      { key: 'jump', label: '跳跃一次' },
    ],
  },
  {
    id: 'camera',
    title: '镜头',
    goal: '按住左键拖动环绕镜头（注意角色朝向不变），再用滚轮拉近拉远。',
    lesson: '左键只转镜头、右键才转人 —— 边贴柱子边用左键看背后，是走位的基本功。',
    subGoals: [
      { key: 'orbit', label: '左键拖动环绕镜头' },
      { key: 'zoom', label: '滚轮缩放视距' },
    ],
  },
  {
    id: 'target',
    title: '选中目标',
    goal: '按 Tab（或直接点击）选中一个假人。看屏幕上方的目标框：血量、职业、它正在读的条。',
    lesson: '目标框会显示对方施法条与可否打断 —— 后面的每一环都从「看清目标在做什么」开始。',
  },
  {
    id: 'firstCast',
    title: '第一发技能',
    goal: '选中任一假人，按 1 读一发寒冰箭：读条 → 出手 → 命中减速。',
    lesson: '读条期间移动会自行取消 —— 站稳再读，这也是它能被打断的原因。',
  },
  {
    id: 'instant',
    title: '瞬发与冷却',
    goal: '按 2 打一发火焰冲击（瞬发），然后看技能栏上的冷却转圈 —— 转完之前按它没用。',
    lesson: '瞬发不能被打断，但有冷却；读条伤害高但有风险 —— 两类技能的取舍贯穿全部职业。',
  },
  {
    id: 'ground',
    title: '地面技能',
    goal: '按 6（暴风雪）进入落点预览，把圈移到假人脚下，左键确认。墙后与超距的落点会变成虚线加叉。',
    lesson: '落点非法时按不下去（虚线+叉号）；拖到 30 米外会被钳回边缘 —— 指示器不会骗你。',
  },
  {
    id: 'defense',
    title: '自保',
    goal: '被贴脸时的保命键：按 5 冰霜新星把身边敌人定住，或按 8 寒冰屏障免疫一切。任选一个放出来。',
    lesson: '每个职业都有保命技 —— 输出与保命的按键都要长在肌肉记忆里。',
  },
  {
    id: 'interrupt',
    title: '打断对手',
    goal: '远处的假人·法师在反复读条。选中它，等它读条到一半时按 3（法术反制）打断。',
    lesson: '打断成功会把对方**同一系的技能**整组封锁 3 秒 —— 它这段时间放不出任何冰霜技能。',
  },
  {
    id: 'locked',
    title: '被打断的代价',
    goal: '走到假人·战士身边（3 米内）读一发寒冰箭 —— 故意让它打断你。冰霜被锁的几秒里，按 2 用火焰冲击还手。',
    lesson: '封锁只罩住**一个系**：冰霜被封时火焰照常能用。被打断不等于什么都不能做。',
  },
  {
    id: 'feint',
    title: '假读条（本作的灵魂）',
    goal: '还是站在战士身边：起手读寒冰箭，**立刻按 Esc 取消**。它的拳击会挥空 —— 而拳击落空也照进 15 秒冷却。',
    lesson: '骗掉对方的打断，接下来 15 秒你可以放心读任何条 —— 这就是 7.5 的博弈。',
  },
  {
    id: 'sidestep',
    title: '走位反制',
    goal: '假人·法师会往你脚下丢一颗陨石。站在圈里看倒计时数字，在落地前走出圈外。',
    lesson: '所有地面技能的落点和倒计时全程可见 —— 看得见就躲得开。',
  },
  {
    id: 'graduate',
    title: '毕业考：3 打 1',
    goal: '三个假人的血量已经调低。用你学到的一切打倒它们（顺序随意）。',
    lesson: '打断牧师的治疗、骗掉战士的拳击、躲开法师的陨石 —— 反制链就是这个游戏。',
  },
];

export const STEP_BY_ID: ReadonlyMap<StepId, StepDef> = new Map(STEPS.map((s) => [s.id, s]));

// ── 状态 ─────────────────────────────────────────────────────────

export interface TutorialState {
  /** 已完成的步骤 */
  done: StepId[];
  /** 当前步骤（全部完成后为 null）*/
  current: StepId | null;
  /** 子勾进度 */
  moveGoals: { walk: boolean; jump: boolean };
  cameraGoals: { orbit: boolean; zoom: boolean };
  /** 累计量（阈值判定用）*/
  movedMeters: number;
  orbitedRadians: number;
  zoomedMeters: number;
  /** locked 环：被打断后记住锁的学派与截止时刻 */
  lockedSchool: string | null;
  lockUntil: number;
  /** feint 环：最近一次「起手→取消」的取消时刻（拳击落空要发生在其后不久）*/
  cancelledAt: number | null;
  /** sidestep 环：这一轮陨石是否进过圈 */
  enteredMeteorZone: boolean;
  /** graduate 环：已倒下的假人 id 集合 */
  killedDummies: number[];
}

export const initialTutorialState = (doneFromStorage: StepId[] = []): TutorialState => {
  // 存档只认合法且**前缀连续**的完成序列 —— 中间跳步的存档按最长合法前缀截断
  const done: StepId[] = [];
  for (const id of STEP_ORDER) {
    if (doneFromStorage.includes(id)) done.push(id);
    else break;
  }
  return {
    done,
    current: STEP_ORDER[done.length] ?? null,
    moveGoals: { walk: false, jump: false },
    cameraGoals: { orbit: false, zoom: false },
    movedMeters: 0,
    orbitedRadians: 0,
    zoomedMeters: 0,
    lockedSchool: null,
    lockUntil: 0,
    cancelledAt: null,
    enteredMeteorZone: false,
    killedDummies: [],
  };
};

/** 移动子勾的达标距离，米 */
export const MOVE_METERS = 5;
/** 镜头子勾的达标弧度（约 60°）*/
export const ORBIT_RADIANS = 1.0;
/** 缩放子勾的达标距离变化量，米 */
export const ZOOM_METERS = 2.0;
/** 拳击落空要发生在取消后的这个窗口内才算「骗到」，秒 */
export const FEINT_WINDOW_SECONDS = 2.5;

/** 各环认可的技能（法师栏位：1 寒冰箭 2 火冲 3 反制 4 变形 5 新星 6 暴雪 7 陨石 8 冰屏障）*/
export const FIRST_CAST_SKILL = 'mage.frostbolt';
export const INSTANT_SKILL = 'mage.fire_blast';
export const GROUND_SKILLS: readonly string[] = ['mage.blizzard', 'mage.meteor'];
export const DEFENSE_SKILLS: readonly string[] = ['mage.frost_nova', 'mage.ice_block'];

// ── 推进规约 ─────────────────────────────────────────────────────

const completeCurrent = (s: TutorialState): TutorialState => {
  if (s.current === null) return s;
  const done = [...s.done, s.current];
  return { ...s, done, current: STEP_ORDER[done.length] ?? null };
};

/**
 * 把一个信号折叠进状态。**只有当前步骤消费信号** —— 顺序门控就是
 * 「提前做对了也不算、做错了不推进」的全部实现（verify:m15 的否定式
 * 断言直接建立在这上面）。
 */
export const advanceTutorial = (s: TutorialState, sig: TutorialSignal): TutorialState => {
  switch (s.current) {
    case 'move': {
      const g = { ...s.moveGoals };
      let { movedMeters } = s;
      if (sig.t === 'moved') {
        movedMeters += sig.meters;
        if (movedMeters >= MOVE_METERS) g.walk = true;
      }
      if (sig.t === 'jumped') g.jump = true;
      const next = { ...s, moveGoals: g, movedMeters };
      return g.walk && g.jump ? completeCurrent(next) : next;
    }

    case 'camera': {
      const g = { ...s.cameraGoals };
      let { orbitedRadians, zoomedMeters } = s;
      if (sig.t === 'cameraOrbited') {
        orbitedRadians += sig.radians;
        if (orbitedRadians >= ORBIT_RADIANS) g.orbit = true;
      }
      if (sig.t === 'cameraZoomed') {
        zoomedMeters += sig.meters;
        if (zoomedMeters >= ZOOM_METERS) g.zoom = true;
      }
      const next = { ...s, cameraGoals: g, orbitedRadians, zoomedMeters };
      return g.orbit && g.zoom ? completeCurrent(next) : next;
    }

    case 'target':
      return sig.t === 'targeted' ? completeCurrent(s) : s;

    case 'firstCast':
      // ★ 必须是读完的寒冰箭 —— 瞬发糊脸不教「读条要站稳」这一课
      return sig.t === 'playerCastResolved' && sig.skillId === FIRST_CAST_SKILL
        ? completeCurrent(s)
        : s;

    case 'instant':
      return sig.t === 'playerCastResolved' && sig.skillId === INSTANT_SKILL
        ? completeCurrent(s)
        : s;

    case 'ground':
      return sig.t === 'playerCastResolved' && GROUND_SKILLS.includes(sig.skillId)
        ? completeCurrent(s)
        : s;

    case 'defense':
      return sig.t === 'playerCastResolved' && DEFENSE_SKILLS.includes(sig.skillId)
        ? completeCurrent(s)
        : s;

    case 'interrupt':
      // ★ 必须是**玩家**打断了**法师假人**：战士替你打断了谁都不算
      return sig.t === 'interruptLanded' && sig.byPlayer && sig.targetWasMageDummy
        ? completeCurrent(s)
        : s;

    case 'locked': {
      if (sig.t === 'playerInterrupted') {
        // 被打断，记住锁：进入「锁定期内还手」的后半环
        return { ...s, lockedSchool: sig.lockedSchool, lockUntil: sig.lockUntil };
      }
      if (
        sig.t === 'playerCastResolved' &&
        s.lockedSchool !== null &&
        sig.at < s.lockUntil &&
        sig.school !== s.lockedSchool
      ) {
        // 锁没过期时用**另一个学派**打出去了 —— 知识点成立
        return completeCurrent({ ...s, lockedSchool: null });
      }
      return s;
    }

    case 'feint': {
      if (sig.t === 'playerCastCancelled') {
        return { ...s, cancelledAt: sig.at };
      }
      if (
        sig.t === 'pummelSwung' &&
        !sig.playerWasCasting &&
        s.cancelledAt !== null &&
        sig.at - s.cancelledAt <= FEINT_WINDOW_SECONDS
      ) {
        // 取消在先、拳击落空在后、且就在刚才 —— 这一拳是被你骗出来的
        return completeCurrent({ ...s, cancelledAt: null });
      }
      // ★ 否定路径：被打断（没取消）或直接读完 —— 都不推进
      return s;
    }

    case 'sidestep': {
      if (sig.t === 'meteorZoneEntered') return { ...s, enteredMeteorZone: true };
      if (sig.t === 'meteorImpact') {
        // ★ 必须「进过圈」而且「落地时在圈外」：从头到尾站外面看戏不算学会走位
        const passed = sig.enteredBefore && !sig.playerInside;
        return passed
          ? completeCurrent({ ...s, enteredMeteorZone: false })
          : { ...s, enteredMeteorZone: false }; // 没躲开：这一轮作废，等下一颗
      }
      return s;
    }

    case 'graduate': {
      if (sig.t !== 'dummyDied') return s;
      if (s.killedDummies.includes(sig.entityId)) return s;
      const killed = [...s.killedDummies, sig.entityId];
      const next = { ...s, killedDummies: killed };
      return killed.length >= 3 ? completeCurrent(next) : next;
    }

    default:
      return s; // 全部完成后不再消费任何信号
  }
};
