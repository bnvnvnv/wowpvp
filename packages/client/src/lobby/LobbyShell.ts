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
 *   的状态」从根上不存在，而不是逐个字段去清（CharacterView.setClass 是
 *   幂等首调生效的，跨局复用场景会让换职业悄悄失效）。
 */

import {
  ALL_CLASSES,
  MAP_BY_ID,
  TEAM_RED,
  compositionHints,
  getClass,
  teamSizeOf,
  type ClassId,
  type GameMode,
  type MapId,
  type Room,
  type RoomPlayerView,
  type ServerMessage,
} from '@wowpvp/shared';
import { ArenaPreset } from '@wowpvp/shared';

import { audio } from '../audio/AudioManager.js';
import { skillIconHtml } from '../hud/skillIcon.js';
import { Connection } from '../net/Connection.js';
import { renderMatchSummary, type MatchSummaryData } from '../hud/MatchSummary.js';
import { NetworkScene } from '../scenes/NetworkScene.js';
import { clampUiScale, loadAccessibility, saveAccessibility } from '../settings/accessibility.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { TUTORIAL_STORAGE_KEY } from '../tutorial/steps.js';
import { artEnabled } from '../settings/artMode.js';
import { ClassPreview } from './ClassPreview.js';
import {
  escapeHtml,
  isJoinableCode,
  makeRoomCode,
  normalizeRoomCode,
  readyBlocker,
  sanitizeName,
  shareLink,
  splitRoster,
} from './logic.js';

/** 昵称的本地存档（照 accessibility 的 `wowpvp.<域>.v1` 键式）*/
const LOBBY_STORAGE_KEY = 'wowpvp.lobby.v1';

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
  private preset: ArenaPreset = ArenaPreset.Classic;
  /** 房主 id。只有他能改规则预设（服务器校验，这里只决定按钮亮不亮）*/
  private hostId: string | undefined;
  /** 16a 战后统计。★ 每局开始时清空 —— 否则第二局会显示上一局的数据 */
  private summary: MatchSummaryData | undefined;
  /** 点了建房/加房但连接还没通（或 JoinRoom 还没被答复）*/
  private pendingJoin: { code: string; creating: boolean } | undefined;

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
        if (!willRetry && this.page !== 'title') this.toast(`与服务器断开（${this.opts.serverUrl}）`);
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
    // 17.2 界面缩放：与 HUD 同一个 CSS 变量、同一个夹取函数
    this.root.style.setProperty(
      '--ui-scale',
      String(clampUiScale(loadAccessibility(globalThis.localStorage).uiScale)),
    );
    this.root.innerHTML = `
      <section class="lb-page" data-page="title">
        <div class="lb-panel lb-title">
          <h1>WOWPVP</h1>
          <p class="lb-sub">目标制 3D 竞技场 —— 打断、假读条与走位的反制博弈</p>
          <label>昵称
            <input id="lb-name" maxlength="12" placeholder="给自己起个名字" value="${escapeHtml(this.name)}"/>
          </label>
          <div class="lb-row">
            <button class="lb-btn lb-primary" data-action="create">创建房间</button>
          </div>
          <div class="lb-row lb-join">
            <input id="lb-code" maxlength="16" placeholder="房间码"
                   value="${escapeHtml(this.opts.joinCode ?? '')}"/>
            <button class="lb-btn" data-action="join">加入房间</button>
          </div>
          <hr/>
          <div class="lb-row">
            <button class="lb-btn" data-action="tutorial">${
              this.tutorialCompleted()
                ? '新手教学（已完成 ✓ 可重温）'
                : '新手教学（推荐先玩 · 尚未完成）'
            }</button>
          </div>
          <div class="lb-row">
            <button class="lb-btn lb-ghost" data-action="practice">试验场（单机练习）</button>
          </div>
          <div class="lb-row">
            <button class="lb-btn lb-ghost" data-action="settings">设置（音量 / 无障碍 / 键位）</button>
          </div>
          <p class="lb-fine">对局需要另一位玩家：创建房间后把房间码或链接发给朋友。</p>
        </div>
      </section>

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
              <span class="lb-fine">阵营：</span>
              <button class="lb-btn lb-small lb-red" data-action="team" data-team="red">红方</button>
              <button class="lb-btn lb-small lb-blue" data-action="team" data-team="blue">蓝方</button>
              <button class="lb-btn lb-small" data-action="team" data-team="spectator">观战</button>
              <button class="lb-btn lb-small" data-action="open-class" id="lb-class-btn">选择职业</button>
            </div>
            <!--
              10.1 规则预设。★ **没有这个开关，整个第 10 章不可达** ——
              房间默认经典竞技场，而经典竞技场按验收 #28 不生成任何临时武装，
              于是军械箱/掉落/换装/消耗品全都规则正确却永远不会出现在对局里。
              服务器只接受房主的这条消息（校验在 sim 的 setPreset 里）。
              ★ 注意这段是模板字符串里的 HTML —— 注释里不能出现反引号。
            -->
            <div class="lb-row">
              <span class="lb-fine">规则：</span>
              <button class="lb-btn lb-small" data-action="preset" data-preset="classic"
                      id="lb-preset-classic">经典竞技场</button>
              <button class="lb-btn lb-small" data-action="preset" data-preset="armed"
                      id="lb-preset-armed">武装竞技场</button>
              <span id="lb-preset-why" class="lb-fine"></span>
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
            <h2>选择职业</h2>
            <button class="lb-btn lb-small" data-action="back-room">返回房间</button>
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
        break;

      case 'RoomState': {
        this.players = msg.players;
        this.roomStarted = msg.started;
        this.mode = msg.mode;
        this.mapId = msg.mapId;
        this.preset = msg.preset;
        this.hostId = msg.hostId;
        if (this.pendingJoin) {
          // JoinRoom 的成功答复就是第一条 RoomState（协议没有单独的 ack）
          this.pendingJoin = undefined;
          this.page = 'room';
          this.clearToast();
        }
        if (this.page !== 'match') this.render();
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
        if (this.pendingJoin && msg.what === 'JoinRoom') {
          this.pendingJoin = undefined;
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
        this.join(makeRoomCode(), true);
        break;
      case 'join': {
        const code = normalizeRoomCode(
          (this.root.querySelector('#lb-code') as HTMLInputElement)?.value ?? '',
        );
        if (!isJoinableCode(code)) { this.toast('先填一个房间码'); return; }
        this.join(code, false);
        break;
      }
      case 'practice':
        /**
         * 试验场按钮 = 跳到 **URL 无参路径**（docs/14 §M13 交付物 3）。
         * 试验场仍是默认路径的验收载体，大厅不内嵌它、只跳过去 ——
         * 两条路径的启动代码因此零交集。
         */
        location.href = location.pathname;
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
      case 'open-class':
        this.page = 'class';
        this.render();
        this.showPreview((this.self()?.classId as string | undefined) ?? (ALL_CLASSES[0]!.id as string));
        break;
      case 'back-room':
        this.page = 'room';
        this.render();
        break;
      case 'pick-class': {
        const classId = btn?.dataset['class'];
        if (!classId) return;
        this.conn.send({ t: 'SelectClass', classId: classId as ClassId });
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

  private join(code: string, creating: boolean): void {
    const nameInput = this.root.querySelector('#lb-name') as HTMLInputElement | null;
    this.name = sanitizeName(nameInput?.value ?? '') || '玩家';
    this.saveName(this.name);
    this.roomCode = code;
    this.pendingJoin = { code, creating };
    if (this.conn.connected) {
      this.sendJoin();
    } else {
      this.toast(creating ? '正在创建房间…' : '正在加入房间…', 8000);
      this.conn.connect();
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

    const root = document.createElement('div');
    root.id = 'match-root';
    const canvas = document.createElement('canvas');
    canvas.id = 'view'; // 与两条老路同一个 id —— index.html 的画布样式直接生效
    root.appendChild(canvas);
    this.app.appendChild(root);
    this.matchRoot = root;

    const self = this.self();
    const scene = new NetworkScene(canvas, {
      url: this.opts.serverUrl,
      roomId: this.roomCode,
      name: this.name,
      team: self?.team === 'blue' ? 'blue' : 'red',
      classId: (self?.classId as string | undefined) ?? 'mage',
      link: this.conn, // ★ 借用大厅的连接 —— 场景不再自建（NetLink 边界）
    });
    this.scene = scene;
    // 与 ?net= 老路同名暴露，诊断脚本两条路通用
    (globalThis as Record<string, unknown>)['__net'] = scene;
    scene.start();
    scene.deliver(msg); // MatchStart 本体交给场景做 bootstrap（地图/预测器/实体 id）

    this.preview?.stop();
    this.page = 'match';
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

    if (this.page === 'room' || this.page === 'class') this.renderRoom();
    if (this.page === 'class') this.renderClassSelection();
    if (this.page === 'end') {
      (this.root.querySelector('#lb-end-title') as HTMLElement).textContent =
        `对局结束 —— ${this.endText}`;
      /**
       * 16a 结算面板。★ 没收到统计时**如实留空**，不画一张全 0 的表 ——
       * 全 0 的表看起来像「这局你什么都没做」，而真相是「数据没送到」。
       */
      (this.root.querySelector('#lb-summary') as HTMLElement).innerHTML =
        this.summary ? renderMatchSummary(this.summary) : '';
    }
  }

  private renderRoom(): void {
    (this.root.querySelector('#lb-room-code') as HTMLElement).textContent = this.roomCode;
    (this.root.querySelector('#lb-share') as HTMLInputElement).value = this.shareUrl();

    const mapName = this.mapId ? MAP_BY_ID.get(this.mapId as string)?.name ?? this.mapId : '';
    const size = this.mode ? teamSizeOf(this.mode) : 0;
    const presetLabel = this.preset === ArenaPreset.Armed ? '武装竞技场' : '经典竞技场';
    (this.root.querySelector('#lb-room-meta') as HTMLElement).textContent = this.mode
      ? `${presetLabel} ${size}v${size} · ${mapName}${this.roomStarted ? ' · 对局进行中' : ''}`
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
    (this.root.querySelector('#lb-roster') as HTMLElement).innerHTML =
      column('红方', roster.red, size || null, 'lb-col-red') +
      column('蓝方', roster.blue, size || null, 'lb-col-blue') +
      column('观战席', roster.spectators, null, '');

    (this.root.querySelector('#lb-hints') as HTMLElement).innerHTML = this.hintsHtml();

    const self = this.self();
    const classBtn = this.root.querySelector('#lb-class-btn') as HTMLElement;
    classBtn.textContent = self?.classId
      ? `职业：${getClass(self.classId)?.name ?? self.classId}`
      : '选择职业';

    /**
     * 10.1 规则预设。★ 非房主也**看得到**当前预设（它决定这局怎么打），
     *   只是按钮点不动 —— 隐藏起来会让队友不知道自己在打哪一种。
     */
    const isHost = this.hostId !== undefined && self?.id === this.hostId;
    for (const [id, preset] of [
      ['#lb-preset-classic', ArenaPreset.Classic],
      ['#lb-preset-armed', ArenaPreset.Armed],
    ] as const) {
      const el = this.root.querySelector(id) as HTMLButtonElement;
      el.classList.toggle('lb-armed', this.preset === preset);
      el.disabled = !isHost || this.roomStarted;
    }
    (this.root.querySelector('#lb-preset-why') as HTMLElement).textContent =
      this.preset === ArenaPreset.Armed
        ? '场上会刷军械箱与掉落：G 交互、B 换武器、Z/X 用道具'
        : (isHost ? '纯职业对抗，不刷任何临时装备' : '由房主设置');

    const blocker = readyBlocker(self);
    const readyBtn = this.root.querySelector('#lb-ready-btn') as HTMLButtonElement;
    readyBtn.textContent = self?.ready ? '取消准备' : '准备';
    readyBtn.disabled = blocker !== null && !self?.ready;
    readyBtn.classList.toggle('lb-armed', self?.ready === true);
    (this.root.querySelector('#lb-ready-why') as HTMLElement).textContent =
      self?.ready ? '等待其他玩家…' : blocker ?? '全员准备即开局';
  }

  private renderClassSelection(): void {
    const chosen = this.self()?.classId as string | undefined;
    for (const card of this.root.querySelectorAll<HTMLElement>('.lb-card')) {
      card.classList.toggle('selected', card.dataset['class'] === chosen);
    }
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

  private classCardsHtml(): string {
    return ALL_CLASSES.map((c) => `
      <button class="lb-card" data-action="pick-class" data-class="${c.id as string}">
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
      if (!raw) return '';
      const parsed = JSON.parse(raw) as { name?: unknown };
      return typeof parsed.name === 'string' ? sanitizeName(parsed.name) : '';
    } catch {
      return '';
    }
  }

  private saveName(name: string): void {
    try {
      globalThis.localStorage?.setItem(LOBBY_STORAGE_KEY, JSON.stringify({ name }));
    } catch {
      /* 隐私模式等存不进去就算了 —— 下次再敲一遍昵称 */
    }
  }
}
