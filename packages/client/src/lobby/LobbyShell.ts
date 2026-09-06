/**
 * 大厅：标题页 → 建/加房 → 房间页（选阵营/职业/准备）→ 对局 → 回房间。
 * docs/14 §M13 —— 「把链接发给朋友，他不需要任何说明就能进到同一场对局里」。
 *
 * ★★ 三条红线（docs/14 §M13），每条在这里的落点：
 *   · `?net=` / `?art=` 等既有参数原样保留 —— 本模块只在 `?lobby` 分支被
 *     动态 import（main.ts），老路一个字节没动
 *   · 只发协议里**已有**的消息：JoinRoom / SelectTeam / SelectClass /
 *     SetReady / LeaveMatch。零新消息类型 —— 建房就是「加入一个不存在的
 *     房间」（服务器 onJoin 本来就会创建），房间码由客户端生成
 *   · 服务器仍校验一切 —— 这里的每个按钮只是发意图，能不能（队满、
 *     没选职业、观战席准备）由服务器的 room.ts 规则说了算，被拒绝就
 *     toast 出来。`logic.ts` 里的门禁文案只是把「按了才知道」提前
 *
 * ★ 连接归大厅所有，跨越房间与战斗两个阶段。对局的 3D 场景（NetworkScene）
 *   **每场重建**：MatchStart 时新建画布与场景（借用本连接，见 NetLink），
 *   MatchEnd 回房间时整体销毁 —— 职业模型、技能栏、插值缓冲这些「上一局
 *   的状态」从根上不存在，而不是逐个字段去清（跨局复用场景要清的东西
 *   有十几样，漏一样就是一条只在第二局出现的怪）。
 *   ★ W24 收口后 `CharacterView.setClass` 本身支持换职业了（**局内** respec
 *   要用），但这不改变「每场重建」这条规矩：局内换的是一个字段，跨局换的
 *   是整份状态。
 */

import {
  ALL_CLASSES,
  CastKind,
  MAP_BY_ID,
  TEAM_RED,
  asMapId,
  compositionHints,
  getClass,
  teamSizeOf,
  type ClassDef,
  type ClassId,
  type MapId,
  type Room,
  type RoomPlayerView,
  type ServerMessage,
  type SkillDef,
} from '@wowpvp/shared';
import { ArenaPreset, FFA, GameMode } from '@wowpvp/shared';

import { audio } from '../audio/AudioManager.js';
import { skillIconHtml } from '../hud/skillIcon.js';
import { Connection } from '../net/Connection.js';
import { renderMatchSummary, type MatchSummaryData } from '../hud/MatchSummary.js';
import { NetworkScene } from '../scenes/NetworkScene.js';
import { clampUiScale, loadAccessibility, saveAccessibility } from '../settings/accessibility.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import {
  SKILL_BAR_SLOTS, assignSlot, loadSkillBar, saveSkillBar,
} from '../settings/skillLoadout.js';
import { TUTORIAL_STORAGE_KEY } from '../tutorial/steps.js';
import { artEnabled } from '../settings/artMode.js';
import { ClassPreview } from './ClassPreview.js';
import {
  escapeHtml,
  isLocalDev,
  isJoinableCode,
  makeRoomCode,
  mapOptionsFor,
  normalizeRoomCode,
  readyBlocker,
  roomRowActions,
  sanitizeName,
  shareLink,
  showMapRow,
  splitRoster,
} from './logic.js';
import { midJoinSeats, midJoinTakeoverHint } from '../spectate/spectateView.js';
import { ArrowRight, BookOpen, Flag, Flame, Play, Plus, RefreshCw, Settings, Swords, Target, Users } from 'lucide';
import { iconSvg } from '../hud/icons.js';
import './lobby.css';

/** 昵称的本地存档（照 accessibility 的 `wowpvp.<域>.v1` 键式）*/
const LOBBY_STORAGE_KEY = 'wowpvp.lobby.v1';
const SCREEN_REV = '20260905-2';

// ── P10 纯函数（本仓库没有 jsdom，DOM 之外的判断都提到这里单测）────────

/**
 * P10：连不上服务器时标题页说的话。
 * ★ 带上地址 —— 自己起服务器的人最常见的失败就是端口/主机填错，
 *   只说「连不上」他没法自查。后半句给出**此刻就能玩**的两条单机路。
 */
export const offlineToast = (serverUrl: string): string =>
  `连不上服务器（${serverUrl}）—— 可先玩练习场/新手教学`;

/**
 * P10：练习场入口 URL。
 * ★ 合同 C8：只有大厅这个入口追加 `&grace`（新手缓冲）。验收脚本一律直接
 *   开 `?testbed…` 不带它 —— 缓冲缺省关，脚本那条路逐字节不变。
 */
export const practiceUrl = (pathname: string, classId: string, diff: string): string =>
  `${pathname}?testbed&combat`
  + `&class=${encodeURIComponent(classId)}`
  + `&bot=${encodeURIComponent(diff)}`
  + `&grace`;

/**
 * P10：练习场默认职业 = 展示顺序第一位（战士）。
 * ★ 原默认是列表第 6 位的法师 —— 全职业里读条最多的一个，等于让第一次
 *   开游戏的人先撞打断。战士全技能瞬发：先给手感，机制放后面。
 * ★ 取 `ALL_CLASSES[0]` 而不是写死 'warrior' —— 展示顺序就是入门顺序，
 *   顺序本身由 shared 自己的数据测试钉住。
 */
export const DEFAULT_PRACTICE_CLASS: string = ALL_CLASSES[0]!.id as string;

/**
 * P10：新手教学按钮文案。
 * ⚠️ 未完成态原本写「尚未完成」，真机上读起来像**这个功能是半成品**（第一反应
 *   是「别点」）。没做完的从来不是教学，是玩家的进度 —— 改成通关口径。
 */
export const tutorialLabel = (completed: boolean): string =>
  completed ? '新手教学（已完成 ✓ 可重温）' : '新手教学（推荐先玩 · 未通关）';

/**
 * P10：职业按钮下面那行定位小字。
 *
 * ★★ **算出来，不手写。** 八职业的定位手写一遍，下次谁改了技能表，
 *   这八行就成了界面上的谎话（本仓库红线：UI 文案不许对实现撒谎）。
 *   三段全部有出处：
 *     · 近战/远程 ← `ClassDef.autoAttack.ranged`
 *     · 定位词    ← `ClassDef.role`（9.x「定位一句话」）的第一段
 *     · 节奏      ← 非瞬发技能条数（读条/引导/瞄准都会顶出施法条）
 * ⚠️ 分档阈值 2 是**占位值**：八职业实测非瞬发技能数落在 0~4，
 *   切在 2 让「全瞬发 / 少量读条 / 依赖读条」三档各自有人，不是空档。
 */
export const classTagline = (c: ClassDef): string => {
  const reach = c.autoAttack.ranged ? '远程' : '近战';
  const head = c.role.split('、')[0] ?? '';
  const casts = c.skills.filter((s) => s.cast.kind !== CastKind.Instant).length;
  const cadence = casts === 0 ? '全瞬发' : casts <= 2 ? '少量读条' : '依赖读条';
  // role 第一段本身就说了远近时不再重复一遍（「近战压制 · 全瞬发」而不是「近战 · 近战压制 · …」）
  return head.startsWith(reach) ? `${head} · ${cadence}` : `${reach} · ${head} · ${cadence}`;
};

export interface LobbyOptions {
  /** ws 服务器地址（`?server=` 或默认 ws://<主机>:8080，与 ?net= 老路同规则）*/
  serverUrl: string;
  /** `?lobby=<码>` 深链：标题页预填房间码 */
  joinCode?: string | undefined;
  /** URL 里**显式**给过 server 时，分享链接才带上它（默认地址对别人的主机未必成立）*/
  explicitServer?: string | undefined;
}

type Page = 'title' | 'room' | 'class' | 'match' | 'end';

/** 供 verify:m13 读取的大厅状态（与 `__net`/`__scene` 同一用途）*/
export interface LobbyStatus {
  page: Page;
  roomCode: string;
  playerId: string | null;
  players: { name: string; team: string; classId: string | null; ready: boolean; connected: boolean }[];
  roomStarted: boolean;
  /** W24：本会话此刻坐在观战席（verify 断言「进行中的房间进得去」的入口）*/
  spectating: boolean;
  /** W12：verify 断言模式选择走通（RoomState 广播回来的口径，不是本地记的按钮）*/
  mode: string | null;
  mapId: string | null;
  matchStarts: number;
  matchEnds: number;
  damageSeen: number;
  net: NetworkScene['status'] | null;
}

export class LobbyShell {
  private readonly conn: Connection;
  private page: Page = 'title';
  private name = '';
  private roomCode = '';
  private playerId: string | undefined;
  private players: readonly RoomPlayerView[] = [];
  private roomStarted = false;
  private mode: GameMode | undefined;
  private mapId: MapId | undefined;
  /**
   * P5 选图行当前画的是哪一组选项（`模式|id,id,…`）。
   * ★ 纯渲染缓存，**不是权威状态** —— 高亮走的仍是 RoomState 的 `mapId`。
   *   它只回答「这排按钮要不要重建」（见 renderRoom 里的 ⚠️）。
   */
  private mapRowKey = '';
  private preset: ArenaPreset = ArenaPreset.Classic;
  /** P5：人机补位状态（由 RoomState 同步，房主可改）*/
  private fillWithBots = false;
  /** P12：点了「刷新房间列表」但连接还没通 —— Welcome 到达时补发 ListRooms */
  private pendingBrowse = false;
  /** P12：从「大乱斗」入口建房 —— RoomState 到达后补发 SetRoomMode ffa */
  private pendingQuickMode: GameMode | undefined;
  private quickMode: GameMode = GameMode.Ffa;
  /**
   * X10 二轮（用户：「大乱斗不是快速开始吗，怎么还进了 PVP 的选择界面」）：
   * 「快速开始」是**直通流程** —— 建房后跳过房间页直进选职业页，选完职业
   * 自动参战 + 准备（canStart 的补位分支单人即满足，服务器立刻开局）。
   * 房间页对快速开始的人从头到尾不出现；协议消息与手动路径完全同一套。
   */
  private quickStart = false;
  private botDifficulty: 'easy' | 'normal' | 'hard' = 'normal';
  /** 随机大 BOSS。★ 默认关，与 RoomConfig 的默认值同一句话 */
  private bossEnabled = false;
  /** P6：练习场配置（入口页点选，开始时拼进 ?testbed URL）。P10：默认见 DEFAULT_PRACTICE_CLASS */
  private practiceClass: string = DEFAULT_PRACTICE_CLASS;
  private practiceDiff: 'easy' | 'normal' | 'hard' = 'normal';
  /** 房主 id。只有他能改规则预设（服务器校验，这里只决定按钮亮不亮）*/
  private hostId: string | undefined;
  /** 16a 战后统计。★ 每局开始时清空 —— 否则第二局会显示上一局的数据 */
  private summary: MatchSummaryData | undefined;
  /** 点了建房/加房但连接还没通（或 JoinRoom 还没被答复）*/
  private pendingJoin: { code: string; creating: boolean } | undefined;
  /**
   * W24：本会话此刻坐在**观战席**（`MatchStart.spectating`）。
   * ★ 与 `page === 'match'` 一起决定「席位面板画不画」。
   */
  private spectating = false;
  /** W24：房间列表上点的是「加入」而不是「观战」—— 入场后自动弹席位面板 */
  private wantsToPlay = false;
  private midJoinOpen = false;
  private midJoinTeam: 'red' | 'blue' | undefined;
  private midJoinClass: string | undefined;
  /**
   * W24：已发出的 `JoinOngoing`。★ 上场后建场景要用它兜底 —— 走「空席位」
   * 那条路时名单里的自己还是**观战席条目**（没有队伍也没有职业），
   * 而 RoomState 的广播在 MatchStart **之后**才到（服务器的顺序）。
   */
  private midJoinRequest: { team: 'red' | 'blue'; classId: string } | undefined;

  private scene: NetworkScene | undefined;
  private matchRoot: HTMLElement | undefined;
  private preview: ClassPreview | undefined;
  private readonly art = artEnabled();

  private endText = '';
  private matchStarts = 0;
  private matchEnds = 0;
  private damageSeen = 0;

  private root!: HTMLElement;
  /** W9：设置面板。懒建 —— 标题页第一次点「设置」才构造 */
  private settingsPanel?: SettingsPanel;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly app: HTMLElement,
    private readonly opts: LobbyOptions,
  ) {
    this.conn = new Connection(opts.serverUrl, {
      onMessage: (m) => this.route(m),
      onOpen: (resumed) => {
        // 房间阶段的重连没有令牌（令牌只随 MatchStart 发），一律走重新 JoinRoom
        if (!resumed && this.pendingJoin) this.sendJoin();
      },
      onClose: (willRetry) => {
        if (willRetry) {
          /**
           * ⚠️ 真机实测：本机 8080 没人监听时，六次退避重试要走 **23 秒**才出最终结论
           * （远超退避表本身的 7.75s —— 浏览器每次 ws 握手另有开销）。提示条只活 12 秒，
           * 中间那十几秒又会退回「零反馈」。所以每退一次就把提示条续上一次，
           * 顺带把「还在重试」说出来 —— 它确实在重试（Connection.scheduleRetry）。
           */
          if (this.pendingJoin) this.toast('连不上服务器，正在重试…', 12000);
          return;
        }
        /**
         * P10 ★ 标题页此前被排除在断开提示之外 —— 而「建房连不上」恰恰
         * 停在标题页：点完「创建房间」只有一条 8 秒的「正在创建房间…」，
         * 之后再无任何反馈（实测干等 40 秒也没有一个字）。
         * 连接是玩家亲手点出来的，失败就必须由他正看着的这一页说出来。
         */
        if (this.pendingJoin) {
          this.pendingJoin = undefined;
          this.setTitleBusy(false); // 按钮恢复可点：不然他连重试都试不了
          // 6000 是占位值：这条比普通提示长（默认 3200），因为它要人读完地址再决定去哪
          this.toast(offlineToast(this.opts.serverUrl), 6000);
          return;
        }
        if (this.page !== 'title') this.toast(`与服务器断开（${this.opts.serverUrl}）`);
      },
    });
  }

  /** 供验收脚本读取（与试验场 `__scene`、联网老路 `__net` 同一个用途）*/
  get status(): LobbyStatus {
    return {
      page: this.page,
      roomCode: this.roomCode,
      playerId: this.playerId ?? null,
      players: this.players.map((p) => ({
        name: p.name,
        team: p.team,
        classId: (p.classId as string | undefined) ?? null,
        ready: p.ready,
        connected: p.connected,
      })),
      roomStarted: this.roomStarted,
      spectating: this.spectating,
      mode: (this.mode as string | undefined) ?? null,
      mapId: (this.mapId as string | undefined) ?? null,
      matchStarts: this.matchStarts,
      matchEnds: this.matchEnds,
      damageSeen: this.damageSeen,
      net: this.scene?.status ?? null,
    };
  }

  // ── 装配 ──────────────────────────────────────────────────────

  mount(): void {
    document.title = 'wowpvp — 竞技场大厅';
    this.name = this.loadSavedName();
    this.app.innerHTML = '';
    this.root = document.createElement('div');
    this.root.id = 'lobby';
    /**
     * X10 二轮：?art=off（软件渲染档，验收 e2e 全用它）连大厅的重活儿也
     * 一并关 —— backdrop-filter 与无限动画在 SwiftShader 上能把合成器打满，
     * 满到**点击事件都被饿死**（m13 第一步 click 超时 30s 当场抓到）。
     * 真机默认 art 开，视觉效果全量保留；CSS 里按 .lb-noart 收口。
     */
    this.root.classList.toggle('lb-noart', !this.art);
    // 17.2 界面缩放：与 HUD 同一个 CSS 变量、同一个夹取函数
    this.root.style.setProperty(
      '--ui-scale',
      String(clampUiScale(loadAccessibility(globalThis.localStorage).uiScale)),
    );
    this.root.innerHTML = `
      ${this.titleHtml()}

      <section class="lb-page" data-page="room">
        <div class="lb-panel lb-room">
          <div class="lb-room-head">
            <div>
              <span class="lb-fine">房间码</span>
              <b id="lb-room-code" class="lb-code"></b>
            </div>
            <div class="lb-share">
              <input id="lb-share" readonly title="发给朋友的链接"/>
              <button class="lb-btn lb-small" data-action="copy">复制链接</button>
            </div>
          </div>
          <div id="lb-room-meta" class="lb-fine"></div>
          <div id="lb-roster" class="lb-roster"></div>
          <div id="lb-hints" class="lb-hints"></div>
          <div class="lb-room-actions">
            <div class="lb-row">
              <span class="lb-fine" id="lb-team-label">阵营：</span>
              <button class="lb-btn lb-small lb-red" data-action="team" data-team="red">红方</button>
              <button class="lb-btn lb-small lb-blue" data-action="team" data-team="blue">蓝方</button>
              <button class="lb-btn lb-small" data-action="team" data-team="spectator">观战</button>
              <button class="lb-btn lb-small" data-action="open-class" id="lb-class-btn">选择职业</button>
            </div>
            <!--
              W12 游戏模式。★ 与下面的规则预设是同一个存在理由：房间默认
              arena3v3，没有这排按钮，M7 交付的整个夺旗模式在联网对局里
              不可达。服务器只接受房主的这条消息（校验在 sim 的 setMode 里），
              换模式连带换地图与人数档。
            -->
            <div class="lb-row" id="lb-modes">
              <!-- X10 二轮：大乱斗房间里这组 PVP 专属控件整体隐藏（人数档与
                   夺旗对 FFA 无意义，此前照常显示 —— 用户即由此认成「PVP 的
                   选择界面」）。display:contents 的包裹层不改布局。 -->
              <span id="lb-pvp-modes" style="display:contents">
                <span class="lb-fine">竞技场人数：</span>
                <input type="range" id="lb-size" min="1" max="5" step="1" value="3"
                       style="flex:1;min-width:110px;max-width:200px"
                       title="每队人数（1v1–5v5）"/>
                <b id="lb-size-label" style="min-width:52px;font-size:13px">3v3</b>
                <span class="lb-fine">夺旗：</span>
                <button class="lb-btn lb-small" data-action="mode" data-mode="ctf6v6">6v6</button>
                <button class="lb-btn lb-small" data-action="mode" data-mode="ctf8v8">8v8</button>
                <button class="lb-btn lb-small" data-action="mode" data-mode="ctf12v12">12v12</button>
              </span>
              <span id="lb-mode-why" class="lb-fine"></span>
            </div>
            <!--
              P5 选图。★ 与模式/预设是同一个存在理由：四张主题图数据全对、
              机检全绿，但 setMode 只会落到 mapsForMode(mode)[0]（试炼环）——
              没有这一行，玩家一张都进不去。按钮由 mapOptionsFor(mode) 现算
              （选项随人数档变），房主可点、非房主只读，校验在 sim 的 setMap 里。
              大乱斗房间整行隐藏（FFA 固定大图，P13 口径）。
            -->
            <div class="lb-row" id="lb-map-row">
              <span class="lb-fine">地图：</span>
              <span id="lb-maps" style="display:contents"></span>
              <span id="lb-map-why" class="lb-fine"></span>
            </div>
            <!--
              10.1 规则预设。★ **没有这个开关，整个第 10 章不可达** ——
              房间默认经典竞技场，而经典竞技场按验收 #28 不生成任何临时武装，
              于是军械箱/掉落/换装/消耗品全都规则正确却永远不会出现在对局里。
              服务器只接受房主的这条消息（校验在 sim 的 setPreset 里）。
              ★ 注意这段是模板字符串里的 HTML —— 注释里不能出现反引号。
            -->
            <div class="lb-row" id="lb-preset-row">
              <span class="lb-fine">规则：</span>
              <button class="lb-btn lb-small" data-action="preset" data-preset="classic"
                      id="lb-preset-classic">经典竞技场</button>
              <button class="lb-btn lb-small" data-action="preset" data-preset="armed"
                      id="lb-preset-armed">武装竞技场</button>
              <span id="lb-preset-why" class="lb-fine"></span>
            </div>
            <!--
              P5（P1c）人机对局。★ SetFillWithBots 协议与服务器处理早就在，
              但此前大厅**没有任何按钮发它** —— 玩家根本无法从界面开人机对局
              （「写了没人调」的 UI 版）。开关 + 三档难度都只有房主能改，
              校验在 sim 的 setFillWithBots / setBotDifficulty 里。
            -->
            <div class="lb-row">
              <span class="lb-fine">人机补位：</span>
              <button class="lb-btn lb-small" data-action="fill-bots" data-fill="on"
                      id="lb-fill-on">开</button>
              <button class="lb-btn lb-small" data-action="fill-bots" data-fill="off"
                      id="lb-fill-off">关</button>
              <span class="lb-fine">难度：</span>
              <button class="lb-btn lb-small" data-action="bot-diff" data-diff="easy">简单</button>
              <button class="lb-btn lb-small" data-action="bot-diff" data-diff="normal">普通</button>
              <button class="lb-btn lb-small" data-action="bot-diff" data-diff="hard">困难</button>
              <span id="lb-bots-state" class="lb-fine"></span>
            </div>
            <!--
              随机大 BOSS（玩家需求）。★ 与上面两个开关同一条存在理由：
              没有这个按钮，sim/boss.ts 的全部规则在真实对局里一次都不会发生。
              校验（房主、开赛前）在 sim 的 setBossEnabled 里，这里只发意图。
            -->
            <div class="lb-row">
              <span class="lb-fine">大 BOSS：</span>
              <button class="lb-btn lb-small" data-action="boss" data-boss="on"
                      id="lb-boss-on">开</button>
              <button class="lb-btn lb-small" data-action="boss" data-boss="off"
                      id="lb-boss-off">关</button>
              <span id="lb-boss-state" class="lb-fine"></span>
            </div>
            <div class="lb-row">
              <button class="lb-btn lb-primary" data-action="ready" id="lb-ready-btn">准备</button>
              <span id="lb-ready-why" class="lb-fine"></span>
            </div>
            <div class="lb-row">
              <button class="lb-btn lb-ghost lb-small" data-action="leave">离开房间</button>
            </div>
          </div>
        </div>
      </section>

      <section class="lb-page" data-page="class">
        <div class="lb-panel lb-class">
          <div class="lb-class-head">
            <div>
              <h2 id="lb-class-title">选择职业</h2>
              <p id="lb-class-sub" class="lb-fine" hidden>人人为敌 · 其余名额人机补满 · 选完立刻开局</p>
            </div>
            <button class="lb-btn lb-small" data-action="back-room" id="lb-class-back">返回房间</button>
          </div>
          <div class="lb-class-body">
            <div id="lb-cards" class="lb-cards">${this.classCardsHtml()}</div>
            <div id="lb-preview" class="lb-preview" ${this.art ? '' : 'hidden'}>
              <canvas id="lb-preview-canvas" width="280" height="340"></canvas>
              <div id="lb-preview-name" class="lb-fine"></div>
            </div>
          </div>
        </div>
      </section>

      <div class="lb-end" data-page="end" hidden>
        <div class="lb-panel lb-end-panel">
          <h2 id="lb-end-title"></h2>
          <!-- 16a 结算面板：16.x 统计与 16.4 七项最佳玩家。
               ★ 内容由 renderMatchSummary() 生成 —— 它是纯函数，可单测 -->
          <div id="lb-summary"></div>
          <button class="lb-btn lb-primary" data-action="rematch">回到房间</button>
        </div>
      </div>

      <!--
        W24 席位面板：**浮在观战画面之上**，不是一页。
        ★ 与结算横幅（.lb-end）同一条理由：此刻 3D 场景正在跑（观战），
          大厅那几页整体让位给画布，能出现的只有浮层。
        ★ 样式走内联而不是新 class —— 样式表不归本包改，新 class 在真机上
          会是一块没有布局的裸 DOM（.lb-end[hidden] 那次的同款教训）。
        ★ 选项内容全部由 renderMidJoin() 现算：席位余量来自 RoomState 名单，
          客户端不缓存一份会过期的余量。
      -->
      <button class="lb-btn lb-small" id="lb-midjoin-open" data-action="midjoin-open" hidden
              style="position:fixed;right:14px;top:58px;z-index:60">⚔ 加入这局</button>
      <div id="lb-midjoin" hidden
           style="position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:60;max-width:min(760px,94vw)">
        <div class="lb-panel" style="padding:14px 18px">
          <h3 style="margin:0 0 8px">加入这局对局</h3>
          <div class="lb-row" id="lb-midjoin-seats"></div>
          <div class="lb-fine" id="lb-midjoin-why"></div>
          <div class="lb-fine" style="margin:8px 0 2px">选择职业：</div>
          <div class="lb-row" id="lb-midjoin-classes" style="flex-wrap:wrap"></div>
          <div class="lb-row" style="margin-top:8px">
            <button class="lb-btn lb-primary" data-action="midjoin-go" id="lb-midjoin-go">加入对局</button>
            <button class="lb-btn lb-ghost lb-small" data-action="midjoin-close">继续观战</button>
          </div>
        </div>
      </div>

      <div id="lb-toast" hidden></div>
    `;
    this.app.appendChild(this.root);

    this.root.addEventListener('click', (ev) => this.onClick(ev));
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const target = ev.target as HTMLElement;
      if (target.id === 'lb-code') this.act('join');
      if (target.id === 'lb-name') (this.root.querySelector('#lb-code') as HTMLElement)?.focus();
    });
    /**
     * P10：昵称此前**只在建/加房那一刻**才落盘 —— 先填名字再去练习场或教学的人
     * 下次回来又是空的（填了个寂寞）。change（失焦/回车）就存，与 join() 走同一个
     * saveName，口径不分家。
     */
    this.root.addEventListener('change', (ev) => {
      const el = ev.target as HTMLElement;
      if (el.id !== 'lb-name') return;
      this.name = sanitizeName((el as HTMLInputElement).value);
      this.saveName(this.name);
    });
    /**
     * P12 竞技场人数滑杆（玩家反馈「开房间时任意拖动 1v1–12v12」）。
     * input = 实时更新标签（纯本地反馈）；change = 松手才发 SetRoomMode ——
     * 拖动途中每一格都发的话，非房主会收到一串 Rejected toast。
     * 合法性照旧由服务器 codec 白名单验，这里只发意图。
     */
    this.root.addEventListener('input', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.id !== 'lb-size') return;
      const label = this.root.querySelector('#lb-size-label');
      if (label) label.textContent = `${el.value}v${el.value}`;
    });
    this.root.addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement;
      if (el.id !== 'lb-size') return;
      this.conn.send({ t: 'SetRoomMode', mode: `arena${el.value}v${el.value}` as GameMode });
    });

    // 悬停哪张职业卡就预览哪个模型（选中另算，见 render）
    this.root.addEventListener('mouseover', (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>('.lb-card');
      if (card?.dataset['class'] && this.page === 'class') this.showPreview(card.dataset['class']);
    });

    // 音频解锁挂在首次交互上（与场景同一个单例）；大厅按钮从第一下就有声
    audio.install();
    if (this.opts.joinCode) (this.root.querySelector('#lb-code') as HTMLInputElement)?.focus();
    this.render();
  }

  // ── 服务器消息路由 ────────────────────────────────────────────

  /**
   * 连接归大厅，消息在这里分流：房间阶段自己消化，战斗阶段转给场景
   * （`NetworkScene.deliver` —— 与 `?net=` 老路的 onMessage 是同一个函数）。
   */
  private route(msg: ServerMessage): void {
    switch (msg.t) {
      case 'Welcome':
        this.playerId = msg.playerId;
        // P12：为浏览房间列表而建立的连接就绪了 —— 补发那次 ListRooms
        if (this.pendingBrowse) {
          this.pendingBrowse = false;
          this.conn.send({ t: 'ListRooms' });
        }
        break;

      case 'RoomList':
        this.renderRoomList(msg.rooms);
        break;

      /**
       * P12 连接排队：满员时服务器不关连接,报「前面还有几人」。
       * 长 toast 挂住（每次更新续期）—— 轮到时 Welcome 到达,加房流程
       * 自动继续（排队期间发的 JoinRoom 服务器有缓存重放,不用重发）。
       */
      case 'QueueStatus':
        this.toast(
          msg.ahead === 0
            ? '服务器已满，正在排队 —— 你是下一个'
            : `服务器已满，正在排队 —— 前面还有 ${msg.ahead} 人`,
          60000,
        );
        break;

      case 'RoomState': {
        this.players = msg.players;
        this.roomStarted = msg.started;
        this.mode = msg.mode;
        this.mapId = msg.mapId;
        this.preset = msg.preset;
        this.hostId = msg.hostId;
        // P5：人机补位状态（房主改，全员看见）
        this.fillWithBots = msg.fillWithBots;
        this.botDifficulty = msg.botDifficulty;
        // 大 BOSS 开关同理
        this.bossEnabled = msg.bossEnabled;
        if (this.pendingJoin) {
          /**
           * P12：**建房**默认开人机补位（产品默认，服务器语义不变）——
           * 玩家反馈「12v12 很容易不满人」；建房者就是房主，这条必然被接受。
           * 房主随时可在房间里关掉；加入别人房间不发（不是房主，发也被拒）。
           */
          /**
           * P12：只有「大乱斗」一键房默认开人机补位 —— 它的定位就是即点即玩。
           * ⚠️ 普通建房**不能**默认开：开了之后房主一按准备就会立刻和 bot
           *   开局（canStart 的补位分支单人即满足），等朋友进房的那个人
           *   会被 bot 拉走 —— m13 的双人流程当场撞破这一点。想单人打
           *   bot 房，房间里那排「人机补位」开关就是干这个的。
           */
          if (this.pendingJoin.creating && this.pendingQuickMode) {
            const mode = this.pendingQuickMode;
            this.pendingQuickMode = undefined;
            this.conn.send({ t: 'SetRoomMode', mode });
            this.conn.send({ t: 'SetFillWithBots', enabled: true });
            /**
             * 快速开始：直接替玩家「参战」—— 大乱斗没有阵营，红槽只是
             * 战斗席（createMatch 的 ffa 分支按独立阵营重新分）。这一步
             * 提前到这里，选职业页里点一张卡就只差 SetReady 一条消息。
             */
            if (this.quickStart) this.conn.send({ t: 'SelectTeam', team: 'red' });
          }
          // JoinRoom 的成功答复就是第一条 RoomState（协议没有单独的 ack）
          this.pendingJoin = undefined;
          // 快速开始跳过房间页：下一步（也是唯一一步）就是选职业
          this.page = this.quickStart ? 'class' : 'room';
          if (this.quickStart) this.showPreview(ALL_CLASSES[0]!.id as string);
          this.clearToast();
          this.setTitleBusy(false); // 离开房间回到标题页时按钮得是活的
        }
        /**
         * W24：对局中也会来 `RoomState`（有人中途加入 / 掉线被人机接管）。
         * ★ 大厅页此刻整体让位给画布，能更新的只有那块浮层 —— 而它读的
         *   正是名单（席位余量）。不刷的话玩家看着一个已经被人坐掉的空位。
         */
        if (this.page === 'match') this.renderMidJoin();
        else this.render();
        break;
      }

      case 'MatchStart':
        this.onMatchStart(msg);
        break;

      case 'MatchEnd': {
        this.matchEnds++;
        this.scene?.deliver(msg); // 场景：停发输入 + 结算日志
        /**
         * 令牌作废：那一局已经不存在。回到房间页之后一次普通的网络闪断
         * 不该再以「上一局的我」的身份去 Reconnect（会被拒一次白绕一圈）。
         */
        this.conn.clearToken();
        this.endText =
          msg.winner === 'draw'
            ? '平局'
            : `${msg.winner === TEAM_RED ? '红方' : '蓝方'}获胜`;
        this.page = 'end';
        this.render();
        break;
      }

      /**
       * 16a：战后统计。★ 存下来等结算页渲染 —— `MatchStats` 在 `MatchEnd`
       * **之前**到达（服务器刻意的顺序，见 MatchLoop.broadcastStats），
       * 所以这里只能先存；`MatchEnd` 那一支切页时才画得出来。
       */
      case 'MatchStats':
        this.summary = { rows: msg.rows, awards: msg.awards };
        break;

      case 'Damage':
        this.damageSeen++; // verify:m13 的判据计数（复用 m10「双方都收到 Damage」）
        this.scene?.deliver(msg);
        break;

      case 'Rejected': {
        /**
         * ★★ W24：`JoinOngoing` 被拒时**必须 toast** —— 会话仍在观战席，
         *   而拒绝理由是服务器专门写成可以直接展示的一句话（「红方没有可
         *   加入的席位——蓝方还有 2 个，换一边试试」）。落进战斗日志里
         *   等于没说：玩家此刻正盯着席位面板。
         * ★ 面板留在原地（不关），换一边再点就是了。
         */
        if (msg.what === 'JoinOngoing') {
          this.midJoinRequest = undefined;
          this.midJoinOpen = true;
          this.renderMidJoin();
          this.toast(msg.reason, 6000);
          break;
        }
        if (this.pendingJoin && msg.what === 'JoinRoom') {
          this.pendingJoin = undefined;
          this.wantsToPlay = false; // 这一次没进去 —— 意图不留到下一次点击
          this.setTitleBusy(false); // 被服务器拒了也停在标题页，按钮必须能再点
          this.toast(`加入失败：${msg.reason}`);
        } else if (this.page === 'room' || this.page === 'class') {
          this.toast(`${msg.what} 被拒绝:${msg.reason}`);
        } else {
          this.scene?.deliver(msg); // 战斗内的拒绝进战斗日志（场景已有处理）
        }
        break;
      }

      default:
        this.scene?.deliver(msg);
    }
  }

  // ── 用户操作 ──────────────────────────────────────────────────

  private onClick(ev: MouseEvent): void {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    audio.play('ui_click', { group: 'ui', volume: 0.35 });
    this.act(btn.dataset['action']!, btn);
  }

  /**
   * W11（技术债总账）：大厅第一次**读**教学进度 —— 此前做没做过教学的人
   * 看到的大厅一模一样。判定 = 存档 done 里含毕业环（前缀连续存档，
   * 含 graduate 即全部走完）；读不到/解析失败按未完成（提示无害）。
   */
  private tutorialCompleted(): boolean {
    try {
      const raw = globalThis.localStorage.getItem(TUTORIAL_STORAGE_KEY);
      if (raw === null) return false;
      const done = (JSON.parse(raw) as { done?: string[] }).done ?? [];
      return done.includes('graduate');
    } catch {
      return false;
    }
  }

  private act(action: string, btn?: HTMLElement): void {
    switch (action) {
      case 'create':
        this.quickStart = false;
        this.pendingQuickMode = undefined;
        this.join(makeRoomCode(), true);
        break;
      case 'create-ffa':
        this.startQuick(GameMode.Ffa);
        break;
      case 'quick-arena':
      case 'quick-ctf': {
        const select = this.root.querySelector<HTMLSelectElement>(action === 'quick-arena' ? '#lb-quick-arena-mode' : '#lb-quick-ctf-mode');
        if (select) this.startQuick(select.value as GameMode);
        break;
      }
      case 'browse': {
        /**
         * P12 房间浏览。连接是懒建立的（此前只有建/加房才连）——
         * 浏览也要先连上；连上后的 Welcome 不会自动拉列表,
         * 由 pendingBrowse 在连接就绪时补发一次 ListRooms。
         */
        const hint = this.root.querySelector('#lb-roomlist-hint') as HTMLElement | null;
        if (this.conn.connected) {
          this.conn.send({ t: 'ListRooms' });
          if (hint) hint.textContent = '刷新中…';
        } else {
          this.pendingBrowse = true;
          if (hint) hint.textContent = '连接服务器…';
          this.conn.connect();
        }
        break;
      }
      case 'join-listed': {
        const code = btn?.dataset['code'];
        if (!code) break;
        /**
         * W24：对 `started` 房间，`JoinRoom` 就是入场观战 —— 想上场的人
         * 还要选席位与职业，而那两样**要先看见房间状态**才选得出来
         * （哪一队坐得下、有几个人机可顶）。记下意图，`MatchStart` 到达
         * 切进观战场景后自动把席位面板弹出来。
         */
        this.wantsToPlay = btn?.dataset['intent'] === 'play';
        this.join(code, false);
        break;
      }
      /** W24 席位面板：先选边（大乱斗只有一个「参战」）*/
      case 'midjoin-team': {
        const team = btn?.dataset['team'];
        if (team === 'red' || team === 'blue') this.midJoinTeam = team;
        this.renderMidJoin();
        break;
      }
      /** W24 席位面板：再选职业 */
      case 'midjoin-class': {
        this.midJoinClass = btn?.dataset['class'] ?? this.midJoinClass;
        this.renderMidJoin();
        break;
      }
      case 'midjoin-go': {
        if (!this.midJoinTeam || !this.midJoinClass) break;
        /**
         * ★ 只发意图。「这一队坐不坐得下」「那个人机顶不顶得了」全在服务器的
         *   `onJoinOngoing` —— 被拒时它给的是一句**可以直接展示**的话
         *   （「红方没有可加入的席位——蓝方还有 2 个，换一边试试」），
         *   客户端一个判据都不复述。
         */
        this.midJoinRequest = { team: this.midJoinTeam, classId: this.midJoinClass };
        this.conn.send({
          t: 'JoinOngoing', team: this.midJoinTeam, classId: this.midJoinClass as ClassId,
        });
        break;
      }
      case 'midjoin-close':
        this.midJoinOpen = false;
        this.renderMidJoin();
        break;
      case 'midjoin-open':
        this.midJoinOpen = true;
        this.renderMidJoin();
        break;
      case 'join': {
        const code = normalizeRoomCode(
          (this.root.querySelector('#lb-code') as HTMLInputElement)?.value ?? '',
        );
        if (!isJoinableCode(code)) { this.toast('先填一个房间码'); return; }
        this.join(code, false);
        break;
      }
      case 'practice': {
        // P6：展开/收起练习场配置（职业 + 难度都在页面上点选）
        const panel = this.root.querySelector('#lb-practice') as HTMLElement | null;
        if (panel) panel.hidden = !panel.hidden;
        /**
         * ★ P10：展开之后「练习场」只剩折叠开关的作用，主按钮让给「开始练习」——
         * 同屏两个主按钮等于一个都没有，而此刻唯一该点的是最下面那个。
         */
        btn?.classList.toggle('lb-primary', panel?.hidden !== false);
        break;
      }
      case 'practice-class': {
        // 高亮所选职业（存在字段里，开始时拼 URL）
        this.practiceClass = btn?.dataset['class'] ?? this.practiceClass;
        for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-action="practice-class"]')) {
          el.classList.toggle('lb-armed', el.dataset['class'] === this.practiceClass);
        }
        break;
      }
      case 'practice-diff': {
        this.practiceDiff = (btn?.dataset['diff'] as 'easy' | 'normal' | 'hard') ?? this.practiceDiff;
        for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-action="practice-diff"]')) {
          el.classList.toggle('lb-armed', el.dataset['diff'] === this.practiceDiff);
        }
        break;
      }
      case 'practice-start':
        /**
         * 练习场 = 试验场实战模式（?combat 假人会打）+ 所选职业与难度。
         * 大厅不内嵌它、只跳过去 —— 两条路径的启动代码零交集（M13 旧则）。
         * P10：URL 尾部多一个 `&grace`（合同 C8 新手缓冲），见 practiceUrl。
         */
        location.href = practiceUrl(location.pathname, this.practiceClass, this.practiceDiff);
        break;
      case 'dev-testbed':
        // P6 本地开发入口（isLocalDev 才渲染按钮）：原「验收试验场」无参语义
        location.href = `${location.pathname}?testbed`;
        break;
      case 'dev-stress':
        location.href = `${location.pathname}?stress`;
        break;
      case 'tutorial':
        // M15：同一个试验场，多一个 tutorial=on —— 教学是试验场上的旁听层
        location.href = `${location.pathname}?tutorial=on`;
        break;
      case 'settings':
        /**
         * W9（技术债总账）：设置在进对局**之前**就该可达 —— 音量与无障碍
         * 是「第一局开打前」就想调的东西。大厅没有场景，无障碍钩子只做
         * 「存盘 + 应用缩放」；其余项由进入对局的场景在构造时读盘生效。
         */
        this.settingsPanel ??= new SettingsPanel(this.root, {
          getAccessibility: () => loadAccessibility(globalThis.localStorage),
          setAccessibility: (next) => {
            saveAccessibility(globalThis.localStorage, next);
            this.root.style.setProperty('--ui-scale', String(clampUiScale(next.uiScale)));
          },
          /**
           * P3c：**开场前**配技能栏（用户原话就是「开场前可以让玩家选择
           * 技能列表，重新排列技能顺序」）。大厅没有对局，只做「读盘 → 改 →
           * 存盘」；进对局的场景在构造/首快照时读同一份存档生效。
           * 未选职业时 pool 为空 → 面板不渲染该区块。
           */
          skillBar: {
            current: () => this.lobbySkillBar(),
            pool: () => {
              const classId = this.self()?.classId as string | undefined;
              return classId ? (getClass(classId as never)?.skills ?? []) : [];
            },
            assign: (slot, skillId) => {
              const classId = this.self()?.classId as string | undefined;
              if (!classId) return;
              const next = assignSlot(
                this.lobbySkillBar().map((sk) => sk.id as string), slot, skillId,
              );
              saveSkillBar(globalThis.localStorage, classId, next);
            },
            reset: () => {
              const classId = this.self()?.classId as string | undefined;
              const cls = classId ? getClass(classId as never) : undefined;
              if (!classId || !cls) return;
              saveSkillBar(
                globalThis.localStorage, classId,
                cls.skills.slice(0, SKILL_BAR_SLOTS).map((sk) => sk.id as string),
              );
            },
          },
        });
        this.settingsPanel.toggle();
        break;
      case 'team':
        this.conn.send({ t: 'SelectTeam', team: (btn?.dataset['team'] ?? 'spectator') as 'red' | 'blue' | 'spectator' });
        break;
      case 'preset':
        // ★ 只发意图；「只有房主、只在开赛前」由服务器的 `setPreset` 校验，
        //   被拒时会回一条 Rejected，走既有的 toast 路径
        this.conn.send({
          t: 'SetRoomPreset',
          preset: btn?.dataset['preset'] === 'armed' ? ArenaPreset.Armed : ArenaPreset.Classic,
        });
        break;
      case 'fill-bots':
        // P5：同 preset —— 只发意图，房主/开赛前校验在服务器
        this.conn.send({ t: 'SetFillWithBots', enabled: btn?.dataset['fill'] === 'on' });
        break;
      case 'boss':
        // 同 preset/fill-bots：只发意图，房主与开赛前的校验都在服务器
        this.conn.send({ t: 'SetRoomBoss', enabled: btn?.dataset['boss'] === 'on' });
        break;
      case 'bot-diff': {
        const diff = btn?.dataset['diff'];
        if (diff === 'easy' || diff === 'normal' || diff === 'hard') {
          this.conn.send({ t: 'SetRoomBotDifficulty', difficulty: diff });
        }
        break;
      }
      case 'mode': {
        // ★ 同 preset：只发意图。合法值由按钮的 data-mode 保证，
        //   服务器 codec 再验一遍白名单（不受信任输入的门在那边）
        const mode = btn?.dataset['mode'];
        if (mode) this.conn.send({ t: 'SetRoomMode', mode: mode as GameMode });
        break;
      }
      case 'map': {
        /**
         * P5 选图。★ 同 mode：只发意图 —— 「房主吗」「开局了吗」
         *   「这张图适配当前人数档吗」三条全由服务器的 `setMap()` 判，
         *   被拒会回一条 Rejected 走既有 toast 路。
         * ★ 按钮上的 id 来自 `mapOptionsFor()`（也就是 `mapsForMode`），
         *   客户端这边不存在任何 id 字面量。
         */
        const mapId = btn?.dataset['map'];
        if (mapId) this.conn.send({ t: 'SetRoomMap', mapId: asMapId(mapId) });
        break;
      }
      case 'open-class':
        this.page = 'class';
        this.render();
        this.showPreview((this.self()?.classId as string | undefined) ?? (ALL_CLASSES[0]!.id as string));
        break;
      case 'back-room':
        // 快速开始没有「房间页」可回 —— 这颗按钮在直通流程里就是「不玩了」
        if (this.quickStart) { this.act('leave'); break; }
        this.page = 'room';
        this.render();
        break;
      case 'pick-class': {
        const classId = btn?.dataset['class'];
        if (!classId) return;
        this.conn.send({ t: 'SelectClass', classId: classId as ClassId });
        if (this.quickStart) {
          /**
           * 快速开始：选职业就是最后一步 —— 自动准备，服务器侧 canStart
           * （补位分支）立即成立并开局。停在本页等 MatchStart；
           * 被拒绝会有 Rejected toast（page=class 走房间同一条提示路）。
           */
          this.conn.send({ t: 'SetReady', ready: true });
          this.toast('正在集结人机对手，马上开打…', 12000);
          break;
        }
        this.page = 'room'; // 服务器的确认以 RoomState 回来；被拒绝会有 toast
        this.render();
        break;
      }
      case 'ready': {
        const self = this.self();
        this.conn.send({ t: 'SetReady', ready: !(self?.ready ?? false) });
        break;
      }
      case 'leave':
        // 服务器把 session 放回 Lobby 阶段（连接与 playerId 不换），可再建/加房
        this.conn.send({ t: 'LeaveMatch' });
        this.players = [];
        this.roomCode = '';
        this.quickStart = false; // 直通流程随房间一起结束
        // W24：观战/中途加入的意图随房间一起结束（不带进下一个房间）
        this.spectating = false;
        this.midJoinOpen = false;
        this.midJoinRequest = undefined;
        this.midJoinTeam = undefined;
        this.clearToast();
        this.page = 'title';
        this.render();
        break;
      case 'copy': {
        const url = this.shareUrl();
        void navigator.clipboard?.writeText(url).then(
          () => this.toast('链接已复制，发给朋友吧'),
          () => this.toast('复制失败 —— 手动选中输入框里的链接'),
        );
        break;
      }
      case 'rematch':
        this.destroyMatch();
        this.page = 'room';
        this.render();
        break;
      default:
        break;
    }
  }

  /**
   * P12 房间列表渲染。就地更新（不走整页 render —— 列表是标题页的局部）。
   * ★ 模式名转成人话（arena5v5 → 竞技场 5v5）；进行中的房间不给加入键
   *   （JoinRoom 对已开局的本来就拒，按钮直接不出现，别让人点了吃拒绝）。
   */
  private renderRoomList(
    rooms: readonly {
      roomId: string; mode: string; players: number;
      capacity: number; started: boolean; fillWithBots: boolean;
      /** W24：**现在**坐得下几个战斗席（与 capacity-players 不等价，见 roomRowActions）*/
      joinableSeats: number;
    }[],
  ): void {
    /**
     * X10 追加轮：列表按模式**分家** —— 大乱斗房挂大乱斗卡下、组队房挂
     * PVP 卡下（用户拍板「已开的房间列表应该在大乱斗模式之下显示出来」）。
     * 两个容器任一不在（老布局/单测桩）就整体跳过，行为与此前的判空一致。
     */
    const pvpBox = this.root.querySelector('#lb-roomlist-pvp') as HTMLElement | null;
    const ffaBox = this.root.querySelector('#lb-roomlist-ffa') as HTMLElement | null;
    const hint = this.root.querySelector('#lb-roomlist-hint') as HTMLElement | null;
    if (!pvpBox && !ffaBox) return;
    if (hint) hint.textContent = rooms.length === 0 ? '还没有开着的房间 —— 当第一个吧' : '';
    const modeLabel = (m: string): string => {
      if (m === 'ffa') return '大乱斗';
      const a = /^arena(\d+)v\d+$/.exec(m);
      if (a) return `竞技场 ${a[1]}v${a[1]}`;
      const c = /^ctf(\d+)v\d+$/.exec(m);
      if (c) return `夺旗 ${c[1]}v${c[1]}`;
      return m;
    };
    /**
     * ★★ W24：进行中的房间不再是一行灰字。此前这里写死「对局进行中」＋
     *   不给任何按钮 —— 而服务器从本批起对 `started` 房间的 `JoinRoom`
     *   语义就是**入场观战**，能不能上场看 `joinableSeats`。
     * ★ 两颗键发的是同一条消息（`join-listed`），区别只在
     *   `data-intent`：带 `play` 的那颗在入场后自动弹席位面板 ——
     *   点「观战」的人不该被一个面板糊在脸上。
     */
    const row = (r: (typeof rooms)[number]): string => {
      const act = roomRowActions(r);
      const code = escapeHtml(r.roomId);
      const buttons = [
        act.spectate
          ? `<button class="lb-btn lb-small lb-ghost" data-action="join-listed"
                     data-code="${code}" data-intent="watch"
                     title="观战不占战斗席，满员的房间也看得了">观战</button>`
          : '',
        act.join
          ? `<button class="lb-btn lb-small" data-action="join-listed"
                     data-code="${code}" data-intent="${r.started ? 'play' : 'room'}"
                     >${escapeHtml(act.joinLabel)}</button>`
          : '',
      ].join('');
      return `
      <div class="lb-row lb-fine lb-room-row">
        <b class="lb-code" style="font-size:13px">${code}</b>
        <span>${modeLabel(r.mode)}</span>
        <span>${r.players}/${r.capacity} 人${r.fillWithBots ? '（人机补位）' : ''}</span>
        ${r.started ? '<span style="opacity:.6">进行中</span>' : ''}
        ${buttons}
      </div>`;
    };
    const ffa = rooms.filter((r) => r.mode === 'ffa');
    const pvp = rooms.filter((r) => r.mode !== 'ffa');
    if (pvpBox) pvpBox.innerHTML = pvp.map(row).join('') || '<div class="lb-fine lb-empty">暂无组队房间</div>';
    if (ffaBox) ffaBox.innerHTML = ffa.map(row).join('') || '<div class="lb-fine lb-empty">暂无大乱斗房间</div>';
  }

  private join(code: string, creating: boolean): void {
    const nameInput = this.root.querySelector('#lb-name') as HTMLInputElement | null;
    this.name = sanitizeName(nameInput?.value ?? '') || '玩家';
    this.saveName(this.name);
    this.roomCode = code;
    this.pendingJoin = { code, creating };
    if (this.conn.connected) {
      this.sendJoin();
    } else {
      /**
       * ⚠️ P10：提示条得**活过整个重连退避**（250+500+1000+2000+4000 ≈ 7.75s
       * 外加六次握手），否则它先消失、失败提示还没到，中间那段又是静默。
       * 12000 是占位值：按最坏一次退避走完再留点余量取的。
       */
      this.toast(creating ? '正在创建房间…' : '正在加入房间…', 12000);
      this.setTitleBusy(true);
      this.conn.connect();
    }
  }

  /**
   * P10：建/加房这段时间把两个联机按钮压灰。「点了没反应」和「点了正在连」
   * 在标题页上原本长得一模一样 —— 而失败时必须再点得动（见 onClose）。
   */
  private setTitleBusy(busy: boolean): void {
    for (const el of this.root.querySelectorAll<HTMLButtonElement>(
      '[data-action="create"], [data-action="join"], [data-action="create-ffa"], [data-action="quick-arena"], [data-action="quick-ctf"]',
    )) {
      el.disabled = busy;
    }
  }

  private sendJoin(): void {
    if (!this.pendingJoin) return;
    // 建房 = 加入一个不存在的房间：服务器 onJoin 本来就会创建（零新协议）
    this.conn.send({ t: 'JoinRoom', roomId: this.pendingJoin.code, name: this.name });
  }

  // ── 对局生命周期 ──────────────────────────────────────────────

  private onMatchStart(msg: Extract<ServerMessage, { t: 'MatchStart' }>): void {
    this.matchStarts++;
    this.destroyMatch(); // 观战/边缘态下可能还挂着上一场
    // ★ 清掉上一局的统计 —— 不清的话第二局结束时会短暂显示上一局的表
    this.summary = undefined;
    /**
     * ★★ W24：`spectating` 决定这一场**建的是哪一种场景**。中途加入成功时
     *   服务器会**再发一条**不带 `spectating` 的 MatchStart —— 于是这里
     *   自然地把观战场景整个销毁、按参战重建（「一局一场景」的老规矩本来
     *   就在做这件事，不需要给场景加一条「从观战变成参战」的状态迁移）。
     */
    this.spectating = msg.spectating === true;
    this.midJoinOpen = false;

    const root = document.createElement('div');
    root.id = 'match-root';
    const canvas = document.createElement('canvas');
    canvas.id = 'view'; // 与两条老路同一个 id —— index.html 的画布样式直接生效
    root.appendChild(canvas);
    this.app.appendChild(root);
    this.matchRoot = root;

    const self = this.self();
    /**
     * ★★ W24 中途加入时**名单还是旧的**（服务器的顺序是 Welcome →
     *   MatchStart → RoomState），所以自己那一行要分两种情况读：
     *   · **顶替人机**：`playerId` 已经换成那个席位的 id（服务器刚发的
     *     Welcome），旧名单里那一行正是被顶替的人机 —— 队伍与
     *     **当场生效的职业**（人机那个）都在里面，读它就对；
     *   · **坐空席位**：`playerId` 没变，名单里的自己还是观战席条目
     *     （没有队伍、没有职业）→ 退回刚发出去的那条 `JoinOngoing`。
     *   两种情况下 `classId` 拿到的都是**这具身体真正的职业**，自己的
     *   角色模型因此不会挂错。★ 挂错也不再是整局错了（W24 收口后
     *   `CharacterView.setClass` 认「职业变了」而不是「调过一次」，
     *   场景每帧按快照的 `classId` 复核一次）—— 但那是兜底，不是理由：
     *   开场先挂一具错职业的身体，玩家看得见。
     */
    const req = this.midJoinRequest;
    const team: 'red' | 'blue' = self?.team === 'blue'
      ? 'blue'
      : self?.team === 'red' ? 'red' : (req?.team ?? 'red');
    const classId = (self?.classId as string | undefined) ?? req?.classId ?? 'mage';
    const scene = new NetworkScene(canvas, {
      url: this.opts.serverUrl,
      roomId: this.roomCode,
      name: this.name,
      team,
      classId,
      spectating: this.spectating,
      // ★ 玩家**选的**那个职业（可能与上面那个不同 = 顶替了人机，还没生效）
      ...(req ? { requestedClassId: req.classId } : {}),
      link: this.conn, // ★ 借用大厅的连接 —— 场景不再自建（NetLink 边界）
    });
    // 请求已兑现（成功 = 这条 MatchStart）：不留到下一局去解释一个不存在的顶替
    if (!this.spectating) this.midJoinRequest = undefined;
    this.scene = scene;
    // 与 ?net= 老路同名暴露，诊断脚本两条路通用
    (globalThis as Record<string, unknown>)['__net'] = scene;
    scene.start();
    scene.deliver(msg); // MatchStart 本体交给场景做 bootstrap（地图/预测器/实体 id）

    this.preview?.stop();
    this.quickStart = false; // 直通完成 —— 战后回到的是正常的（大乱斗版）房间页
    this.clearToast();
    this.page = 'match';
    /**
     * W24：房间列表上点的是「加入」的人，入场即把席位面板摊开 ——
     * 他要的是上场，不是看别人打。点「观战」的人只拿到右上角一颗小按钮。
     */
    if (this.spectating && this.wantsToPlay) this.midJoinOpen = true;
    this.wantsToPlay = false;
    this.render();
  }

  /** 一局一场景：回房间就整场销毁，上一局的状态从根上不存在 */
  private destroyMatch(): void {
    this.scene?.dispose();
    this.scene = undefined;
    (globalThis as Record<string, unknown>)['__net'] = undefined;
    this.matchRoot?.remove();
    this.matchRoot = undefined;
  }

  // ── 渲染 ──────────────────────────────────────────────────────

  /** P3c：当前所选职业「存档 ∪ 默认前 9」的技能栏（与 NetworkScene 同口径）*/
  private lobbySkillBar(): readonly SkillDef[] {
    const classId = this.self()?.classId as string | undefined;
    const cls = classId ? getClass(classId as never) : undefined;
    if (!classId || !cls) return [];
    const defaults = cls.skills.slice(0, SKILL_BAR_SLOTS).map((sk) => sk.id as string);
    const ids = loadSkillBar(
      globalThis.localStorage, classId, defaults,
      new Set(cls.skills.map((sk) => sk.id as string)),
    );
    return ids
      .map((id) => cls.skills.find((sk) => (sk.id as string) === id))
      .filter((sk): sk is SkillDef => sk !== undefined);
  }

  private self(): RoomPlayerView | undefined {
    return this.players.find((p) => p.id === this.playerId);
  }

  private render(): void {
    // 页面可见性：match 阶段大厅整个让位（end 横幅例外，浮在战场上方）
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-page]')) {
      const page = el.dataset['page'] as Page;
      if (page === 'end') el.hidden = this.page !== 'end';
      else el.classList.toggle('active', page === this.page);
    }

    // W24：席位面板是浮层，任何一页切换后都要复核一次它该不该在
    this.renderMidJoin();
    if (this.page === 'room' || this.page === 'class') this.renderRoom();
    if (this.page === 'class') this.renderClassSelection();
    if (this.page === 'end') {
      (this.root.querySelector('#lb-end-title') as HTMLElement).textContent =
        `对局结束 —— ${this.endText}`;
      /**
       * 16a 结算面板。★ 没收到统计时**如实留空**，不画一张全 0 的表 ——
       * 全 0 的表看起来像「这局你什么都没做」，而真相是「数据没送到」。
       * W12：夺旗对局多三列（模式从刚打完这局的地图 family 判 ——
       * RoomState 在 MatchEnd 后原样带回 mapId，这里读到的就是那局的图）。
       */
      (this.root.querySelector('#lb-summary') as HTMLElement).innerHTML = this.summary
        ? renderMatchSummary({
            ...this.summary,
            ctf: this.mapId !== undefined && MAP_BY_ID.get(this.mapId as string)?.family === 'ctf',
          })
        : '';
    }
  }

  /**
   * W24 席位面板（观战中才存在）。
   *
   * ★★ **余量全部现算**，一份都不缓存：`RoomState` 每广播一次就变一次
   *   （有人中途加入、有人掉线被人机接管）。缓存一份的后果是玩家点了一个
   *   两秒前还空着的席位，然后吃一条拒绝 —— 而那正是这块面板要消灭的东西。
   * ★ 它只是**门面**：能不能坐下由服务器 `onJoinOngoing` 说了算，被拒时
   *   服务器给的那句话可以直接展示（「红方没有可加入的席位——蓝方还有
   *   2 个，换一边试试」），客户端一个判据都不复述。
   */
  private renderMidJoin(): void {
    const openBtn = this.root.querySelector('#lb-midjoin-open') as HTMLElement | null;
    const box = this.root.querySelector('#lb-midjoin') as HTMLElement | null;
    if (!openBtn || !box) return; // 老布局/单测桩：整块跳过（与房间列表同则）
    const active = this.page === 'match' && this.spectating;
    openBtn.hidden = !active || this.midJoinOpen;
    box.hidden = !active || !this.midJoinOpen;
    if (box.hidden) return;

    const seats = midJoinSeats(this.players, {
      mode: this.mode,
      teamSize: this.mode ? teamSizeOf(this.mode) : 0,
    });
    // 默认落在第一个坐得下的席位上（都坐不下就不预选，按钮自然是灰的）
    if (this.midJoinTeam === undefined || !seats.some((s) => s.team === this.midJoinTeam && s.selectable)) {
      this.midJoinTeam = seats.find((s) => s.selectable)?.team;
    }
    this.midJoinClass ??= ALL_CLASSES[0]!.id as string;

    (this.root.querySelector('#lb-midjoin-seats') as HTMLElement).innerHTML = seats
      .map((s) => `
        <button class="lb-btn lb-small${s.team === this.midJoinTeam ? ' lb-armed' : ''}"
                data-action="midjoin-team" data-team="${s.team}"
                ${s.selectable ? '' : 'disabled'}
                title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}
          <i class="lb-fine">${s.free + s.bots}</i></button>`).join('');

    const chosen = seats.find((s) => s.team === this.midJoinTeam);
    const family = this.mapId !== undefined
      ? MAP_BY_ID.get(this.mapId as string)?.family
      : undefined;
    // 顶替人机才有「职业延后生效」这一说 —— 有空位时不吓唬人
    const takeover = chosen && chosen.free === 0 && chosen.bots > 0
      ? midJoinTakeoverHint(family)
      : null;
    (this.root.querySelector('#lb-midjoin-why') as HTMLElement).textContent = chosen
      ? `${chosen.hint}${takeover ? ` · ${takeover}` : ''}`
      : '这局暂时没有可加入的席位 —— 继续观战，有人离开时再试';

    (this.root.querySelector('#lb-midjoin-classes') as HTMLElement).innerHTML = ALL_CLASSES
      .map((c) => `
        <button class="lb-btn lb-small${(c.id as string) === this.midJoinClass ? ' lb-armed' : ''}"
                data-action="midjoin-class"
                data-class="${c.id as string}">${escapeHtml(c.name)}</button>`).join('');

    const go = this.root.querySelector('#lb-midjoin-go') as HTMLButtonElement;
    go.disabled = this.midJoinTeam === undefined;
  }

  private renderRoom(): void {
    (this.root.querySelector('#lb-room-code') as HTMLElement).textContent = this.roomCode;
    (this.root.querySelector('#lb-share') as HTMLInputElement).value = this.shareUrl();

    const mapName = this.mapId ? MAP_BY_ID.get(this.mapId as string)?.name ?? this.mapId : '';
    const size = this.mode ? teamSizeOf(this.mode) : 0;
    const metaCtf = this.mapId !== undefined
      && MAP_BY_ID.get(this.mapId as string)?.family === 'ctf';
    // X10 二轮：大乱斗判断提前 —— meta/名单/整排 PVP 控件都要按它分家
    const isFfa = (this.mode as string | undefined) === 'ffa';
    // W12：夺旗房间不该顶着「经典竞技场」的帽子（预设在夺旗里不生效）；
    // 大乱斗同理 —— 它也没有 NvN，人数写的是「几人参战」
    const modeLabel = isFfa
      ? '大乱斗'
      : metaCtf
        ? '夺旗战场'
        : this.preset === ArenaPreset.Armed ? '武装竞技场' : '经典竞技场';
    const sizeLabel = isFfa
      ? `${this.players.filter((p) => p.team !== 'spectator').length} 人参战`
      : `${size}v${size}`;
    (this.root.querySelector('#lb-room-meta') as HTMLElement).textContent = this.mode
      ? `${modeLabel} ${sizeLabel} · ${mapName}${this.roomStarted ? ' · 对局进行中' : ''}`
      : '';

    const roster = splitRoster(this.players);
    const column = (title: string, list: RoomPlayerView[], cap: number | null, cls: string): string => `
      <div class="lb-col ${cls}">
        <h3>${title}${cap === null ? '' : ` <i>${list.length}/${cap}</i>`}</h3>
        <ul>${
          list.length === 0
            ? '<li class="lb-empty">（空）</li>'
            : list.map((p) => this.rosterRow(p)).join('')
        }</ul>
      </div>`;
    // 大乱斗没有红蓝：战斗席合并成一列「参战者」（红蓝槽都算 —— 服务器
    // createMatch 的 ffa 分支本来就只看「在不在战斗槽」）
    (this.root.querySelector('#lb-roster') as HTMLElement).innerHTML = isFfa
      ? column('参战者', [...roster.red, ...roster.blue], null, 'lb-col-red') +
        column('观战席', roster.spectators, null, '')
      : column('红方', roster.red, size || null, 'lb-col-red') +
        column('蓝方', roster.blue, size || null, 'lb-col-blue') +
        column('观战席', roster.spectators, null, '');

    // 阵容提示（缺治疗等）是组队口径 —— 人人为敌的大乱斗不适用
    (this.root.querySelector('#lb-hints') as HTMLElement).innerHTML =
      isFfa ? '' : this.hintsHtml();

    const self = this.self();
    const classBtn = this.root.querySelector('#lb-class-btn') as HTMLElement;
    classBtn.textContent = self?.classId
      ? `职业：${getClass(self.classId)?.name ?? self.classId}`
      : '选择职业';

    const isHost = this.hostId !== undefined && self?.id === this.hostId;
    const isCtf = this.mapId !== undefined
      && MAP_BY_ID.get(this.mapId as string)?.family === 'ctf';

    /**
     * W12 模式选择。★ 与预设同一条显示规矩：非房主看得到、点不动。
     */
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('#lb-modes [data-mode]')) {
      el.classList.toggle('lb-armed', el.dataset['mode'] === (this.mode as string | undefined));
      el.disabled = !isHost || this.roomStarted;
    }
    /**
     * P12 人数滑杆与 RoomState 同步 —— 权威值来自服务器广播（W12 的口径：
     * 「不是本地记的按钮」），非房主看得到拖不动。夺旗模式下滑杆归位到
     * 上次的竞技场档但不高亮（当前模式是夺旗，滑杆只是待命）。
     */
    {
      const slider = this.root.querySelector('#lb-size') as HTMLInputElement | null;
      const label = this.root.querySelector('#lb-size-label') as HTMLElement | null;
      const m = /^arena(\d+)v\d+$/.exec((this.mode as string | undefined) ?? '');
      if (slider && label) {
        if (m) {
          slider.value = m[1]!;
          label.textContent = `${m[1]}v${m[1]}`;
        }
        slider.disabled = !isHost || this.roomStarted;
        label.style.opacity = m ? '1' : '.5';
      }
    }
    /**
     * P12 大乱斗的房间页适配：没有「双方」——
     * 红方按钮改叫「参战」，蓝方按钮藏起来（发 SelectTeam blue 也没意义，
     * createMatch 的 ffa 分支只按「在不在战斗槽」分独立阵营）。
     */
    {
      const redBtn = this.root.querySelector('[data-action="team"][data-team="red"]');
      const blueBtn = this.root.querySelector('[data-action="team"][data-team="blue"]');
      if (redBtn) redBtn.textContent = isFfa ? '参战' : '红方';
      if (blueBtn) (blueBtn as HTMLElement).hidden = isFfa;
      const teamLabelEl = this.root.querySelector('#lb-team-label') as HTMLElement | null;
      if (teamLabelEl) teamLabelEl.textContent = isFfa ? '席位：' : '阵营：';
    }
    /**
     * X10 二轮：大乱斗房间隐藏 PVP 专属控件（人数档 / 夺旗 / 规则预设）。
     * ⚠️ 用 style.display 而不是 hidden 属性 —— .lb-row 的 display:flex
     *   （作者样式）会压过 UA 的 [hidden]{display:none}，hidden 会静默失效
     *   （.lb-end[hidden] 那条同款教训）。
     */
    (this.root.querySelector('#lb-pvp-modes') as HTMLElement).style.display =
      isFfa ? 'none' : 'contents';
    (this.root.querySelector('#lb-preset-row') as HTMLElement).style.display =
      isFfa ? 'none' : '';
    (this.root.querySelector('#lb-mode-why') as HTMLElement).textContent = isCtf
      ? '夺旗：拔起敌方旗帜送回己方基地（G 交互）'
      : isFfa
        ? `大乱斗：人人为敌，先杀满目标数获胜（至多 ${FFA.MAX_PLAYERS} 人）`
        : (isHost ? '' : '由房主设置');

    /**
     * P5 选图行。★ 选项**每次渲染现算** —— 它随人数档变（密林祭坛只在
     *   3v3–5v5 出现），缓存一份就会出现「拖完滑杆还挂着上一档的图」。
     * ★ 高亮的是 `RoomState` 广播回来的 `mapId`（W12 那条口径：
     *   「不是本地记的按钮」），非房主看得到、点不动。
     * ⚠️ 整行用 style.display 控制显隐而不是 hidden 属性 —— .lb-row 的
     *    display:flex 会压过 UA 的 [hidden]{display:none}（X10 二轮同款教训）。
     */
    {
      const rowEl = this.root.querySelector('#lb-map-row') as HTMLElement | null;
      const boxEl = this.root.querySelector('#lb-maps') as HTMLElement | null;
      const visible = showMapRow(this.mode);
      if (rowEl) rowEl.style.display = visible ? '' : 'none';
      if (boxEl && visible && this.mode) {
        const options = mapOptionsFor(this.mode);
        /**
         * ⚠️ **只在选项集合真的变了时才重建 innerHTML。**
         *   render() 每来一条 RoomState 就跑一遍，而房主点完地图必然紧跟一条 ——
         *   无条件重建会把刚点的那颗按钮连同焦点一起换掉（键盘用户从此
         *   每选一次图就被弹回页首）。高亮与禁用是**属性**，逐颗改即可。
         */
        const key = `${this.mode as string}|${options.map((o) => o.id).join(',')}`;
        if (key !== this.mapRowKey) {
          this.mapRowKey = key;
          boxEl.innerHTML = options.map((o) => `
            <button class="lb-btn lb-small" data-action="map" data-map="${escapeHtml(o.id)}"
                    title="${escapeHtml(o.detail || o.name)}">${escapeHtml(o.name)}${
              o.subtitle ? ` <i class="lb-fine">${escapeHtml(o.subtitle)}</i>` : ''
            }</button>`).join('');
        }
        for (const el of boxEl.querySelectorAll<HTMLButtonElement>('[data-action="map"]')) {
          el.classList.toggle('lb-armed', el.dataset['map'] === (this.mapId as string | undefined));
          el.disabled = !isHost || this.roomStarted;
        }
        /**
         * ★ 说明文字取地图数据里的 `terrain`，不另写一份 —— 手写的那份
         *   会在地图改了之后变成谎话，而界面撒的谎没有任何测试会红。
         *   试炼环没声明地形，就退回「由房主设置」/空（不编一句）。
         */
        const current = options.find((o) => o.id === (this.mapId as string | undefined));
        (this.root.querySelector('#lb-map-why') as HTMLElement).textContent =
          current?.detail || (isHost ? '' : '由房主设置');
      }
    }

    /**
     * 10.1 规则预设。★ 非房主也**看得到**当前预设（它决定这局怎么打），
     *   只是按钮点不动 —— 隐藏起来会让队友不知道自己在打哪一种。
     * ★ W12：夺旗模式下整排禁用 —— 12.x 首版关闭临时装备，
     *   预设在夺旗里没有任何效果，可点会让人以为能开武装夺旗。
     */
    for (const [id, preset] of [
      ['#lb-preset-classic', ArenaPreset.Classic],
      ['#lb-preset-armed', ArenaPreset.Armed],
    ] as const) {
      const el = this.root.querySelector(id) as HTMLButtonElement;
      el.classList.toggle('lb-armed', !isCtf && this.preset === preset);
      el.disabled = !isHost || this.roomStarted || isCtf;
    }
    (this.root.querySelector('#lb-preset-why') as HTMLElement).textContent = isCtf
      ? '夺旗战 · 波次复活 · 经验商店 · BOSS 战利品 · 随机补给'
      : this.preset === ArenaPreset.Armed
        ? '场上会刷军械箱与掉落：G 交互、B 换武器、Z/X 用道具'
        : (isHost ? '纯职业对抗，不刷任何临时装备' : '由房主设置');

    /**
     * P5 人机补位与难度。与预设同一条显示规矩：非房主看得到、点不动。
     * ★ 开关高亮当前档 —— 房主点了没反馈的话，「到底开没开」只能开局赌一把。
     */
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-action="fill-bots"]')) {
      el.classList.toggle('lb-armed', (el.dataset['fill'] === 'on') === this.fillWithBots);
      el.disabled = !isHost || this.roomStarted;
    }
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-action="bot-diff"]')) {
      el.classList.toggle('lb-armed', el.dataset['diff'] === this.botDifficulty);
      el.disabled = !isHost || this.roomStarted || !this.fillWithBots;
    }
    (this.root.querySelector('#lb-bots-state') as HTMLElement).textContent =
      this.fillWithBots
        ? '开局时人数不足的席位由人机补满'
        : (isHost ? '开启后可单人开局练习' : '由房主设置');

    /**
     * 随机大 BOSS。同一条显示规矩（非房主看得到、点不动）。
     * ★ 文案里必须点出**掉落跟着规则预设走** —— 经典预设下开 BOSS 是
     *   「有 BOSS、没战利品」（验收 #28 不生成任何临时武装）。
     *   不说的话，房主会以为是掉落坏了。
     */
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('[data-action="boss"]')) {
      el.classList.toggle('lb-armed', (el.dataset['boss'] === 'on') === this.bossEnabled);
      el.disabled = !isHost || this.roomStarted || isCtf || this.mode === GameMode.Ffa;
    }
    (this.root.querySelector('#lb-boss-state') as HTMLElement).textContent =
      isCtf ? '60 秒首次刷新 · 击杀获得全队经验与装备掉落' : this.bossEnabled
        ? (this.preset === ArenaPreset.Armed
            ? '开局 60 秒后刷新中立大 BOSS，击杀掉落装备与积分'
            : '开局 60 秒后刷新中立大 BOSS（战利品需切到武装竞技场）')
        : (isHost ? '开启后地图里会随机刷新中立大 BOSS' : '由房主设置');

    const blocker = readyBlocker(self);
    const readyBtn = this.root.querySelector('#lb-ready-btn') as HTMLButtonElement;
    /**
     * X10 追加轮（用户：「选完职业+人机应该立刻就可以启动」）：
     * 开着人机补位、且房里没有第二个真人参战者时，「准备」在语义上就是
     * 「开始」—— 点了它 canStart 立即成立、服务器立刻开局。按钮照实改名，
     * 不然单人房主不知道点「准备」就等于开局（发的消息还是 SetReady，
     * 协议一字不动）。有第二个真人时保持「准备」：那才真是在等人。
     */
    const soloWithBots = this.fillWithBots
      && !this.players.some((p) => p.id !== this.playerId && p.connected && p.team !== 'spectator');
    readyBtn.textContent = self?.ready
      ? '取消准备'
      : soloWithBots ? '⚔ 开始对局（人机补位）' : '准备';
    readyBtn.disabled = blocker !== null && !self?.ready;
    readyBtn.classList.toggle('lb-armed', self?.ready === true);
    (this.root.querySelector('#lb-ready-why') as HTMLElement).textContent =
      self?.ready
        ? '等待其他玩家…'
        : blocker ?? (soloWithBots ? '其余席位由人机补满，点开始即刻开局' : '全员准备即开局');
  }

  private renderClassSelection(): void {
    const chosen = this.self()?.classId as string | undefined;
    for (const card of this.root.querySelectorAll<HTMLElement>('.lb-card')) {
      card.classList.toggle('selected', card.dataset['class'] === chosen);
    }
    // 快速开始的选职业页换口径：这里就是开局前的最后一步，不是房间的配菜
    (this.root.querySelector('#lb-class-title') as HTMLElement).textContent =
      this.quickStart ? `${this.quickMode.startsWith('ctf') ? '夺旗战场' : this.quickMode === GameMode.Ffa ? '大乱斗' : '团队竞技场'} · 选择职业出战` : '选择职业';
    (this.root.querySelector('#lb-class-sub') as HTMLElement).hidden = !this.quickStart;
    (this.root.querySelector('#lb-class-sub') as HTMLElement).textContent = this.quickMode.startsWith('ctf')
      ? '先夺 3 旗获胜 · 阵亡后波次复活 · 人机补位'
      : this.quickMode === GameMode.Ffa ? '人人为敌 · 击杀达标获胜 · 人机补位' : '单回合淘汰 · 歼灭对方全队获胜 · 人机补位';
    (this.root.querySelector('#lb-class-back') as HTMLElement).textContent =
      this.quickStart ? '返回大厅' : '返回房间';
  }

  private rosterRow(p: RoomPlayerView): string {
    const cls = p.classId ? getClass(p.classId)?.name ?? '' : '未选职业';
    return `<li class="${p.connected ? '' : 'lb-off'}">
      <b>${escapeHtml(p.name)}</b>${p.id === this.playerId ? '<i>（你）</i>' : ''}
      <span>${escapeHtml(cls)}</span>
      <em class="${p.ready ? 'lb-ok' : ''}">${p.ready ? '已准备' : ''}</em>
    </li>`;
  }

  /**
   * 3.2 阵容提示：**只显示，永不阻止**。数据就是 RoomState，规则就是
   * shared 的 `compositionHints()` —— 这里拼一个最小 Room 形状喂给它，
   * 不复制第二份「什么算缺治疗」的判断。
   */
  private hintsHtml(): string {
    if (!this.mode || !this.mapId) return '';
    const room: Room = {
      id: this.roomCode,
      hostId: '',
      started: this.roomStarted,
      config: {
        mode: this.mode,
        mapId: this.mapId,
        preset: this.preset,
        roundsToWin: 1,
        allowUnbalanced: false,
        // ★ 这是给 `compositionHints()` 用的**只读**影子房间，不是真配置 ——
        //   人机补位不影响阵容提示（3.2 的提示只看真人名单）
        fillWithBots: false,
      },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.team,
        ...(p.classId !== undefined ? { classId: p.classId } : {}),
        ready: p.ready,
        connected: p.connected,
      })),
    };
    const hints = compositionHints(room);
    if (hints.length === 0) return '';
    return hints
      .map((h) => `<span class="lb-hint">${h.team === TEAM_RED ? '红方' : '蓝方'}：${escapeHtml(h.text)}（仅提示，不影响开始）</span>`)
      .join('');
  }

  private startQuick(mode: GameMode): void {
    this.quickMode = mode;
    this.pendingQuickMode = mode;
    this.quickStart = true;
    this.join(makeRoomCode(), true);
  }

  private titleHtml(): string {
    return `<section class="lb-page" data-page="title">
      <header class="lb-hero">
        <img class="lb-hero-image" src="/art/ui/screens/courtyard.jpg?v=${SCREEN_REV}" alt="王冠庭院实机画面" fetchpriority="high"/>
        <div class="lb-hero-content"><span class="lb-season">王冠庭院</span><h1 class="lb-logo">WOWPVP</h1></div>
        <img class="lb-hero-figure" src="/art/ui/screens/classes/warrior-royal-v1.png?v=${SCREEN_REV}" alt="持剑盾的战士"/>
        <button class="lb-icon-button lb-settings" data-action="settings" title="设置" aria-label="设置">${iconSvg(Settings, 22)}</button>
      </header>
      <main class="lb-title-wrap">
        <div class="lb-section-heading"><h2>选择战场</h2><label class="lb-name-mini">昵称 <input id="lb-name" maxlength="12" value="${escapeHtml(this.name)}"/></label></div>
        <div class="lb-modes">
          <article class="lb-mode lb-mode-pvp">
            <img class="lb-mode-image" src="/art/ui/screens/arena.jpg?v=${SCREEN_REV}" alt="竞技场交战画面"/>
            <div class="lb-mode-content"><h2>${iconSvg(Swords, 22)}团队竞技场</h2>
              <p class="lb-mode-tag">阵亡淘汰 · 全队歼灭判胜负</p>
              <div class="lb-mode-controls"><select id="lb-quick-arena-mode" aria-label="竞技场人数">${[1, 2, 3, 4, 5].map(n => `<option value="arena${n}v${n}" ${n === 3 ? 'selected' : ''}>${n}v${n}</option>`).join('')}</select>
                <button class="lb-btn lb-cta" data-action="quick-arena">${iconSvg(Play)}开始竞技</button></div>
            </div>
          </article>
          <article class="lb-mode lb-mode-ctf">
            <img class="lb-mode-image" src="/art/ui/screens/battleground.jpg?v=${SCREEN_REV}" alt="双桥要塞夺旗战场"/>
            <div class="lb-mode-content"><h2>${iconSvg(Flag, 22)}夺旗战场</h2>
              <p class="lb-mode-tag">先夺 3 旗 · 波次复活</p>
              <p class="lb-mode-extra">BOSS 战利品 · 随机补给 · 经验商店</p>
              <div class="lb-mode-controls"><select id="lb-quick-ctf-mode" aria-label="夺旗人数">${[6, 8, 12].map(n => `<option value="ctf${n}v${n}">${n}v${n}</option>`).join('')}</select>
                <button class="lb-btn lb-cta" data-action="quick-ctf">${iconSvg(Play)}进入战场</button></div>
            </div>
          </article>
          <article class="lb-mode lb-mode-ffa">
            <img class="lb-mode-image" src="/art/ui/screens/skirmish.jpg?v=${SCREEN_REV}" alt="大乱斗实机画面"/>
            <div class="lb-mode-content"><h2>${iconSvg(Flame, 22)}大乱斗</h2>
              <p class="lb-mode-tag">人人为敌 · 击杀达标获胜</p>
              <div class="lb-mode-controls"><button class="lb-btn lb-cta" data-action="create-ffa">${iconSvg(Play)}快速开始</button></div>
            </div>
          </article>
        </div>
        <section class="lb-party-band"><div class="lb-section-heading"><h2>${iconSvg(Users)}好友对局</h2><button class="lb-btn lb-secondary-command" data-action="create">${iconSvg(Plus)}创建房间</button></div>
          <div class="lb-join"><input id="lb-code" maxlength="16" placeholder="房间码" aria-label="房间码" value="${escapeHtml(this.opts.joinCode ?? '')}"/>
            <button class="lb-btn" data-action="join">加入房间${iconSvg(ArrowRight)}</button>
            <button class="lb-icon-button" data-action="browse" title="刷新房间列表" aria-label="刷新房间列表">${iconSvg(RefreshCw)}</button><span id="lb-roomlist-hint"></span></div>
          <div class="lb-room-browser"><div><h3>团队房间</h3><div id="lb-roomlist-pvp" class="lb-roomlist"></div></div><div><h3>大乱斗房间</h3><div id="lb-roomlist-ffa" class="lb-roomlist"></div></div></div>
        </section>
        <section class="lb-training-band"><div class="lb-section-heading"><h2>训练与教学</h2></div><div class="lb-training-actions">
          <button class="lb-btn" data-action="tutorial">${iconSvg(BookOpen)}${tutorialLabel(this.tutorialCompleted())}</button>
          <button class="lb-btn" data-action="practice">${iconSvg(Target)}训练场 · 无限复活</button></div>
          <div id="lb-practice" class="lb-practice" hidden><div class="lb-row" id="lb-practice-classes">${ALL_CLASSES.map(c => `<button class="lb-btn lb-small${c.id === this.practiceClass ? ' lb-armed' : ''}" data-action="practice-class" data-class="${c.id}">${escapeHtml(c.name)}</button>`).join('')}</div>
            <div class="lb-row">${(['easy', 'normal', 'hard'] as const).map((d, i) => `<button class="lb-btn lb-small${d === 'normal' ? ' lb-armed' : ''}" data-action="practice-diff" data-diff="${d}">${['简单', '普通', '困难'][i]}</button>`).join('')}
              <button class="lb-btn lb-primary" data-action="practice-start">${iconSvg(Play)}开始练习</button></div></div>
        </section>
        ${isLocalDev() ? `<details class="lb-devrow"><summary>开发工具</summary><button class="lb-btn lb-small" data-action="dev-testbed">验收试验场</button><button class="lb-btn lb-small" data-action="dev-stress">压测台</button></details>` : ''}
      </main></section>`;
  }

  private classCardsHtml(): string {
    return ALL_CLASSES.map((c) => `
      <button class="lb-card" data-action="pick-class" data-class="${c.id as string}">
        <img class="lb-portrait" src="/art/ui/screens/classes/${c.id === 'warrior' ? 'warrior-royal-v1' : c.id}.png?v=${SCREEN_REV}" alt="${escapeHtml(c.name)}"/>
        <span class="lb-card-head"><b>${escapeHtml(c.name)}</b></span>
        <span class="lb-card-role">${escapeHtml(c.role)}</span>
        <span class="lb-card-skills">${c.skills
          .slice(0, 8)
          .map((s) => skillIconHtml(s, 22))
          .join('')}</span>
        <span class="lb-card-line">强项：${escapeHtml(c.strengths)}</span>
        <span class="lb-card-line lb-weak">弱项：${escapeHtml(c.weaknesses)}</span>
      </button>`).join('');
  }

  private showPreview(classId: string): void {
    if (!this.art) return; // ?art=off：预览整体缺席，卡片文字与图标照常
    const canvas = this.root.querySelector('#lb-preview-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this.preview ??= new ClassPreview(canvas);
    const nameEl = this.root.querySelector('#lb-preview-name') as HTMLElement;
    nameEl.textContent = getClass(classId as ClassId)?.name ?? '';
    void this.preview.show(classId).then((shown) => {
      // 素材缺失就把画布藏起来 —— 不摆假轮廓（M12 的缺席原则）
      canvas.hidden = !shown;
    });
  }

  private shareUrl(): string {
    return shareLink(location.origin, location.pathname, this.roomCode, this.opts.explicitServer);
  }

  // ── 杂项 ──────────────────────────────────────────────────────

  private toast(text: string, ms = 3200): void {
    const el = this.root.querySelector('#lb-toast') as HTMLElement;
    el.textContent = text;
    el.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  private clearToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    (this.root.querySelector('#lb-toast') as HTMLElement).hidden = true;
  }

  private loadSavedName(): string {
    try {
      const raw = globalThis.localStorage?.getItem(LOBBY_STORAGE_KEY);
      if (!raw) return this.generatedName();
      const parsed = JSON.parse(raw) as { name?: unknown };
      const saved = typeof parsed.name === 'string' ? sanitizeName(parsed.name) : '';
      return saved || this.generatedName();
    } catch {
      return this.generatedName();
    }
  }

  /**
   * X10 追加轮（用户：「不要一上来就是输入玩家姓名」）：首次进来直接发一个
   * 现成的昵称，改名变成**可选**动作（底栏小输入框），填表不再是第一步。
   * 生成即存 —— 下次进来还是同一个名字，不会每次换人。
   */
  private generatedName(): string {
    const n = `勇者${String(1000 + Math.floor(Math.random() * 9000))}`;
    this.saveName(n);
    return n;
  }

  private saveName(name: string): void {
    try {
      globalThis.localStorage?.setItem(LOBBY_STORAGE_KEY, JSON.stringify({ name }));
    } catch {
      /* 隐私模式等存不进去就算了 —— 下次再敲一遍昵称 */
    }
  }
}
