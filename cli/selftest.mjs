// 自检：核对五个案例的分解依据与世界完成条件。失败时以非零码退出。
import { runScenario } from './runner.mjs';
import { SCENARIOS } from '../src/scenarios.mjs';
import { plan } from '../src/planner.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
};

function assert(name, fn) {
  console.log(`\n[${name}]`);
  try { fn(); } catch (e) { failures += 1; console.error(`  FAIL  异常: ${e.stack}`); }
}

// S1 标准编队：标准方法适用并由世界条件确认成功
assert('S1 标准编队 · 部件齐全', () => {
  const r = runScenario('standard');
  check('选用标准方案', r.methodByRoot.t1 === 'deploy.standard');
  check('无失败/阻塞叶子',
    r.summary.leafCounts.failed === 0 && r.summary.leafCounts.blocked === 0);
  const st = r.state.stations[0];
  check('观测站四项世界条件全部满足',
    st.built && st.mounted && st.powered && st.calibrated);
  check('验收事实成立', r.state.facts.includes('verified:siteA'));
  check('父任务由世界条件确认成功', r.summary.roots[0].closed === 'succeeded');
});

// S2 精简编队缺部件：标准方案被适用性核对排除，轻量化方案接管
assert('S2 精简编队 · 缺少部件', () => {
  const r = runScenario('lightTeam');
  const deployTrace = r.trace.find((t) => t.task === 'deployObservation');
  const std = deployTrace.checks.find((c) => c.methodId === 'deploy.standard');
  check('标准方案被排除（能力/部件不满足）', std.applicable === false);
  check('改用轻量化方案', r.methodByRoot.t1 === 'deploy.light');
  check('轻量化任务成功', r.summary.roots[0].closed === 'succeeded');
  check('未产生标定动作（轻量方案不含电气/标定）',
    !r.tree[0].leaves.some((l) => l.action === 'calibrate'));
});

// S3 缺电源箱：初次只能轻量化；补送部件后重新分解为标准方案
assert('S3 缺电源箱 · 动态重新分解', () => {
  const r = runScenario('missingPower');
  check('初次采用轻量化方案', r.methodByRoot.t1 === 'deploy.light');
  check('轻量方案可成功（人工检查即可）', r.summary.roots[0].closed === 'succeeded');

  // 模拟补送电源箱与观测仪后，对同一世界重新分解
  const st2 = SCENARIOS.missingPower.build();
  let p = plan(st2, SCENARIOS.missingPower.tasks);
  check('补送前标准方案不适用',
    p.roots[0].applicability.find((c) => c.methodId === 'deploy.standard').applicable === false);
  st2.addItem({ id: 'battery', name: '电源箱', kind: 'power', locId: 'base' });
  p = plan(st2, SCENARIOS.missingPower.tasks);
  check('补送后标准方案变为适用并被选中', p.roots[0].methodId === 'deploy.standard');
});

// S4a 途中退出 · 局部换人
assert('S4a 途中退出 · 局部换人', () => {
  const r = runScenario('withdraw', { recovery: 'substitute' });
  check('出现换人事件', r.events.some((e) => e.type === 'substitute'));
  check('工程师已退出', r.state.members.find((m) => m.id === 'eng').status === 'withdrawn');
  check('最终仍由标准方案完成', r.methodByRoot.t1 === 'deploy.standard');
  check('任务成功', r.summary.roots[0].closed === 'succeeded');
});

// S4b 途中退出 · 强制回溯祖先方法重新分工
assert('S4b 途中退出 · 回溯上层', () => {
  const r = runScenario('withdraw', { recovery: 'rollback' });
  check('出现回退事件', r.events.some((e) => e.type === 'rollback'));
  check('出现重新分解事件', r.events.some((e) => e.type === 'replan'));
  check('工程师已退出', r.state.members.find((m) => m.id === 'eng').status === 'withdrawn');
});

// S4c 无替补能力：局部换人破坏后段能力条件，自动升级祖先回退
assert('S6 无替补能力 · 自动祖先回退', () => {
  const r = runScenario('noSubstitute', { recovery: 'substitute' });
  check('出现能力不足提示并升级回退', r.events.some((e) => e.type === 'notice' && e.message.includes('祖先方法回退')));
  check('最终发生祖先回退', r.events.some((e) => e.type === 'rollback'));
  check('改走轻量化方案', r.methodByRoot.t1 === 'deploy.light');
  check('工程师已退出', r.state.members.find((m) => m.id === 'eng').status === 'withdrawn');
});

// S5 两任务共享航测仪：资源串行；设备故障时先失败方阻止后续争用动作
assert('S5 共享设备 · 冲突串行与失败阻止', () => {
  const r = runScenario('sharedDevice');
  const scanLeaves = [];
  const walk = (ns) => (ns ?? []).forEach((n) => { walk(n.subCompounds); n.leaves.forEach((l) => { if (l.resources.includes('drone1')) scanLeaves.push(l); }); });
  walk(r.tree);
  check('两个任务都声明占用同一航测仪', scanLeaves.length === 2);
  check('无并发占用（串行化后全部完成）',
    scanLeaves.every((l) => l.status === 'done'));

  const r2 = runScenario('sharedDevice', { breakDroneAtTick: 3 });
  check('注入故障后存在失败叶子', r2.summary.leafCounts.failed >= 1);
  check('后续争用动作被阻止或失败（无新动作成功占用损坏设备）',
    !r2.events.some((e) => e.type === 'start' && e.tick > 3 && e.message.includes('航测')));
});

console.log(`\n${failures === 0 ? '全部自检通过' : `${failures} 项自检失败`}`);
process.exit(failures ? 1 : 0);
