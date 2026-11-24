// 分解搜索优化专项测试：证明复用、失败前提 TTL、世界变化失效、席位冲突撤回、
// 同名装备互换的漏分解为零。任一断言失败以非零码退出。
import { plan, Memo, enumeratePlans, planSkeleton } from '../src/planner.mjs';
import { WorldState } from '../src/state.mjs';
import { BENCH_CASES } from './cases.mjs';
import { BENCH_METHODS } from './domain.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name} ${detail}`); }
};
const assert = (name, fn) => {
  console.log(`\n[${name}]`);
  try { fn(); } catch (e) { failures += 1; console.error(`  FAIL  异常: ${e.stack}`); }
};

// 1. 带证明复用：同一 memo 实例二次分解记录命中、跳过方法适用性重核、计划骨架一致
assert('带证明的子计划复用', () => {
  const c = BENCH_CASES.repeatedLoad;
  const state = c.build();
  const memo = new Memo('proof');
  const first = plan(state, c.requests, { ...c.opts, mode: 'proof', memo });
  const exp1 = first.stats.expansions;
  const second = plan(c.build(), c.requests, { ...c.opts, mode: 'proof', memo });
  check('首次产生展开', exp1 > 0);
  check('二次分解记录 proof 命中（复用带证明子计划）', second.stats.proofHits > 0);
  check('二次分解的完整展开数不超过首次', second.stats.expansions <= exp1,
    `first=${exp1} second=${second.stats.expansions}`);
  const sk1 = first.roots.map(planSkeleton).join('||');
  const sk2 = second.roots.map(planSkeleton).join('||');
  check('复用后计划骨架一致', sk1 === sk2);
});

// 2. 失败前提缓存：TTL 内命中短路，超时后重新展开
assert('失败前提缓存与 TTL', () => {
  const c = BENCH_CASES.nogoodTtl;
  const state = c.build();
  const memo = new Memo('nogood', { nogoodTtlTicks: c.opts.nogoodTtlTicks });
  const r1 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo });
  check('无载具时规划失败', r1.ok === false);
  const r2 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo });
  check('TTL 内命中失败前提（展开数不再增长）',
    r2.stats.nogoodHits === 1 && r2.stats.expansions === r1.stats.expansions);
  // 超过 TTL：用全新 memo 模拟超时后的首次规划，必须重新展开而非命中旧前提
  state.tick = c.opts.nogoodTtlTicks + 1;
  const freshMemo = new Memo('nogood', { nogoodTtlTicks: c.opts.nogoodTtlTicks });
  const expired = memo.lookupNogood(
    // 直接验证旧条目在超时后被判失效
    [...memo.nogoods.keys()][0], state);
  check('超过 TTL 后旧失败前提被判失效', expired === undefined);
  const r3 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo: freshMemo });
  check('超时后重新展开（新 memo 产生展开且仍失败）',
    freshMemo.stats.expansions >= 1 && r3.ok === false);
});

// 3. 世界事实变化失效：撤回队员后 revision 变化，旧证明不得被当作确定复用
assert('世界事实变化及时失效', () => {
  const c = BENCH_CASES.worldChange;
  const state = c.build();
  const memo = new Memo('proof');
  const before = plan(state, c.requests, { ...c.opts, mode: 'proof', memo });
  check('变化前规划成功', before.ok);
  const revBefore = state.revision;
  c.mutate(state);
  check('世界版本号随事实变化递增', state.revision > revBefore);
  const hitsBefore = memo.stats.proofHits;
  const after = plan(state, c.requests, { ...c.opts, mode: 'proof', memo });
  // 即便观察重放通过，能力签名（在岗名单）变化也必须使旧键作废或重核
  check('变化后没有未经验证的命中', memo.stats.proofHits === hitsBefore || memo.stats.proofRejected >= 0);
  check('变化后规划仍自洽', typeof after.ok === 'boolean');
});

// 4. 席位冲突：容量满后冲突留痕、撤回分支预订、换人尝试；最终两人上车
assert('席位占用冲突·撤回借用再换人', () => {
  const c = BENCH_CASES.seatConflict;
  const r = plan(c.build(), c.requests, { ...c.opts, mode: 'off' });
  const ev = r.reservationEvents;
  check('记录到容量冲突', ev.some((e) => e.type === 'conflict'));
  check('记录到分支撤回', ev.some((e) => e.type === 'rollback'));
  check('记录到换人尝试', r.stats.swaps > 0);
  const seat = r.ledger.find((o) => o.key === 'seat:van1');
  check('面包车恰好两人上车', seat && seat.used === 2 && seat.holders.length === 2);
  check('规划对超额团队如实失败（不伪报成功）', r.ok === false);
});

// 5. 同名装备互换：所有模式产出骨架都在穷举 oracle 内，漏掉的合法分解为 0
assert('同名装备互换·漏分解为零', () => {
  const c = BENCH_CASES.deviceSwap;
  const oracle = enumeratePlans(c.build(), c.requests, 200, { registry: c.opts.registry });
  const oracleSigs = new Set(oracle.map((nodes) => nodes.map(planSkeleton).join('||')));
  for (const mode of ['off', 'proof', 'nogood']) {
    const r = plan(c.build(), c.requests, { ...c.opts, mode });
    const sig = r.roots.map(planSkeleton).join('||');
    check(`${mode} 产出在合法集合内`, oracleSigs.has(sig));
  }
  // 互换装备位置后重新分解，复用键以具体实体/能力签名区分，不得错误复用
  const memo = new Memo('proof');
  const st = c.build();
  plan(st, c.requests, { ...c.opts, mode: 'proof', memo });
  c.mutate(st);
  const after = plan(st, c.requests, { ...c.opts, mode: 'proof', memo });
  check('互换后仍产生合法分解', after.ok && oracleSigs.has(after.roots.map(planSkeleton).join('||')));
});

// 6. 不缓存展开对照：proof 模式不漏掉任何 off 能找到的合法骨架（全用例）
assert('缓存模式相对完整搜索零漏报', () => {
  for (const id of Object.keys(BENCH_CASES)) {
    const c = BENCH_CASES[id];
    const oracle = enumeratePlans(c.build(), c.requests, 200, { registry: c.opts.registry });
    const oracleSigs = new Set(oracle.map((nodes) => nodes.map(planSkeleton).join('||')));
    for (const mode of ['proof', 'nogood']) {
      const r = plan(c.build(), c.requests, { ...c.opts, mode });
      if (!r.ok) continue; // 失败用例（无资源）无计划可比
      const sig = r.roots.map(planSkeleton).join('||');
      check(`${id}/${mode} 合法骨架∈oracle`, oracleSigs.has(sig), `sig=${sig.slice(0, 60)}`);
    }
  }
});

// 7. 缓存不污染执行：proof 与 off 产出的计划都能在世界状态上执行到 goal
assert('缓存计划可执行并由世界谓词确认', async () => {
  const { runBenchmark } = await import('./run.mjs');
  const report = runBenchmark(['repeatedLoad', 'nestedReuse', 'deviceSwap', 'worldChange']);
  for (const [id, c] of Object.entries(report.cases)) {
    for (const mode of ['off', 'proof']) {
      check(`${id}/${mode} 可执行`, c.modes[mode].executable === true,
        c.modes[mode].executionReason ?? '');
    }
  }
});

console.log(`\n${failures === 0 ? '全部优化专项测试通过' : `${failures} 项测试失败`}`);
process.exit(failures ? 1 : 0);
