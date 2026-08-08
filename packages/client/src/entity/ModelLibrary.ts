/**
 * M12：角色与武器模型库（`assets/art/models/**`，来源见 docs/09 §4）。
 *
 * ★★ **验收 #10「模型大小不改变碰撞体」在这里的落点：**
 *   碰撞体半径/高度只存在于 `shared` 的 `GEOMETRY` 常量里，sim 从不读模型 ——
 *   这层保证是结构性的，引入模型动不了它。本文件要守的是**视觉侧**的那半句：
 *   每个模型实例化时都按包围盒归一化到 `GEOMETRY.HITBOX_HEIGHT`，
 *   所以八个职业的视觉身高一致（13.2），不因源文件的建模比例不同而胖瘦有别。
 *
 * ★ **素材整体可选**：任何加载失败都返回 null，调用方（CharacterView）
 *   保留程序化胶囊体。M1–M10 的 154 项验收因此不依赖素材目录存在。
 *
 * ★ 模板缓存 + SkeletonUtils.clone：同一职业的 GLB 只解析一次，
 *   每个实例克隆骨架；材质逐实例克隆 —— 受击闪白（emissive）是实例状态，
 *   共享材质会让一个人挨打全场发光。
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneWithSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GEOMETRY } from '@wowpvp/shared';

/**
 * 八职业 → 玩家模型文件。上游恰好有八个外形互异的卡通人形模型（基调见规格书 13.2）。
 *
 * ★ 大 BOSS（`boss`）**故意不在表里**：素材包里没有巨怪，而
 *   `characterFor()` 查不到就返回 null，`CharacterView` 于是保留程序化胶囊 ——
 *   放大 2.2 倍、脑袋烧成熔岩色的那一只。这与「素材整体可选」是同一条兜底路径，
 *   不是缺陷。将来有模型了，在这里加一行即可。
 */
const CLASS_MODEL: Readonly<Record<string, string>> = {
  warrior: 'barbarian',
  paladin: 'paladin',
  deathknight: 'knight',
  rogue: 'rogue',
  hunter: 'ranger',
  mage: 'mage',
  priest: 'mage_classic',
  druid: 'druid',
};

/**
 * 武器 → 手部挂载。骨架带 `handslot.r` / `handslot.l` 空节点（上游约定）。
 * 弓与盾按持握习惯挂左手。文件相对 `/art/models/weapons/`。
 */
export interface WeaponAttachment {
  right?: string;
  left?: string;
}
const WEAPON_MODEL: Readonly<Record<string, WeaponAttachment>> = {
  'warrior.sword_shield': { right: 'adv_sword_1handed', left: 'shield_round' },
  'warrior.greatsword': { right: 'adv_sword_2handed' },
  'warrior.dual_swords': { right: 'adv_sword_1handed', left: 'adv_sword_1handed' },
  'paladin.sword_shield': { right: 'adv_sword_1handed', left: 'shield_round' },
  'paladin.two_hand_hammer': { right: 'hammer_a' },
  'paladin.scepter_codex': { right: 'adv_wand', left: 'spellbook_open' },
  'deathknight.runeblade_2h': { right: 'adv_sword_2handed' },
  'deathknight.dual_runeblades': { right: 'adv_sword_1handed', left: 'adv_sword_1handed' },
  'deathknight.runeblade_boneshield': { right: 'adv_sword_1handed', left: 'skeleton_shield_large_a' },
  'rogue.dual_daggers': { right: 'adv_dagger', left: 'adv_dagger' },
  'rogue.dual_swords': { right: 'adv_sword_1handed', left: 'adv_sword_1handed' },
  'rogue.dagger_buckler': { right: 'adv_dagger', left: 'shield_badge' },
  'hunter.short_bow': { left: 'fletcher_s_guild_bow' },
  'hunter.long_bow': { left: 'fletcher_s_guild_bow' },
  'hunter.heavy_crossbow': { left: 'crossbow_2handed' },
  'mage.staff': { right: 'adv_staff' },
  'mage.wand_orb': { right: 'adv_wand' },
  'mage.spellblade_focus': { right: 'adv_sword_1handed' },
  'priest.two_hand_staff': { right: 'adv_staff' },
  'priest.scepter_codex': { right: 'adv_wand', left: 'spellbook_open' },
  'priest.wand_relic': { right: 'adv_wand' },
  'druid.nature_staff': { right: 'adv_druid_staff' },
  'druid.polearm': { right: 'halberd' },
  'druid.mace_totem': { right: 'tempered_flanged_mace' },
};

export interface CharacterModel {
  /** 已归一化到 HITBOX_HEIGHT、可直接 add 的实例根 */
  root: THREE.Group;
  /** 全部动画片段（Idle / Walking_A / Running_A / …） */
  clips: readonly THREE.AnimationClip[];
  /** 手部挂点（模型没有对应节点时为 undefined） */
  handR: THREE.Object3D | undefined;
  handL: THREE.Object3D | undefined;
}

interface Template {
  gltf: GLTF;
  /** 源模型的包围盒，实例化时用来归一化 */
  height: number;
  minY: number;
}

export class ModelLibrary {
  private static _instance: ModelLibrary | undefined;
  /** 场景初始化时注入 renderer（KTX2 需要探测压缩纹理支持） */
  static init(renderer: THREE.WebGLRenderer): ModelLibrary {
    if (!this._instance) this._instance = new ModelLibrary(renderer);
    return this._instance;
  }
  static get instance(): ModelLibrary | undefined {
    return this._instance;
  }
  /** 测试用：重置单例 */
  static reset(): void {
    this._instance = undefined;
  }

  private readonly loader: GLTFLoader;
  private readonly templates = new Map<string, Promise<Template | null>>();

  private constructor(renderer: THREE.WebGLRenderer) {
    const ktx2 = new KTX2Loader().setTranscoderPath('/art/basis/').detectSupport(renderer);
    this.loader = new GLTFLoader()
      .setKTX2Loader(ktx2)
      .setMeshoptDecoder(MeshoptDecoder);
  }

  /** 职业模型。失败（素材缺失/解码失败）返回 null，只告警一次 */
  async characterFor(classId: string): Promise<CharacterModel | null> {
    const file = CLASS_MODEL[classId];
    if (!file) return null;
    const tpl = await this.template(`/art/models/chars/players/${file}.glb`);
    if (!tpl) return null;

    const root = cloneWithSkeleton(tpl.gltf.scene) as THREE.Group;
    // 13.2：视觉身高统一到碰撞体高度。缩放包在一层 wrapper 里，
    // 免得后续对 root 的操作覆盖归一化
    const s = GEOMETRY.HITBOX_HEIGHT / tpl.height;
    root.scale.setScalar(s);
    root.position.y = -tpl.minY * s;
    /**
     * ★★ 转 180°：上游 GLB 角色按 glTF 惯例**面向 +Z** 建模，而本项目
     *   yaw=0 的「前方」是 **-Z**（`yawToDir` = (-sin, 0, -cos)，
     *   胶囊体时代的朝向箭头也指 -Z）。不转的话每个模型都**倒着走** ——
     *   往前跑看到的是脸不是背影，步态读作太空步。
     *   M12 挂模型时漏了这一步：verify:m12 只量身高不看朝向，
     *   人眼在浏览器里走两步才发现。武器挂在手部骨骼上，随根一起转，无需另处理。
     */
    root.rotation.y = Math.PI;

    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.castShadow = true;
        m.frustumCulled = false; // 蒙皮网格的包围盒不跟骨骼走，镜头贴近时会被误剔除
        // ★ 材质逐实例克隆：受击闪白是实例状态（见文件头）
        m.material = Array.isArray(m.material)
          ? m.material.map((mm) => mm.clone())
          : m.material.clone();
      }
    });

    const wrapper = new THREE.Group();
    wrapper.add(root);
    return {
      root: wrapper,
      clips: tpl.gltf.animations,
      handR: root.getObjectByName('handslot.r'),
      handL: root.getObjectByName('handslot.l'),
    };
  }

  /**
   * 化形术（8.2「迷惑」）的小动物模型（`assets/art/models/creatures/`）。
   * 归一化到给定身高、贴地、面向 -Z（与角色同一前方约定）。
   * 素材缺失返回 null —— 那就不换模型，被变形只靠头顶标记表达（M11 的样子）。
   */
  async creatureFor(file: string, height = 0.9): Promise<THREE.Group | null> {
    const tpl = await this.template(`/art/models/creatures/${file}.glb`);
    if (!tpl) return null;
    const g = tpl.gltf.scene.clone(true);
    const s = height / tpl.height;
    g.scale.setScalar(s);
    g.position.y = -tpl.minY * s;
    g.rotation.y = Math.PI;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    return g;
  }

  /**
   * 场景装饰模型（`assets/art/models/<relPath>.glb`，MapDecorDef 用）。
   * ★ **不做归一化** —— 静态道具没有蒙皮，包围盒是诚实的，authored 尺度
   *   即真实尺度（与 creatureFor 的教训相反：那边是蒙皮模型才量不准）。
   * 失败返回 null，调用方少摆一件就是了。
   */
  async sceneModel(relPath: string): Promise<THREE.Group | null> {
    const tpl = await this.template(`/art/models/${relPath}.glb`);
    if (!tpl) return null;
    const g = tpl.gltf.scene.clone(true);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).castShadow = true;
        (o as THREE.Mesh).receiveShadow = true;
      }
    });
    return g;
  }

  /** 武器挂载模型；无映射或加载失败返回空对象（不挂就是了，不报错） */
  async weaponFor(weaponId: string): Promise<{ right?: THREE.Group; left?: THREE.Group }> {
    const att = WEAPON_MODEL[weaponId];
    if (!att) return {};
    const load = async (file: string | undefined): Promise<THREE.Group | undefined> => {
      if (!file) return undefined;
      const tpl = await this.template(`/art/models/weapons/${file}.glb`);
      if (!tpl) return undefined;
      const g = tpl.gltf.scene.clone(true);
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
      });
      return g;
    };
    const [right, left] = await Promise.all([load(att.right), load(att.left)]);
    return { ...(right ? { right } : {}), ...(left ? { left } : {}) };
  }

  private template(url: string): Promise<Template | null> {
    let p = this.templates.get(url);
    if (!p) {
      p = this.loader
        .loadAsync(url)
        .then((gltf) => {
          const box = new THREE.Box3().setFromObject(gltf.scene);
          return {
            gltf,
            height: Math.max(0.01, box.max.y - box.min.y),
            minY: box.min.y,
          };
        })
        .catch((err: unknown) => {
          // 素材可选：缺目录/网络失败都走程序化兜底，只提示一次
          console.warn(`[模型] ${url} 加载失败，保留程序化外观`, err);
          return null;
        });
      this.templates.set(url, p);
    }
    return p;
  }
}
