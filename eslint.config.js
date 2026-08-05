/**
 * G2（技术债总账）：第一份 lint 配置 —— 此前风格与低级错误零门禁。
 *
 * ★ 起点是「零告警基线」：规则集取 typescript-eslint 的 recommended
 *   （**非** type-checked 档 —— 55k 行代码的类型感知 lint 每次要重跑
 *   完整类型检查，而 `pnpm typecheck` 已经在做那件事，CI 里是两个 job），
 *   噪音规则的关闭都写着为什么 —— 关规则是决定，不是默认。
 */

import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'assets/**', '**/*.tsbuildinfo'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /**
     * verify 脚本是 `.mjs`（node 环境）且内嵌 `page.evaluate` 字符串
     * （浏览器环境）—— 两套 globals 都给：no-undef 只对 JS 生效
     * （TS 文件的未定义符号由 tsc 管，tseslint 已关掉它的 no-undef）。
     */
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      /** 中文注释里的全角空格是有意排版；字符串默认已跳过 */
      'no-irregular-whitespace': ['error', { skipComments: true, skipTemplates: true }],
      /**
       * 本仓库用 `as never` 收窄品牌类型（EntityId/SkillId 的既有惯例，
       * 全仓 ~200 处）；改成逐处 asEntityId() 是一次独立的大改，不随 lint 混入。
       */
      '@typescript-eslint/no-explicit-any': 'error',
      /** 空 catch 是本仓库的显式模式（「拿不到就算了」都带注释说明）*/
      'no-empty': ['error', { allowEmptyCatch: true }],
      /**
       * `_` 前缀 = 有意不用（回调签名对齐时常见）；
       * 解构剩余兄弟（`const { sourceId: _drop, ...rest }`）同理。
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],
    },
  },
);
