/**
 * A11：**死后的输入闸门**。
 *
 * ★★ 这个文件存在的理由是一条实测出来的脏路径：死掉之后客户端照常
 *   每 tick 发移动指令、照常发施法/切目标请求，服务器每一条都静默拒绝。
 *   服务器那边是对的（权威判定只有一处），但客户端这边是**两件坏事**：
 *   ① 一整段死亡时间里的指令帧全是白发的；
 *   ② 玩家按 W 角色不动、按 1 技能不响，而屏幕上没有任何东西解释为什么 ——
 *   「按了没反应」这条老毛病在死亡状态下又活了一次。
 *
 * ★★ **允许清单而不是禁止清单**，这是本文件唯一的设计决定：
 *   将来新增一个动作（比如「使用战场道具」），如果写成禁止清单，
 *   它默认是**放行**的 —— 也就是默认多一条死人能发的战斗指令，
 *   而且没有任何测试会红。写成允许清单，新动作默认被挡住，
 *   要放行必须有人显式加进来并说明理由。
 *
 * ★ 允许清单里全是**不影响世界状态**的键：观战、镜头、面板、音量、画质。
 *   它们在死亡界面上恰恰是玩家最需要的（11.4：死后看队友怎么打）。
 *
 * ⚠️ 本闸门只管**客户端不发**。真正的门禁仍在服务器（`MatchLoop` 对死者的
 *   请求一律拒绝），这里少拦一个不会破坏规则，多拦一个才会让活人按不了键 ——
 *   所以 `alive` 的判断口径是「快照里的自己」，不是任何本地记账（见调用方）。
 */

import { Action, type FrameInput } from './InputManager.js';

/**
 * 死亡期间仍然放行的动作。
 *
 * ★ 逐条的理由：
 *   · `SpectateNext`  —— 11.4 的观战轮换，死亡界面上唯一的正事
 *   · `CameraReset`   —— 镜头是观察工具，死了也要能摆正
 *   · `CancelCast`    —— Esc 在这里只剩「关掉面板」这一个含义
 *                        （真的取消读条那一发由调用方另行按 alive 挡住）
 *   · `ToggleShop`    —— P13 大乱斗积分商店：等复活的这几秒正是花分的时候
 *   · 其余四个        —— 记分板/设置/静音/画质，纯本地 UI
 *   · `ToggleDebug` / `CycleColorblind` / `CycleUiScale` —— 同上，观察与无障碍
 *
 * ⚠️ 技能键 1–9 **不在**清单里。它们在商店展开时兼任「买货」，那条路径由
 *   调用方直接读**未过闸**的原始输入（见 `NetworkScene.readInput` 的注释）——
 *   放进清单会连带把施法也放行，那正是本文件要挡的东西。
 */
export const DEAD_ALLOWED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  Action.SpectateNext,
  Action.CameraReset,
  Action.CancelCast,
  Action.ToggleShop,
  Action.ToggleScoreboard,
  Action.OpenSettings,
  Action.ToggleMute,
  Action.CycleQuality,
  Action.ToggleDebug,
  Action.CycleColorblind,
  Action.CycleUiScale,
]);

/**
 * 活着原样放行，死了只留下允许清单里的那几样。
 *
 * ★★ `alive` 为真时返回的是**同一个对象**（不是拷贝）——
 *   默认路径上这个函数等价于不存在，141 项验收的载体一个字节都不变。
 *
 * ★ 死亡时移动量全部归零（不是「不发」而是「表达为不动」）：本地预测
 *   同样吃这份输入，归零之后尸体不会因为玩家还压着 W 而在原地推。
 * ★ 镜头三件事（滚轮/左右拖）原样保留 —— 它们压根不进网络，只动本地相机。
 * ★ `selfCastHeld` 归假：它是施法修饰键，死了没有任何施法可修饰。
 */
export const gateInputWhenDead = (input: FrameInput, alive: boolean): FrameInput => {
  if (alive) return input;
  return {
    ...input,
    forward: 0,
    strafe: 0,
    turn: 0,
    jump: false,
    selfCastHeld: false,
    pressed: new Set([...input.pressed].filter((a) => DEAD_ALLOWED_ACTIONS.has(a))),
  };
};
