import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
