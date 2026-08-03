import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * ★★ 显式用 threads 池，不用 vitest 默认的 forks。
     *
     *   Windows 上实测：默认 forks 池会有若干 worker 以
     *   「Worker exited unexpectedly」崩掉，而崩掉的那些文件里的测试
     *   **根本不计入统计** —— 终端打印的是「Test Files 46 passed / Tests
     *   822 passed」外加几行 Unhandled Error，看起来像「全绿 + 几条噪音」，
     *   实际是 53 个文件里有 7 个一条都没跑。同一台机器 `--pool=threads`
     *   稳定跑出 53 文件 / 1064 测试。
     *
     *   ★ 这正是本仓库最在意的那类缺陷：**统计数字本身在说谎**。
     *     漏跑的文件不会红，只会消失 —— 比一条失败的断言难发现得多。
     *   ★ 换池是安全的：本仓库的测试全是纯逻辑（无原生模块、无进程级
     *     全局状态），隔离性需求由 vitest 的模块图本身满足。
     */
    pool: 'threads',
    /**
     * ★ 显式排除 dist。
     *
     *   `tsc -b` 会把 TS 编译到 packages/*\/dist；如果测试文件也被编进去，
     *   vitest 会把**编译副本**当成第二份测试再跑一遍。那不只是浪费时间：
     *   副本跑的是上一次 build 的代码，源码改了而没重新 build 时，
     *   同一条测试会一个绿一个红，非常难查。
     *
     *   各包的 tsconfig 已经用 `exclude: ["**\/*.test.ts"]` 不再编译测试，
     *   这里是第二道防线 —— 万一哪天有人去掉那个 exclude。
     */
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{git,cache,output,temp}/**'],
  },
});
