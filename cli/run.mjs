#!/usr/bin/env node
// 命令行辅助入口：无头推进某个考察场景并打印分解依据、事件与最终世界条件。
// 图形入口见 web/index.html（文档 docs/ 中有说明）。
import { SCENARIO_IDS, SCENARIOS } from '../src/scenarios.mjs';
import { runScenario } from './runner.mjs';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const opt = (k, d = null) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};

if (!id || args.includes('--help')) {
  console.log('用法: node cli/run.mjs <场景ID> [--recovery=substitute|rollback] [--break-drone=<tick>]');
  console.log('场景:', SCENARIO_IDS.map((x) => `\n  ${x}  ${SCENARIOS[x].name}`).join(''));
  process.exit(id ? 0 : 1);
}

const result = runScenario(id, {
  recovery: opt('recovery', 'substitute'),
  breakDroneAtTick: opt('break-drone') ? Number(opt('break-drone')) : undefined,
});

if (!result.ok) {
  console.error(`规划失败: ${result.reason}`);
  for (const t of result.trace) {
    console.error(`- ${t.label} 适用性核对:`);
    for (const c of t.checks) console.error(`    ${c.applicable ? '✓' : '✗'} ${c.label}`);
  }
  process.exit(2);
}

console.log(`=== ${SCENARIOS[id].name} ===`);
console.log(SCENARIOS[id].desc);
console.log('\n[分解依据 / 方法适用性核对]');
for (const t of result.trace) {
  console.log(`高层任务: ${t.label}`);
  for (const c of t.checks) console.log(`  ${c.applicable ? '适用' : '排除'}  ${c.label}`);
}
console.log('\n[选用方法]', Object.entries(result.methodByRoot)
  .map(([r, m]) => `${r} -> ${m}`).join('; '));

console.log('\n[执行事件]');
for (const e of result.events) {
  console.log(`  t${String(e.tick).padStart(2, '0')}  ${e.type.padEnd(14)} ${e.message}`);
}

console.log('\n[叶子动作终态]');
const walk = (nodes) => (nodes ?? []).forEach((n) => {
  walk(n.subCompounds);
  for (const lf of n.leaves) {
    console.log(`  ${lf.status.padEnd(8)} ${lf.label}（负责:${lf.assignee ?? '-'} 依赖:${lf.dependsOn.length} 资源:${lf.resources.join(',') || '无'}）${lf.failure ? ' — ' + lf.failure : ''}`);
  }
});
walk(result.tree);

console.log('\n[世界条件确认]');
const s = result.state;
for (const st of s.stations) {
  console.log(`  ${s.locations.find((l) => l.id === st.siteId)?.name}: built=${st.built} mounted=${st.mounted} powered=${st.powered} calibrated=${st.calibrated}`);
}
console.log('  事实:', s.facts.length ? [...s.facts].join(' | ') : '(无)');
console.log('  队员:', s.members.map((m) => `${m.name}:${m.status === 'active' ? '在岗' : '已退出'}`).join('，'));
console.log('\n[任务结论]');
for (const r of result.summary.roots) {
  console.log(`  ${r.requestId} ${r.label}: ${r.closed === 'succeeded' ? '成功（世界条件确认）' : r.closed === 'failed' ? '失败' : r.closed}`);
}
