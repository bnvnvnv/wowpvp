# 素材许可清单

> **本项目政策（现行）**：凡在 **GitHub 公开仓库**中已分发的美术、模型、贴图、图标、UI、音频，
> 允许 **拉取、入库（commit/push）、进入本项目发布包**。按包在 §4 登记来源即可。
>
> 验收 #51：外部素材有来源登记；**不禁止**再分发 GitHub 上已公开出现过的媒体。
> 硬边界仅剩：暴雪资产、明显非法盗用包（见 §2 ❌）。

## 0. 当前项目定位与 GitHub 媒体政策

本项目为**个人开发用途**。仓库可以是公开的。

### 0.1 ★ 统一政策：GitHub 已分发资产 = 可拉 / 可入库 / 可发布

> **凡在 GitHub 上以公开仓库形式已经分发的美术、模型、贴图、图标、UI、音频等媒体文件，
> 本项目视为允许直接使用：可下载、可 `git add` / `commit` / `push`、可打进本项目发布包。**
>
> 包括但不限于 [world-of-claudecraft](https://github.com/levy-street/world-of-claudecraft)
> 的 `public/` 媒体树，以及其他任意公开 GitHub 仓库中的美术包。
>
> 理由（项目自定）：上游已在 GitHub 公开分发，本仓库再次收录视为同源再分发，不再按
> 「仅 CC0 才可入库」收紧。

| 行为 | 是否允许 | 放哪 |
|---|---|---|
| 从 GitHub 公开仓 **拉取** 美术与音频 | ✅ | `assets/art/`、`assets/music/` 等 |
| 本地运行、调试、截图 | ✅ | — |
| **commit + push 到本仓库** | ✅ | 同上（§4 按包登记来源） |
| **进入本项目发布包** | ✅ | 同上 |
| 暴雪资产 / 明显非法盗用包 | ❌ | — |

### 0.2 分档（简化：GitHub 公开媒体默认 GH 档）

| 档位 | 含义 | 判据 | 文件放哪 |
|---|---|---|---|
| **GH** | GitHub 已公开分发 | 来源为公开 GitHub 仓中的媒体路径 | `assets/`（**可入库、可发布**） |
| **T3** | 经典可商用自由素材 | CC0 / OFL / 明确可商用再分发 | `assets/` |
| **T2** | 可入库但非商用（非 GitHub 源时） | CC-BY-NC 等 | `assets/`；商用发布前评估 |
| **T1** | 仅本地、**不得入库** | **非** GitHub 公开源，且许可禁止再分发原始文件（如 Mixamo FBX） | `assets/local/`（gitignore） |

★ **GitHub 公开媒体不再落 T1。** 它们走 **GH** 档：直接进 `assets/`，可 push、可进发布包。

★ `assets/local/` 只留给真正「只能本地用、绝不能 push」的非 GitHub 来源（Mixamo 等）。

## 1. 核心原则

| 原则 | 说明 |
|---|---|
| **GitHub 公开媒体全流程可用** | 拉取、入库、发布均允许（§0.1） |
| **按包登记来源** | §4 记清 GitHub URL / 路径前缀即可，不必每个文件一行 |
| **代码 MIT ≠ 媒体许可声明** | 本仓库代码仍是 MIT；媒体随 §4 来源与上游声明；不声称「所有媒体都是本项目原创」 |
| **不碰暴雪资产** | 不使用暴雪角色模型、纹理、技能图标、地图文件、Logo、音频（18.3） |

## 2. 按来源分类

### GH — GitHub 公开仓媒体（本项目默认主力）

- 任意 **公开** GitHub 仓库中已存在的模型 / 贴图 / 图标 / UI / 音频
- 参考项目 [world-of-claudecraft](https://github.com/levy-street/world-of-claudecraft) 整包 `public/` 媒体
- 上游 CREDITS 里写「permission required / with the project only」的文件：
  **本项目仍允许入库与发布**（因已在 GitHub 公开分发；§0.1）

放：`assets/art/`、`assets/music/` 等 → 可 commit / 可进发布包。

### T3 — 经典自由素材

- **CC0**：[Kenney](https://kenney.nl)、[Quaternius](https://quaternius.com)、KayKit 明确 CC0 部分
- **OFL / Apache-2.0 字体**：[Google Fonts](https://fonts.google.com)
- 明确允许商业使用与再分发的 **CC-BY**（建议署名进 `assets/ATTRIBUTION.md`）
- 自制原创素材

### T2 — 非 GitHub 源、可入库但商用需谨慎

- **CC-BY-NC** 等非商业许可（非 GitHub 源时）
- 登记表「商用」列写 `否`；若将来商用发布再替换或取得授权

### T1 — 仅本地，不得入库

- **Mixamo** 原始 FBX、DaFont personal-use、Itch/Sketchfab「personal use only」等
  **且不是**从公开 GitHub 仓拉下来的副本
- 放 `assets/local/`（gitignore），**禁止** `git add`

### ❌ 硬禁止

- **暴雪的一切资产**（即使出现在第三方 GitHub 仓也不收）
- **明显非法盗用包**（整包暴雪客户端资源、未获权的商业转存等）

### 逐来源速查

| 来源 | 档位 | 说明 |
|---|---|---|
| **任意公开 GitHub 仓库中的媒体** | **GH** | 可拉 / 可入库 / 可发布 → `assets/` |
| [world-of-claudecraft](https://github.com/levy-street/world-of-claudecraft) | **GH** | 整包公开媒体可用 |
| [Kenney](https://kenney.nl) / Quaternius / KayKit CC0 | **T3** | 自由素材 |
| [Google Fonts](https://fonts.google.com) | **T3** | OFL / Apache |
| [Mixamo](https://mixamo.com) 等非 GH 源 | **T1** | 仅 `assets/local/`，不 push |
| 暴雪资产 | **❌** | 硬禁止 |

### 关于参考项目（world-of-claudecraft）

| 用途 | 政策 |
|---|---|
| 参考代码、手感、骨骼、挂点、特效分层 | ✅ |
| 拉取 `public/` 美术与音频 | ✅ **GH** |
| commit / push 到本仓库 | ✅ **GH** |
| 打进本项目发布包 | ✅ **GH** |

## 3. 原创边界（18.3）

正式发布必须使用**原创**的：

- 游戏名称、阵营名称
- 职业包装（可以叫「战士」这类通用词，但职业标志、外观、口号必须原创）
- 技能名称（当前代码里用的是规格书给的中文名，**发布前需要一轮改名评估**）
- 地图、美术、音效、UI

可以参考的是：职业分工、目标制战斗、控制/打断/驱散博弈、自由镜头体验 —— 这些是**玩法机制**，不受版权保护。

> 📌 **待办（2026-08-09 更新进度）**：显示名那一半**已完成**（dcc2abe，85 个
> 借用名改为通用描述性译名 —— 本段原例「冲锋、致死打击」现已是「突进、重创斩」）。
> **仍未做的是承重层与包装**：`SkillId` 字符串仍是 WoW 派生（`warrior.mortal_wounds`
> 等 155 处，被光环 id/vfx key/武器 grants 全面引用，是一次跨数据层重命名），
> 以及 18.3 要求的游戏名/阵营/职业包装原创化（项目仍叫 wowpvp）。
> 见 [15-debt-registry.md](15-debt-registry.md) F1 —— **不要拖到最后**。

## 4. 素材登记表

> **GH / T3 / T2**：可按「包」登记一行（路径用目录前缀）。
> **T1**：必须落在 `assets/local/`，且不得被 commit。

| 文件路径 | **档位** | 名称 | 作者 | 来源 URL | 许可证 | 需署名 | 商用 | 可修改 | 可再分发 | 登记日期 |
|---|---|---|---|---|---|---|---|---|---|---|
| `assets/art/**` | **GH** | world-of-claudecraft 美术包 | 多作者（见上游 CREDITS） | https://github.com/levy-street/world-of-claudecraft | GitHub 已公开分发（混合上游许可） | 建议见 CREDITS | 本项目允许 | 视上游 | **是（本项目政策）** | 2026-07-31 |
| `assets/music/**` | **GH** | world-of-claudecraft 音频包 | 多作者（见上游 CREDITS） | https://github.com/levy-street/world-of-claudecraft | GitHub 已公开分发（混合上游许可） | 建议见 CREDITS | 本项目允许 | 视上游 | **是（本项目政策）** | 2026-07-31 |
| `assets/art/models/weapons/custom/royal_*_v1.glb` | **T3** | 王冠剑盾样板 | 本项目 | `scripts/blender/build_royal_armory.py` | MIT | 保留许可 | 是 | 是 | 是 | 2026-09-06 |
| `assets/source/**` | **T3** | 自制模型 Blender 源文件 | 本项目 | `scripts/blender/` | MIT | 保留许可 | 是 | 是 | 是 | 2026-09-06 |
| `assets/art/ui/screens/royal-armory-v1.png` | **T3** | 王冠剑盾渲染图 | 本项目 | `scripts/blender/build_royal_armory.py` | MIT | 保留许可 | 是 | 是 | 是 | 2026-09-06 |

具体自制路径优先于上面的 `assets/art/**` 上游目录总登记；新版战士截图混合使用
上游角色与本项目剑盾，角色来源仍按上游登记。详见 `assets/SOURCE.md`。

明细见 `assets/SOURCE.md`、`assets/CREDITS-world-of-claudecraft.md`。

**「档位」列取值**：`GH` / `T1` / `T2` / `T3`，含义见 §0.2。

★ 校验约定：
1. `T1` 路径必须在 `assets/local/` 下
2. `GH` / `T2` / `T3` 可在 `assets/` 下并入库、进发布包

## 5. 当前素材状态

### 5.1 运行时

**M12 起素材已接入渲染与音频管线**（M0–M11 是全程序化）：

| 层 | 用到的素材 | 缺失时 |
|---|---|---|
| 角色 | `art/models/chars/players/*.glb`（八职业 + 骨骼动画）| 回落程序化胶囊体 |
| 武器 | `art/models/weapons/*.glb`（挂 `handslot.*` 骨骼）| 不挂武器 |
| 技能图标 | `art/ui/skills/**`（91 个技能逐条映射）| 回落程序化 SVG |
| 环境 | `art/env/*_1k.hdr`（IBL + 天空）| 保留基础三盏灯与纯色背景 |
| 地面 | `art/textures/terrain/**`（PBR）| 保留纯色材质 |
| 字体 | `art/fonts/*.woff2`（拉丁子集）| `font-display: swap` 走系统字体 |
| 光标 | `art/ui/cursors/*.png` | CSS 兜底 `crosshair` |
| 音效/BGM | `music/sfx/**`、`music/music/**` | 静音，游戏行为不变 |

★ **每一层都能单独失败**：素材是可选的，纯代码 clone（没有 `assets/`）
跑起来就是 M11 的画面。这不是习惯问题 —— M1–M10 的 155 项验收
**不依赖素材存在**，正是靠这条保证。

★ `?art=off` 可以显式关掉全部外部素材，精确回落到 M11 的表现。
理由与 M1–M10 验收脚本为何用它，见
[PROGRESS.md](PROGRESS.md) 的 M12 章节与 `client/src/settings/artMode.ts`。

### 5.2 已登记 GitHub 素材（GH，可入库 / 可发布）

- `assets/art/` — 模型、贴图、UI、VFX、地图美术、环境等
- `assets/music/` — BGM、音效、语音

### ★ 政策演进摘要

| 阶段 | 策略 |
|---|---|
| M0–M8 | 全程序化 |
| M9 | 「零入库外部素材」 |
| 此前放宽 | GitHub 媒体可拉到 `assets/local/`，但不可 push |
| **现行（M12）** | **GitHub 已分发媒体可拉 / 可入库 / 可发布**（GH 档 → `assets/`），**且已接入运行时**（§5.1）|

### ★ 仍收紧的界线

- **T1**（非 GitHub 且禁止再分发）仍不得入库
- **暴雪资产**仍硬禁止

## 6. 素材引入流程

### 6.1 GitHub 公开仓 → 入库与发布（主路径）

```
1. 找到公开 GitHub 仓库中的媒体（sparse-clone / ZIP / raw）
2. 复制到 assets/art/… 或 assets/music/…（或其它 assets/ 子目录）
3. 在 §4 按「包」加一行：来源 URL + 档位 GH
4. 可选：上游 CREDITS / LICENSE 副本放进 assets/
5. git add + commit（允许 push）；发布包可直接包含
```

**不需要**再筛「上游是否写 permission required」——本项目 §0.1 已统一允许。

### 6.2 非 GitHub 自由素材（T3）

```
1. 确认 CC0 / OFL / 明确可商用再分发
2. §4 登记 T3 → 放入 assets/ → commit
```

### 6.3 仅本地 T1（非 GitHub）

```
1. 确认只能本地用（如 Mixamo FBX）
2. 放入 assets/local/（gitignore，不要 git add）
3. §4 登记 T1
```

## 7. 审计与 #51

### 7.1 验收 #51（现行含义）

> 外部素材有来源登记；允许收录 GitHub 上已公开分发的媒体；不含暴雪资产与未登记的非 GH 入库文件。

★ **M12 起这四条由 `pnpm verify:m12` §1 自动校验**，不再只是约定：

| 判据 | 状态 | 由谁保证 |
|---|---|---|
| `assets/` 下每个顶层包在 §4 有登记 | ✅ | `verify:m12` #51a（逐个对照登记表，未登记即红）|
| 来源清单 `assets/SOURCE.md` 存在且记录上游 URL | ✅ | `verify:m12` #51b |
| `assets/local/` 仅 T1 且不入库 | ✅ | `verify:m12` #51c（`git ls-files` 实测，不是约定）|
| 无暴雪资产 | ✅ | `verify:m12` #51d 路径扫描 + 本表人工复核 |
| 素材缺失时运行时仍可用（回落程序化）| ✅ | `verify:m12` #12e/#12f/#12g，见 §5.1 |

⚠️ #51d 的路径扫描**刻意不把 `blizzard` 当禁词** —— 它同时是法师技能
「暴风雪」的英文名，`ui/skills/mage/blizzard.webp` 是完全合规的图标。
扫描只匹配指向暴雪**产品**的词（`warcraft`、`.mpq` 等），宁可漏也不误报：
一条会误报的红线比没有红线更糟，下一个人学到的会是「这条可以忽略」。
真正的兜底是 §4 的逐包登记与人工复核。

### 7.2 发布前清单（简化）

- [x] GitHub 来源媒体已在 §4 登记为 **GH**（可进发布包）
- [ ] 发布说明 / 致谢可链到 `assets/SOURCE.md` 与上游 CREDITS（建议）
- [ ] 没有暴雪资产
- [ ] 没有误把 `assets/local/`（T1）打进发布包
- [ ] 技能名等原创化评估仍按 §3（与素材来源无关）

**组装命令**（外部审计批 2026-08-15 落地）：`pnpm build && pnpm package:client` ——
`scripts/package-client-dist.mjs` 把 `assets/art`、`assets/music` 与来源/致谢文件
拷进 `packages/client/dist`（白名单只拷这几样，结构上碰不到 `assets/local/`）。
组装后的 dist 自包含，`/art`、`/music` 与 dev 中间件同形，可直接静态部署；
默认 `pnpm build` 刻意**不**做这步（~420MB 复制不该是每次构建的税，
见 `packages/client/vite.config.ts` 文件头）。
