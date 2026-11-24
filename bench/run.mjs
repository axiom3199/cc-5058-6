// 分解搜索优化基准运行器：
// - 对每个用例跑 off（不缓存完整展开）/ proof（带证明复用）/ nogood（仅失败前提）三种模式；
// - 以 off 的穷举合法分解集合为 oracle，统计 proof/nogood 产出计划是否都在 oracle 内（漏掉的合法分解）；
// - 记录展开数量、缓存命中、撤回/换人、耗时（成本分解）与计划可执行性；
// - 参照运行结果存 bench/baseline.json（只固定展开数/命中/漏分解等结构性指标，不固定机器相关耗时）。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { plan, Memo, enumeratePlans, planSignature, planSkeleton } from '../src/planner.mjs';
import { WorldState } from '../src/state.mjs';
import { BENCH_CASES, BENCH_CASE_IDS } from './cases.mjs';
import { BENCH_ACTIONS, BENCH_METHODS } from './domain.mjs';

const BASELINE_URL = new URL('./baseline.json', import.meta.url);

// 轻量执行证据：按依赖顺序把叶子原语在世界状态上跑一遍，确认计划可执行、goal 谓词成立。
// 依赖解析与 src/runtime.mjs 同构：在每棵根树内按 localId 解析（多团队同名叶子互不干扰）；
// 复合占位符等待该子复合的全部叶子。
function executePlan(state, roots, requests) {
  const allLeaves = [];
  const compounds = [];
  const depsByUid = new Map();

  for (const root of roots) {
    const treeLeaves = [];
    const walk = (n, parent = null) => {
      compounds.push({ node: n, parent });
      for (const s of n.subCompounds) walk(s, n);
      for (const l of n.leaves) treeLeaves.push(l);
    };
    walk(root);
    const uidOfLocal = new Map(treeLeaves.map((l) => [l.localId, l.uid]));
    const nodeOfCompound = new Map();
    const collectCompounds = (n) => {
      nodeOfCompound.set(n.uid, n);
      for (const s of n.subCompounds) collectCompounds(s);
    };
    collectCompounds(root);

    for (const leaf of treeLeaves) {
      allLeaves.push(leaf);
      const deps = [];
      const owner = compounds.filter((c) => c.node.leaves.includes(leaf)).map((c) => c.node);
      const node = owner[0] ?? root;
      for (const d of leaf.dependsOnLocal) {
        if (uidOfLocal.has(d)) { deps.push(uidOfLocal.get(d)); continue; }
        const ref = node.compoundRefs?.find((c) => c.name === d);
        if (ref) {
          const sub = nodeOfCompound.get(ref.uid);
          if (sub) for (const l of sub.leaves) deps.push(l.uid);
        }
      }
      depsByUid.set(leaf.uid, [...new Set(deps)]);
    }
  }

  const done = new Set();
  let guard = 0;
  while (done.size < allLeaves.length && guard++ < 500) {
    let progressed = false;
    for (const leaf of allLeaves) {
      if (done.has(leaf.uid)) continue;
      if (!depsByUid.get(leaf.uid).every((d) => done.has(d))) continue;
      const def = BENCH_ACTIONS[leaf.action];
      const ctx = { memberId: leaf.assignee, ...leaf.ctx };
      if (!def) return { ok: false, reason: `未知原语 ${leaf.action}` };
      if (def.pre && !def.pre(state, ctx)) return { ok: false, reason: `前提不满足：${def.label}` };
      def.finish(state, ctx);
      done.add(leaf.uid);
      progressed = true;
    }
    if (!progressed) return { ok: false, reason: '依赖无法满足（死锁）' };
  }
  const goalMet = requests.every((req) => {
    const reg = BENCH_METHODS[req.task];
    return reg.goal(state, req.ctx);
  });
  return { ok: goalMet, reason: goalMet ? '' : 'goal 世界谓词不成立', executedLeaves: done.size };
}

function runOnce(c, mode, { reuseMemo = false, ttl } = {}) {
  const state = c.build();
  const memo = new Memo(mode, { nogoodTtlTicks: ttl ?? c.opts.nogoodTtlTicks ?? 8 });
  const t0 = performance.now();
  const result = plan(state, c.requests, { ...c.opts, mode, memo });
  const elapsedMs = performance.now() - t0;
  let execution = null;
  if (result.ok) {
    const execState = c.build();
    execution = executePlan(execState, result.roots, c.requests);
  }
  return {
    mode, ok: result.ok,
    reason: result.reason ?? null,
    expansions: result.stats.expansions,
    stats: result.stats,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    signatures: result.ok ? result.roots.map(planSignature) : [],
    rootsSkeleton: result.ok ? result.roots.map(planSkeleton).join('||') : '',
    executable: execution?.ok ?? false,
    executionReason: execution?.reason ?? null,
    reusedMemo: reuseMemo,
    ledger: result.ledger,
    reservationEvents: result.reservationEvents,
  };
}

// 漏分解对照：proof/nogood 的计划骨架必须属于 off 穷举集合；同时返回 oracle 规模。
// 用去成员化骨架比较，避免均衡分派的具体队员差异造成伪报（基准不允许伪报）。
function missedLegal(c) {
  const state = c.build();
  const oraclePlans = enumeratePlans(state, c.requests, 200, { registry: c.opts.registry, actions: c.opts.actions });
  const oracleSigs = new Set(oraclePlans.map((nodes) => nodes.map(planSkeleton).join('||')));
  const out = {};
  for (const mode of ['off', 'proof', 'nogood']) {
    const r = runOnce(c, mode);
    const sig = r.rootsSkeleton;
    const inOracle = !r.ok || oracleSigs.has(sig);
    out[mode] = {
      inOracle,
      oracleSize: oracleSigs.size,
      producedSig: sig,
      missedLegal: inOracle ? 0 : oracleSigs.size, // 产出非法骨架时按全量漏报计
      executable: r.executable,
    };
  }
  return out;
}

// 同一 memo 实例上重复分解：第二次起命中带证明缓存
function memoAcrossCalls(c, mode) {
  const state = c.build();
  const memo = new Memo(mode, { nogoodTtlTicks: c.opts.nogoodTtlTicks ?? 8 });
  const first = plan(state, c.requests, { ...c.opts, mode, memo });
  const second = plan(state, c.requests, { ...c.opts, mode, memo });
  return {
    firstExpansions: first.stats.expansions,
    secondExpansions: second.stats.expansions,
    proofHits: second.stats.proofHits,
    nogoodHits: second.stats.nogoodHits,
    samePlan: JSON.stringify(first.ok ? first.roots.map(planSignature) : null)
      === JSON.stringify(second.ok ? second.roots.map(planSignature) : null),
  };
}

// 世界事实改动前后：变化后的分解不得复用旧证明（无非法命中）
function beforeAfterChange(c) {
  if (!c.mutate) return null;
  const state = c.build();
  const beforeRevision = state.revision;
  const memo = new Memo('proof');
  const before = plan(state, c.requests, { ...c.opts, mode: 'proof', memo });
  c.mutate(state);
  const afterRevision = state.revision;
  const hitsBefore = memo.stats.proofHits;
  const after = plan(state, c.requests, { ...c.opts, mode: 'proof', memo });
  return {
    beforeRevision, afterRevision,
    beforeOk: before.ok, afterOk: after.ok,
    // 变化后若仍有命中，必须是观察重放通过的合法命中；revision 变化数已记录供断言
    hitsAfterChange: memo.stats.proofHits - hitsBefore,
    rejected: memo.stats.proofRejected,
    afterStats: after.stats,
  };
}

// nogood TTL：失败前提在 TTL 内命中；推进时钟超过 TTL 后必须重新展开
function nogoodTtlBehavior(c) {
  const state = c.build();
  const ttl = c.opts.nogoodTtlTicks ?? 8;
  const memo = new Memo('nogood', { nogoodTtlTicks: ttl });
  const r1 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo });
  const r2 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo });
  state.tick = ttl + 1; // 超过 TTL，失败前提缓存必须过期
  const r3 = plan(state, c.requests, { ...c.opts, mode: 'nogood', memo });
  return {
    r1Ok: r1.ok, r2Ok: r2.ok, r3Ok: r3.ok,
    nogoodHitsWithinTtl: r2.stats.nogoodHits,
    expansionsAfterTtl: r3.stats.expansions,
  };
}

export function runBenchmark(ids = BENCH_CASE_IDS) {
  const report = { generatedAt: new Date().toISOString(), cases: {} };
  for (const id of ids) {
    const c = BENCH_CASES[id];
    const modes = {};
    for (const mode of ['off', 'proof', 'nogood']) modes[mode] = runOnce(c, mode);
    // 用例自带断言（席位留痕等），基于 off 模式的完整结果；worldChange 注入修订号上下文
    const expectCtx = {};
    if (c.mutate) {
      const probe = c.build();
      expectCtx.beforeRevision = probe.revision;
      c.mutate(probe);
      expectCtx.afterRevision = probe.revision;
    }
    const expectResult = c.expect(modes.off, expectCtx) ?? {};
    report.cases[id] = {
      name: c.name,
      modes,
      assertions: expectResult,
      missed: missedLegal(c),
      reuse: memoAcrossCalls(c, 'proof'),
      change: beforeAfterChange(c),
      nogoodTtl: id === 'nogoodTtl' ? nogoodTtlBehavior(c) : undefined,
    };
  }
  return report;
}

// 结构指标（不含耗时）用于基线对照，避免机器差异导致伪报
function structuralMetrics(report) {
  const out = {};
  for (const [id, c] of Object.entries(report.cases)) {
    out[id] = {
      expansions: Object.fromEntries(Object.entries(c.modes).map(([m, r]) => [m, r.expansions])),
      executable: Object.fromEntries(Object.entries(c.modes).map(([m, r]) => [m, r.executable])),
      missed: Object.fromEntries(Object.entries(c.missed).map(([m, r]) => [m, { inOracle: r.inOracle, oracleSize: r.oracleSize }])),
      reuse: c.reuse,
      change: c.change ? { beforeRevision: c.change.beforeRevision, afterRevision: c.change.afterRevision, rejected: c.change.rejected } : null,
      nogoodTtl: c.nogoodTtl ? { hitsWithinTtl: c.nogoodTtl.nogoodHitsWithinTtl, expansionsAfterTtl: c.nogoodTtl.expansionsAfterTtl } : null,
    };
  }
  return out;
}

export async function saveBaseline(report) {
  await writeFile(BASELINE_URL, JSON.stringify({ structural: structuralMetrics(report) }, null, 2));
}

export async function checkBaseline() {
  const raw = JSON.parse(await readFile(BASELINE_URL, 'utf8'));
  const report = runBenchmark();
  const now = structuralMetrics(report);
  const diffs = [];
  for (const id of Object.keys(raw.structural)) {
    if (JSON.stringify(raw.structural[id]) !== JSON.stringify(now[id])) {
      diffs.push({ id, baseline: raw.structural[id], current: now[id] });
    }
  }
  return { ok: diffs.length === 0, diffs, report };
}

export function printReport(report) {
  console.log('分解搜索优化基准（三模式对照）\n');
  for (const [id, c] of Object.entries(report.cases)) {
    console.log(`■ ${id}  ${c.name}`);
    for (const [mode, r] of Object.entries(c.modes)) {
      console.log(`  ${mode.padEnd(6)} ok=${r.ok} 展开=${String(r.expansions).padStart(3)} `
        + `命中(proof/nogood)=${r.stats.proofHits}/${r.stats.nogoodHits} `
        + `撤回=${r.stats.rollbacks} 换人=${r.stats.swaps} 可执行=${r.executable} 耗时=${r.elapsedMs}ms`);
    }
    const miss = c.missed;
    const anyMissed = Object.values(miss).some((m) => !m.inOracle);
    console.log(`  漏分解对照 oracleSize=${miss.off.oracleSize}：${anyMissed ? '存在非法/漏报 ✗' : '全部产出在合法集合内 ✓'}`);
    console.log(`  跨调用复用：首次展开=${c.reuse.firstExpansions} 二次展开=${c.reuse.secondExpansions} `
      + `proofHits=${c.reuse.proofHits} 同计划=${c.reuse.samePlan}`);
    if (c.change) {
      console.log(`  世界变更：revision ${c.change.beforeRevision}→${c.change.afterRevision} `
        + `证明重核拒绝=${c.change.rejected} 变化后命中=${c.change.hitsAfterChange}`);
    }
    if (c.nogoodTtl) {
      console.log(`  失败前提TTL：TTL内nogood命中=${c.nogoodTtl.nogoodHitsWithinTtl} `
        + `超时后重新展开=${c.nogoodTtl.expansionsAfterTtl}`);
    }
    // 谁上车、谁保有借出仪器（台账终态）
    const seat = c.modes.off.ledger?.filter((o) => o.key.startsWith('seat:')) ?? [];
    for (const o of seat) {
      console.log(`  载具席位终态 ${o.key}：${o.used}/${o.total}，上车=[${o.holders.map((h) => h.memberId).join(',')}]`);
    }
    const loans = c.modes.off.ledger?.filter((o) => o.key.startsWith('loan:')) ?? [];
    for (const o of loans) {
      console.log(`  器材借用终态 ${o.key}：持有=[${o.holders.map((h) => h.deviceId).join(',')}]`);
    }
    const asserts = Object.entries(c.assertions ?? {});
    if (asserts.length) {
      for (const [name, ok] of asserts) console.log(`  断言「${name}」：${ok ? '✓' : '✗'}`);
    }
    console.log('');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--check') {
    const r = await checkBaseline();
    if (!r.ok) {
      console.error('基线对照失败（展开数/可执行计划等结构指标退化）：');
      for (const d of r.diffs) console.error(JSON.stringify(d, null, 2));
      process.exit(1);
    }
    console.log('基线对照通过：展开数量、漏分解与可执行计划与参照一致。');
    printReport(r.report);
  } else if (arg === '--save') {
    const report = runBenchmark();
    await saveBaseline(report);
    printReport(report);
    console.log('参照基线已写入 bench/baseline.json（结构指标，不含耗时）。');
  } else {
    printReport(runBenchmark());
  }
}
