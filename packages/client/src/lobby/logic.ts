/**
 * 大厅的**纯逻辑**：房间码、昵称、名单视图、准备门禁的文案。docs/14 §M13。
 *
 * ★ 与 `LobbyShell`（DOM 与连接）分开的理由和 HUD 一样：客户端单测跑在
 *   node 环境里没有 DOM，能测的只有纯函数 —— 所以「会出错的判断」都放这边。
 *
 * ★ 这里的一切只是 **UI 判据**：房间能不能进、职业选没选、准备算不算数，
 *   最终都由服务器用 `room.ts` 的规则再判一遍（M13 红线：UI 只发意图）。
 *   例如 `readyBlocker()` 的文案与 `setReady()` 的拒绝理由说的是同一件事 ——
 *   这里判了只是省一次往返，漏判也只是多收一条 Rejected。
 */

import type { RoomPlayerView } from '@wowpvp/shared';

/**
 * 房间码字符表：去掉了易混字形（0/O、1/I/L、8/B）。
 * 房间码的用途是**口头/截图转达**——「我房间是 K7XQ」——混淆一个字符
 * 就进错房，而进错房的表现是「房间里没人」，最难查的一类。
 */
export const ROOM_CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ234567 9'.replace(/ /g, '');

/** 4 位 × 29 字符 ≈ 70 万空间。小体量联机够用，撞了也只是进到别人房间里看见人 */
export const ROOM_CODE_LENGTH = 4;

/** 生成房间码。`rand` 可注入，测试用确定性序列 */
export const makeRoomCode = (rand: () => number = Math.random): string => {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.min(ROOM_CODE_ALPHABET.length - 1, Math.floor(rand() * ROOM_CODE_ALPHABET.length));
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
};

/**
 * 规范化用户敲进来的房间码：去空白、大写。
 * ★ 不按字符表过滤 —— 服务器接受任意 roomId 字符串（`?net=` 老路就在用
 *   `r1` 这类小写码），过滤会让「朋友发来的老式房间名」进不去。
 */
export const normalizeRoomCode = (raw: string): string => raw.trim().toUpperCase();

/** 房间码是否可提交（非空、不超长）。长度上限只防手滑粘贴整句话 */
export const isJoinableCode = (code: string): boolean =>
  code.length >= 1 && code.length <= 16;

/** 昵称：去空白、截到 12 字符；空的交给调用方给默认值 */
export const sanitizeName = (raw: string): string => raw.trim().slice(0, 12);

/** 名单按席位分组（3.1：红 / 蓝 / 观战席）*/
export interface RosterVM {
  red: RoomPlayerView[];
  blue: RoomPlayerView[];
  spectators: RoomPlayerView[];
}

export const splitRoster = (players: readonly RoomPlayerView[]): RosterVM => ({
  red: players.filter((p) => p.team === 'red'),
  blue: players.filter((p) => p.team === 'blue'),
  spectators: players.filter((p) => p.team === 'spectator'),
});

/**
 * 「准备」按钮此刻按不下去的原因；null = 可以准备。
 * ★ 文案与服务器 `setReady()` 的拒绝理由一一对应 —— 这里只是把
 *   「按了才知道」提前成「看着就明白」，不是第二套规则。
 */
export const readyBlocker = (self: RoomPlayerView | undefined): string | null => {
  if (!self) return '尚未加入房间';
  if (self.team === 'spectator') return '先加入一个阵营（观战席不需要准备）';
  if (!self.classId) return '先选择职业';
  return null;
};

/** 分享链接：`?lobby=<码>`，显式指定过服务器地址时一并带上 */
export const shareLink = (
  origin: string,
  pathname: string,
  code: string,
  serverUrl?: string,
): string => {
  const params = new URLSearchParams();
  params.set('lobby', code);
  if (serverUrl) params.set('server', serverUrl);
  return `${origin}${pathname}?${params.toString()}`;
};

/** 席位显示名 */
export const teamLabel = (team: RoomPlayerView['team']): string =>
  team === 'red' ? '红方' : team === 'blue' ? '蓝方' : '观战席';

/**
 * HTML 转义。名单里的**玩家名是不受信任的输入**（对面浏览器发什么就是什么），
 * 直接拼进 innerHTML 等于让任何进房的人在你屏幕上执行脚本。
 * HUD 的姓名板用的是 textContent 所以没这个问题；大厅用模板串拼名单，必须过这里。
 */
/**
 * P6：是不是本地开发环境。用户拍板：「自测的可以根据 IP 判断，
 * 比如本地 IP 才会展示这个窗口」—— 入口页的「验收试验场/压测台」
 * 工具组只在本地渲染，生产域名下不出现。
 * ★ 纯 hostname 判断，不是安全边界（?testbed 直敲仍可达）——
 *   它挡的是**误导**（普通玩家不该看到验收工具），不是访问。
 */
export const isLocalDev = (hostname: string = location.hostname): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
  hostname === '[::1]';

export const escapeHtml = (raw: string): string =>
  raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
