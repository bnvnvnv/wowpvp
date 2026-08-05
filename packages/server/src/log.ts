/**
 * 结构化日志（技术债总账 S6）。
 *
 * ★★ **在此之前全服日志一共 6 行 console** —— 过载、半开连接、被打、
 *   追帧丢弃全部静默。公网上「出了什么事」只能靠玩家来报，
 *   而玩家报的是「卡了」，不是「flooder 把 tick 拖到 180ms」。
 *
 * 形态：**一行一个 JSON**（`{ts, level, event, ...fields}`）。
 *   不引第三方日志库 —— 本仓库的依赖纪律（服务器运行时依赖只有 ws），
 *   而 JSON 行是所有采集器（journald/CloudWatch/loki）都吃的最大公约数。
 *
 * ★ `onLog` 是**测试与压测脚本的监听钩子**：判据里「半开/超载均有日志可见」
 *   要能被断言，靠抓 stdout 太脆（vitest 并行、颜色码）——
 *   钩子让脚本直接订阅事件流。生产路径不受影响（钩子默认为空）。
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

type LogListener = (level: LogLevel, event: string, fields: LogFields) => void;

let listener: LogListener | undefined;

/** 订阅日志事件（传 undefined 取消）。同一时刻只有一个订阅者 —— 测试专用 */
export const onLog = (fn?: LogListener): void => {
  listener = fn;
};

export const log = (level: LogLevel, event: string, fields: LogFields = {}): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  // error 走 stderr —— 部署环境的告警规则通常只盯 stderr
  if (level === 'error') console.error(line);
  else console.log(line);
  listener?.(level, event, fields);
};
