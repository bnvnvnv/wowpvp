/**
 * M12：音效与音乐（`assets/music/sfx/**`、`assets/music/music/**`）。
 *
 * ★★ **这一层对玩法是只读的。** 它订阅 `CombatDirector` 的事件钩子，
 *   不产生任何输入、不改任何状态 —— 音频加载失败、被浏览器策略拦下、
 *   或素材缺失，游戏行为完全不变。M1–M10 的 154 项验收不感知它的存在。
 *
 * ★★ **为什么用 WebAudio 而不是一堆 `<audio>`：**
 *   同一个音效会在一帧里被触发多次（AOE 命中 5 个人）。`<audio>` 元素
 *   重叠播放要么互相打断，要么得预先池化几十个元素；`AudioBufferSourceNode`
 *   天然是「一次性、可无限重叠」的，正好对应「音效」这个语义。
 *
 * ★ **浏览器自动播放策略**：AudioContext 在用户第一次交互前是 suspended。
 *   这里不做「静默失败」——`unlock()` 挂在首次 pointerdown/keydown 上，
 *   在此之前触发的音效直接丢弃（不排队），因为几秒后补播一串旧音效
 *   比没有声音更糟。
 *
 * ★ 14.1 的命中反馈由「音效 + 浮动数字 + 模型闪白」三条通道共同承担，
 *   任何一条缺失（关掉音量、关掉伤害数字）都不影响另外两条。
 */

import { School } from '@wowpvp/shared';
import {
  DEFAULT_VOLUMES, loadAudioSettings, saveAudioSettings, type AudioVolumes,
} from '../settings/audioSettings.js';
// 类型与默认值的家在 audioSettings.ts（依赖必须单向，见那边的注释）。
// 这里 re-export 维持既有导入路径不变。
export { DEFAULT_VOLUMES, type AudioVolumes } from '../settings/audioSettings.js';

type Group = keyof Omit<AudioVolumes, 'master'>;

/** 七个伤害学派 → 施法音。physical 没有「咏唱」，走挥砍 */
const CAST_SOUND: Record<School, string> = {
  arcane: 'cast_arcane',
  fire: 'cast_fire',
  frost: 'cast_frost',
  holy: 'cast_holy',
  nature: 'cast_nature',
  shadow: 'cast_shadow',
  physical: 'melee_swing_light_1',
};

/** 学派 → 命中音。physical 打在肉上 */
const IMPACT_SOUND: Record<School, string> = {
  arcane: 'impact_arcane',
  fire: 'impact_fire',
  frost: 'impact_frost',
  holy: 'impact_holy',
  nature: 'impact_nature',
  shadow: 'impact_shadow',
  physical: 'impact_flesh_1',
};

/** 随机变体组：同一事件反复触发时轮换，避免机关枪式的重复感 */
const VARIANTS: Record<string, readonly string[]> = {
  hurt: ['player_hurt_1', 'player_hurt_2', 'player_hurt_3', 'player_hurt_4', 'player_hurt_5'],
  death: ['player_death_1', 'player_death_2', 'player_death_3'],
  jump: ['move_jump_1', 'move_jump_2', 'move_jump_3', 'move_jump_4', 'move_jump_5'],
  land: ['move_land_1', 'move_land_2', 'move_land_3', 'move_land_4'],
  step: ['foot_stone_1', 'foot_stone_2', 'foot_stone_3', 'foot_stone_4', 'foot_stone_5'],
  swing: [
    'melee_swing_blade_1', 'melee_swing_blade_2', 'melee_swing_blade_3',
    'melee_swing_blade_4', 'melee_swing_blade_5', 'melee_swing_blade_6', 'melee_swing_blade_7',
  ],
  flesh: ['impact_flesh_1', 'impact_flesh_2', 'impact_flesh_3', 'impact_flesh_4'],
  parry: ['combat_parry_1', 'combat_parry_2', 'combat_parry_3'],
  dodge: ['combat_dodge_1', 'combat_dodge_2', 'combat_dodge_3'],
  block: ['combat_block_1', 'combat_block_2', 'combat_block_3'],
  // ── 打击感分层（叠在基础命中音之上，不是替代）────────────────
  // ★ 分层的每一层必须是**不同文件名**：play() 的 40ms 同名去重会吃掉
  //   与基础层重名的叠加层 —— 所以重击层叫 bone 而不是再来一次 flesh
  /** 暴击专用尖锐层 */
  crit: ['combat_crit_1', 'combat_crit_2', 'combat_crit_3'],
  /** 重击的低频骨感层 */
  bone: ['impact_bone_1', 'impact_bone_2', 'impact_bone_3', 'impact_bone_4'],
  /** 格挡的金属层 */
  metal: ['impact_metal_1', 'impact_metal_2', 'impact_metal_3', 'impact_metal_4'],
  /** 闪避的皮革掠过层 */
  leather: ['impact_leather_1', 'impact_leather_2', 'impact_leather_3', 'impact_leather_4'],
};

export interface PlayOptions {
  group?: Group;
  /** 0–1 的额外增益 */
  volume?: number;
  /** 播放速率，用于同一音效的音高变化 */
  rate?: number;
  /**
   * 到听者的距离（米）。给了就按距离衰减 ——
   * ★ 简单的线性衰减而不是 PannerNode：目标制战斗里「谁在打我」
   *   靠 HUD 和姓名板表达，方位音只会让声音在镜头旋转时飘忽。
   */
  distance?: number;
}

/** 超过这个距离完全听不见。RANGE.MAX_SELECT 是 45 米，取略大一点 */
const MAX_AUDIBLE = 55;

export class AudioManager {
  private ctx: AudioContext | undefined;
  private masterGain: GainNode | undefined;
  private readonly groupGains = new Map<Group, GainNode>();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private volumes: AudioVolumes = { ...DEFAULT_VOLUMES };
  private muted = false;
  /** 持久化存储（attachStorage 挂上）。undefined = 不落盘，行为与从前一致 */
  private storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  private unlocked = false;
  private variantCursor = new Map<string, number>();
  /** 同名音效的最小间隔（秒），挡住一帧内的重复触发叠成爆音 */
  private readonly lastPlayed = new Map<string, number>();
  private music: AudioBufferSourceNode | undefined;
  private musicGain: GainNode | undefined;
  private disposed = false;

  /**
   * 挂上「首次交互解锁」。★ 幂等 —— 场景重建时重复调用不会叠加监听器。
   */
  install(): void {
    // ★ `installed` 与 `unlocked` 是两回事：install 到 unlock 之间有一段
    //   等用户交互的窗口，只看 unlocked 的话这段时间里重复调用会**再挂一对**
    //   监听器，而解锁时只摘得掉其中一对
    if (this.installed || this.disposed) return;
    // 音量与静音的持久化（速赢清单第 1 项）。install 本就只在浏览器里跑
    try { this.attachStorage(window.localStorage); } catch { /* 隐私模式等拿不到就算了 */ }
    this.installed = true;
    const unlock = (): void => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      this.unlocked = true;
      void this.ensureContext()?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }
  private installed = false;

  /**
   * 挂上持久化存储：立即恢复上次的音量与静音状态，此后每次变更自动落盘。
   * ★ `install()` 会自动挂 `window.localStorage`；参数化是给测试留的口
   *   （与 `accessibility.ts` 的 load/save 同一模式）。幂等。
   */
  attachStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): void {
    if (this.storage) return;
    this.storage = storage;
    const s = loadAudioSettings(storage);
    this.volumes = s.volumes;
    this.muted = s.muted;
    this.applyGains();
  }

  private persist(): void {
    saveAudioSettings(this.storage, { volumes: { ...this.volumes }, muted: this.muted });
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    this.volumes = { ...this.volumes, ...v };
    this.applyGains();
    this.persist();
  }

  get volumeSettings(): AudioVolumes {
    return { ...this.volumes };
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyGains();
    this.persist();
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * 播放一个音效。
   *
   * ★ 未解锁 / 素材缺失 / 距离过远 都是**静默返回**，不抛异常 ——
   *   音频是表现层的锦上添花，任何失败都不该冒泡到调用点。
   */
  play(name: string, opts: PlayOptions = {}): void {
    if (!this.unlocked || this.muted || this.disposed) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    // 距离衰减：超出可听范围直接不加载，省掉一次网络请求
    let distanceGain = 1;
    if (opts.distance !== undefined) {
      if (opts.distance > MAX_AUDIBLE) return;
      distanceGain = Math.max(0, 1 - opts.distance / MAX_AUDIBLE) ** 1.6;
    }

    // 去重窗口：同名音效 40ms 内只响一次（AOE 命中 5 个人不该是 5 声）
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < 0.04) return;
    this.lastPlayed.set(name, now);

    void this.buffer(name).then((buf) => {
      if (!buf || this.disposed) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = opts.rate ?? 1;
      const gain = ctx.createGain();
      gain.gain.value = (opts.volume ?? 1) * distanceGain;
      src.connect(gain).connect(this.groupGain(opts.group ?? 'sfx'));
      src.start();
    });
  }

  /** 从一个变体组里轮换播放（见 VARIANTS） */
  playVariant(group: keyof typeof VARIANTS, opts: PlayOptions = {}): void {
    const list = VARIANTS[group];
    if (!list || list.length === 0) return;
    const i = (this.variantCursor.get(group) ?? 0) % list.length;
    this.variantCursor.set(group, i + 1);
    // ★ 轮换 + 轻微随机音高：五个采样循环播也会听出周期，音高一晃就散了
    this.play(list[i]!, { rate: 0.94 + ((i * 37) % 13) / 100, ...opts });
  }

  /** 学派施法音（7.4 施法开始） */
  playCast(school: School, opts: PlayOptions = {}): void {
    this.play(CAST_SOUND[school] ?? 'cast_arcane', opts);
  }

  /** 学派命中音（14.1 命中反馈） */
  playImpact(school: School, opts: PlayOptions = {}): void {
    if (school === School.Physical) {
      this.playVariant('flesh', opts);
      return;
    }
    this.play(IMPACT_SOUND[school] ?? 'impact_arcane', opts);
  }

  /**
   * 背景音乐。循环、低音量、可被同名调用忽略。
   * ★ 与音效走**不同的增益组**：玩家最常做的一件事就是关音乐留音效。
   */
  playMusic(name: string): void {
    if (!this.unlocked || this.disposed) return;
    const ctx = this.ensureContext();
    if (!ctx || this.currentMusic === name) return;
    this.currentMusic = name;

    void this.buffer(name, 'music').then((buf) => {
      if (!buf || this.disposed || this.currentMusic !== name) return;
      /**
       * W13：旧曲 1 秒淡出再停 —— BGM 随战斗状态来回切换后，
       * 硬切会很刺耳（此前全场一首曲子，这条路径从来没走过第二次）。
       */
      const oldSrc = this.music;
      const oldGain = this.musicGain;
      if (oldSrc && oldGain) {
        oldGain.gain.setValueAtTime(oldGain.gain.value, ctx.currentTime);
        oldGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
        oldSrc.stop(ctx.currentTime + 1.05);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      // 淡入，避免开局一声突兀的鼓点
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(1, ctx.currentTime + 2);
      src.connect(g).connect(this.groupGain('music'));
      src.start();
      this.music = src;
      this.musicGain = g;
    });
  }
  private currentMusic: string | undefined;

  stopMusic(): void {
    this.currentMusic = undefined;
    this.music?.stop();
    this.music = undefined;
    this.musicGain = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = undefined;
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private ensureContext(): AudioContext | undefined {
    if (this.disposed) return undefined;
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext;
      if (!Ctor) return undefined; // 非浏览器环境（单测、SSR）
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this.applyGains();
    }
    return this.ctx;
  }

  private groupGain(g: Group): GainNode {
    let node = this.groupGains.get(g);
    if (!node) {
      const ctx = this.ensureContext()!;
      node = ctx.createGain();
      node.connect(this.masterGain!);
      this.groupGains.set(g, node);
      node.gain.value = this.volumes[g];
    }
    return node;
  }

  private applyGains(): void {
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.volumes.master;
    for (const [g, node] of this.groupGains) node.gain.value = this.volumes[g];
  }

  private buffer(name: string, kind: 'sfx' | 'music' = 'sfx'): Promise<AudioBuffer | null> {
    const key = `${kind}/${name}`;
    let p = this.buffers.get(key);
    if (!p) {
      p = (async () => {
        const ctx = this.ensureContext();
        if (!ctx) return null;
        try {
          const res = await fetch(`/music/${kind}/${name}.mp3`);
          if (!res.ok) return null;
          return await ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          // 素材可选：缺文件就没声音，不打日志刷屏（91 个技能会刷很多行）
          return null;
        }
      })();
      this.buffers.set(key, p);
    }
    return p;
  }
}

/** 全局单例。两个场景各自 install()，但共用缓冲区与解锁状态 */
export const audio = new AudioManager();
