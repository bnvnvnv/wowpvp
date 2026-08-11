/**
 * P4：画布的 CSS 像素尺寸，**读一次缓存起来**。
 *
 * ★★ 这不是「省几次属性读取」，是**每帧砍掉两次强制同步重排**。
 *
 *   `canvas.clientWidth` 是布局属性：读它的时候如果有样式改动还没结算，
 *   浏览器必须**当场**把整棵树的样式与布局算完才能回答。而我们的每帧
 *   HUD 路径恰好是「写 → 读 → 写 → 读 → 写」交替的：
 *     `FloatingNumbers.update` 读 → 屏幕闪烁写 opacity →
 *     `renderNameplates` 读 → 24 块姓名板写 transform → 帧末再结算一次
 *   于是一帧要算三遍布局，而画布尺寸整局都没变过。
 *
 *   P4 首轮剖析（swiftshader，`?stress` 24 实体同屏）里 `get clientWidth` 是
 *   **0.686ms/帧**，占「我们的 JS」self time 的三分之一 —— 而这三分之一
 *   一行有用的事都没干。真机上重排更快，但这笔钱同样是白花的。
 *
 * ★★ **失效判据是 `window` 的 `resize`，而且这条判据对本仓库是完备的** ——
 *   不是「差不多够用」。`index.html` 里 `html, body, #app` 全是 100%×100%，
 *   `#view` 又是 `#app` 的 100%×100%：画布尺寸恒等于视口尺寸，
 *   没有第二条能让它变化的路。全屏切换同样会发 `resize`。
 *   ⚠️ 哪天有人把画布改成「窗口里的一块」（分屏观战、编辑器内嵌预览），
 *     这条判据就不再完备 —— 那时该在这里补 `ResizeObserver`，
 *     而不是在调用点绕回去直接读 `clientWidth`。
 *   （刻意没有预先挂 `ResizeObserver`：它会为每个用过的 canvas 留下一个
 *     没人回收的观察者，而大厅是**每局新建一张画布**的。）
 *
 * ★ 刻意不改调用方的签名（那几处都是 `update(dt, camera, canvas)`）——
 *   缓存挂在模块级、按 canvas 元素索引，调用点只换一行。
 */

interface CachedSize {
  w: number;
  h: number;
  epoch: number;
}

/** 全局失效计数。窗口 resize 一次就 +1，所有缓存条目当场作废 */
let epoch = 0;
const cache = new WeakMap<HTMLElement, CachedSize>();

/**
 * ⚠️ 模块加载时就接线。测试环境（node，无 window）里安静跳过 ——
 *   那里 `epoch` 恒为 0，缓存照常生效，而测试里没人 resize。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { epoch++; });
}

/**
 * 画布当前的 CSS 像素尺寸。**每帧调用是安全的** —— 除了 resize 之后的
 * 第一次，其余都不碰布局。
 *
 * ⚠️ 返回的是**内部缓存对象**，调用方只读不改（改了下一帧就错）。
 */
export const canvasSize = (el: HTMLElement): { readonly w: number; readonly h: number } => {
  const hit = cache.get(el);
  if (hit && hit.epoch === epoch) return hit;
  const fresh: CachedSize = { w: el.clientWidth, h: el.clientHeight, epoch };
  cache.set(el, fresh);
  return fresh;
};

/**
 * 手动作废（单测 / 场景销毁）。★ 生产代码里**不该**有人调它 ——
 * 需要调用它才正确的话，说明失效判据漏了一种情况，那该去补判据。
 */
export const invalidateCanvasSizes = (): void => { epoch++; };
