// HTN 分解搜索器（含分解搜索优化）。
// 分解与执行严格分开：规划器只产生带“任务来源”的节点树（方法、适用性核对记录、
// 依赖、所需能力、资源），并为每个叶子搜索满足能力条件的队员；找不到就回溯换方案。
// 规划器不假设动作一定成功——动作前提在执行时再次核对。
//
// 三种搜索模式（opts.mode）：
// - off    ：不缓存，逐方法完整展开（对照基线，也是穷举 oracle 的基础）。
// - proof  ：带证明的子计划复用。键=任务+上下文+在岗队员实际能力签名；
//            命中先重放证明中的前提观察，再物化预订；冲突则撤回分支换人或退回完整展开。
// - nogood ：只缓存失败前提及其 TTL，成功分解不缓存。
// 分解计数 memo.stats.expansions 与各命中/撤回计数随 plan 结果返回，供基准对照。

import { METHODS } from './methods.mjs';
import { ACTIONS } from './actions.mjs';
import { Memo, makeKey, trackApplicable, capabilitySignature } from './memo.mjs';
import { ReservationLedger } from './ledger.mjs';

let uid = 0;
const nid = (prefix) => `${prefix}_${++uid}`;

// 缓存模板克隆：goal 是函数（不可结构化克隆），保留引用；其余数据深拷贝。
function cloneTemplate(value) {
  if (typeof value === 'function') return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneTemplate);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneTemplate(v);
  return out;
}

function candidatesFor(state, leaf) {
  return state.activeMembers()
    .filter((m) => m.status === 'active' && leaf.needs.every((c) => m.capabilities.has(c)));
}

// 为叶子集合按能力与预订约束分派队员；候选人冲突则只撤回当前叶子的临时预订后换人。
function assignWithReservations(state, leaves, ledger, branchId, memo, traceEvents, sharedLoad) {
  const assignment = {};
  const load = sharedLoad ?? new Map(state.activeMembers().map((m) => [m.id, 0]));
  const order = leaves.slice().sort((a, b) => b.needs.length - a.needs.length);
  const myTokens = []; // 本分派过程中当前分支拿到的预订 token

  const reserveLeaf = (leaf, memberId) => {
    const tokens = [];
    for (const r of leaf.reserve ?? []) {
      const rr = r.vehicleId
        ? ledger.reserveSeat(r.vehicleId, memberId, branchId)
        : ledger.reserveLoan(r.deviceId, branchId, leaf.uid);
      if (!rr.ok) {
        for (const t of tokens) ledger.release(t);
        return rr;
      }
      if (rr.token) tokens.push(rr.token);
      if (rr.memberToken) tokens.push(rr.memberToken);
    }
    return { ok: true, tokens };
  };

  for (const leaf of order) {
    let candidates = candidatesFor(state, leaf);
    if (!candidates.length) {
      return { ok: false, reason: `叶子「${leaf.actionLabel}」所需能力 ${leaf.needs.join('+')} 无在岗队员满足` };
    }
    // 预订车辆席位的叶子：排除已在该车上占座、或已在其他车上占座的队员，避免必然失败的尝试
    const vehicleReserve = (leaf.reserve ?? []).find((r) => r.vehicleId);
    if (vehicleReserve) {
      const seatKey = ReservationLedger.seatKey(vehicleReserve.vehicleId);
      const seatedHere = new Set((ledger.holders.get(seatKey) ?? []).map((h) => h.ref.memberId));
      const seatedAnywhere = new Set();
      for (const [k, list] of ledger.holders) {
        if (k.startsWith('member:')) for (const h of list) seatedAnywhere.add(h.ref.memberId);
      }
      candidates = candidates.filter((m) => !seatedHere.has(m.id) && !seatedAnywhere.has(m.id));
    }
    candidates.sort((a, b) => (load.get(a.id) - load.get(b.id)) || a.id.localeCompare(b.id));

    let chosen = null;
    let chosenTokens = null;
    let lastReason = '';
    for (const cand of candidates) {
      const rr = reserveLeaf(leaf, cand.id);
      if (rr.ok) { chosen = cand; chosenTokens = rr.tokens; break; }
      lastReason = rr.reason;
      // 席位/器材已被占用：只撤回本次尝试的预订再换下一候选人（不动其他叶子已成功的预订）
      memo.stats.swaps += 1;
      traceEvents.push({ type: 'swap', leaf: leaf.localId, reason: rr.reason, tried: cand.id });
    }
    if (!chosen) {
      memo.stats.rollbacks += 1;
      return { ok: false, reason: `叶子「${leaf.actionLabel}」预订失败：${lastReason || '无可用队员'}` };
    }
    assignment[leaf.uid] = chosen.id;
    myTokens.push(...chosenTokens);
    load.set(chosen.id, load.get(chosen.id) + 1);
  }
  return { ok: true, assignment };
}

// 无预订约束时的均衡分派（保持与原实现相同的确定性选择）。
// load 由整棵分解树共享，保证嵌套子复合与外层直接叶子统一计负载，避免同一队员被重复压活。
function pickMembers(state, leaves, load) {
  const assignment = {};
  const shared = load ?? new Map(state.activeMembers().map((m) => [m.id, 0]));
  const order = leaves.slice().sort((a, b) => b.needs.length - a.needs.length);
  for (const leaf of order) {
    const candidates = candidatesFor(state, leaf);
    if (!candidates.length) {
      return { ok: false, reason: `叶子「${leaf.actionLabel}」所需能力 ${leaf.needs.join('+')} 无在岗队员满足` };
    }
    candidates.sort((a, b) => (shared.get(a.id) - shared.get(b.id)) || a.id.localeCompare(b.id));
    const chosen = candidates[0];
    assignment[leaf.uid] = chosen.id;
    shared.set(chosen.id, shared.get(chosen.id) + 1);
  }
  return { ok: true, assignment };
}

// 深物化一棵缓存中的节点模板：重新分配 uid，按旧分派/预订重建
function materializeNode(template, state, memo, ledger, branchId, traceEvents) {
  const node = {
    uid: nid('C'), kind: 'compound', task: template.task, label: template.label,
    ctx: structuredClone(template.ctx), methodId: template.methodId,
    methodLabel: template.methodLabel,
    applicability: structuredClone(template.applicability),
    goalSource: template.goalSource, goal: template.goal,
    fromCache: true,
  };
  const subCompounds = [];
  for (const sub of template.subCompounds) {
    const r = materializeNode(sub, state, memo, ledger, branchId, traceEvents);
    if (!r.ok) return r;
    subCompounds.push(r.node);
  }
  node.subCompounds = subCompounds;

  const leaves = [];
  for (const tlf of template.leaves) {
    const leaf = {
      uid: nid('L'), localId: tlf.localId, action: tlf.action, compound: null,
      needs: [...tlf.needs], ctx: structuredClone(tlf.ctx),
      dependsOnLocal: [...tlf.dependsOnLocal], actionLabel: tlf.actionLabel,
      reserve: structuredClone(tlf.reserve ?? []),
    };
    // 复用键记录的是实际消耗的能力：先试旧队员，不满足/不在岗则换人
    let assignee = tlf.assignee;
    const m0 = state.member(assignee);
    if (!m0 || m0.status !== 'active' || !leaf.needs.every((c) => m0.capabilities.has(c))) {
      const alt = candidatesFor(state, leaf)[0];
      if (!alt) return { ok: false, reason: `缓存物化：叶子「${leaf.actionLabel}」无满足能力的在岗队员` };
      memo.stats.swaps += 1;
      traceEvents.push({ type: 'swap', leaf: leaf.localId, reason: '旧分派队员能力/在岗状态变化', tried: assignee });
      assignee = alt.id;
    }
    for (const r of leaf.reserve) {
      const rr = r.vehicleId
        ? ledger.reserveSeat(r.vehicleId, assignee, branchId)
        : ledger.reserveLoan(r.deviceId, branchId, leaf.uid);
      if (!rr.ok) return rr; // 席位已被占用等冲突：调用方撤回整个缓存分支
    }
    leaf.assignee = assignee;
    leaves.push(leaf);
  }
  node.leaves = leaves;
  node.compoundRefs = template.compoundRefs.map((c) => ({ name: c.name, uid: subCompounds.find((s) => s.task === c.name)?.uid ?? c.uid }));
  return { ok: true, node, leaves };
}

function expandCompound(state, taskDef, taskCtx, prefix, trace, opts) {
  const { memo, ledger, reservationEvents } = opts;
  const registry = opts.localRegistry ?? opts.registry?.[taskDef.task] ?? METHODS[taskDef.task];
  const actions = opts.actions ?? ACTIONS;
  // 仅顶层复合在方法落地时提交 root 预订；嵌套子复合的预订留在外层分支里，
  // 外层方法失败时可随分支一起撤回（避免子复合提前 commit 导致资源被误锁）。
  const isTopLevel = !opts.localRegistry;
  if (!registry) return { ok: false, reason: `未知高层任务 ${taskDef.task}` };

  const key = makeKey(taskDef.task, taskCtx, state);
  // 整棵树共享的队员负载表：顶层复合新建，嵌套复合继承，保证均衡分派跨层一致
  const sharedLoad = opts.load ?? new Map(state.activeMembers().map((m) => [m.id, 0]));

  // 失败前提缓存：同版本且未超 TTL 直接短路
  const ng = memo.lookupNogood(key, state);
  if (ng) {
    trace.push({ task: taskDef.task, label: registry.label, ctx: taskCtx, checks: [], fromNogood: true });
    return { ok: false, reason: ng.reason, cached: true };
  }

  // 带证明缓存：命中且前提观察重放通过则物化复用
  const proof = memo.lookupProof(key, state);
  if (proof) {
    // 观察表只含“选中方法”读过的前提。世界变更后必须重新跑一遍方法适用性核对：
    // 缓存方法仍适用且仍是当前应选中的方法时才复用；否则此前被排除的替代方案
    // （如补送电源后的标准方案）可能已成为首选，必须放弃缓存回完整展开。
    const currentPick = registry.methods.find((m) => m.applicable(state, taskCtx));
    if (!currentPick || currentPick.id !== proof.template.methodId) {
      memo.rejectProof(key);
      reservationEvents.push({
        type: 'cache-reject', task: taskDef.task,
        reason: currentPick
          ? `首选方法变为 ${currentPick.id}（缓存为 ${proof.template.methodId}）`
          : `缓存方法 ${proof.template.methodId} 在当前世界已不适用`,
      });
    } else {
      const branchId = ledger.beginBranch(`cache:${taskDef.task}`);
      const mat = materializeNode(proof.template, state, memo, ledger, branchId, reservationEvents);
      if (mat.ok) {
        ledger.commitBranch(branchId);
        trace.push({
          task: taskDef.task, label: registry.label, ctx: taskCtx,
          checks: structuredClone(proof.template.applicability), fromCache: true,
        });
        return { ok: true, node: mat.node, leaves: mat.leaves, cached: true };
      }
      // 席位被占等物化冲突：撤回该分支的器材借用/席位，放弃缓存回完整展开
      ledger.releaseBranch(branchId, `缓存物化失败：${mat.reason}`);
      memo.stats.proofMiss += 1;
      reservationEvents.push({ type: 'cache-reject', task: taskDef.task, reason: mat.reason });
    }
  }

  memo.stats.expansions += 1;

  // 方法适用性核对；proof 模式同时记录证明所需的前提观察
  const checks = [];
  const observed = [];
  for (const m of registry.methods) {
    let applicable = false;
    let obs = [];
    if (memo.proofEnabled) {
      const t = trackApplicable(state, (s) => m.applicable(s, taskCtx));
      applicable = t.result; obs = t.observations;
    } else {
      applicable = m.applicable(state, taskCtx);
    }
    checks.push({ methodId: m.id, label: m.label, applicable });
    observed.push({ methodId: m.id, applicable, observations: obs });
  }
  trace.push({ task: taskDef.task, label: registry.label, ctx: taskCtx, checks });

  let chosen = null;
  let lastReason = '';
  for (const method of registry.methods) {
    if (!method.applicable(state, taskCtx)) continue;
    // 嵌套子复合继承外层分支号：整个方法的预订同生共死，失败一次撤回
    const branchId = opts.parentBranch ?? ledger.beginBranch(`${taskDef.task}.${method.id}`);
    const built = method.build(state, taskCtx);
    const subNodes = [];
    const allLeaves = [];
    const compoundRefs = new Map();
    let fatal = null;

    for (const [compName, localReg] of Object.entries(built.compounds ?? {})) {
      // 嵌套复合继承外层任务上下文（局部方法经 taskCtx 取 teamId/vanId/deviceId 等）
      const r = expandCompound(state, { task: compName }, { ...taskCtx },
        `${prefix}.${compName}`, trace,
        { ...opts, localRegistry: localReg, parentBranch: branchId, load: sharedLoad });
      if (!r.ok) { fatal = r.reason; break; }
      subNodes.push(r.node);
      allLeaves.push(...r.leaves);
      compoundRefs.set(compName, r.node);
    }
    if (fatal) { ledger.releaseBranch(branchId, `子复合失败：${fatal}`); lastReason = fatal; continue; }

    // 本方法的直接叶子（嵌套子复合的叶子已在其展开时分派并预订，不可重复分派）
    const directLeaves = [];
    for (const lf of built.leaves ?? []) {
      if (lf.compound) {
        const refNode = compoundRefs.get(lf.compound);
        if (refNode) compoundRefs.set(lf.id, refNode);
        continue;
      }
      directLeaves.push({
        uid: nid('L'), localId: lf.id, action: lf.action, compound: null,
        needs: lf.needs ?? [], ctx: lf.ctx ?? {}, dependsOnLocal: lf.dependsOn ?? [],
        actionLabel: actions[lf.action]?.label ?? lf.action,
        reserve: lf.reserve ?? [],
      });
    }
    allLeaves.push(...directLeaves);

    const picked = directLeaves.some((l) => l.reserve.length)
      ? assignWithReservations(state, directLeaves, ledger, branchId, memo, reservationEvents, sharedLoad)
      : pickMembers(state, directLeaves, sharedLoad);
    if (!picked.ok) {
      const withdrawn = ledger.releaseBranch(branchId, picked.reason);
      memo.stats.rollbacks += 1;
      reservationEvents.push({
        type: 'rollback', branchId, task: taskDef.task, method: method.id,
        reason: picked.reason, withdrawn,
      });
      lastReason = `${method.label}：${picked.reason}`;
      continue;
    }
    for (const lf of directLeaves) lf.assignee = picked.assignment[lf.uid];

    // 顶层方法成功落地：分支预订提升为 root，后续复合任务将其视为“已占用”容量。
    // 嵌套子复合不单独提交，随外层分支统一提交/撤回。
    if (isTopLevel) ledger.commitBranch(branchId);
    chosen = { method, built, subNodes, allLeaves, directLeaves, compoundRefs, branchId };
    break;
  }

  if (!chosen) {
    memo.storeNogood(key, lastReason || `${registry.label} 没有适用方案`, state);
    return { ok: false, reason: lastReason || `${registry.label} 没有适用方案` };
  }

  const node = {
    uid: nid('C'),
    kind: 'compound',
    task: taskDef.task,
    label: registry.label,
    ctx: taskCtx,
    methodId: chosen.method.id,
    methodLabel: chosen.method.label,
    applicability: checks,
    goalSource: chosen.built.goal.toString(),
    goal: chosen.built.goal,
    subCompounds: chosen.subNodes,
    compoundRefs: [...chosen.compoundRefs.entries()].map(([name, n]) => ({ name, uid: n.uid })),
    // 节点只拥有本方法的直接叶子；嵌套子复合的叶子归各自 subCompounds 节点
    leaves: chosen.directLeaves,
  };

  // 仅记录完整展开得到的证明（模板），观察表来自本次适用性核对
  if (memo.proofEnabled) {
    const methodObs = observed.find((o) => o.methodId === chosen.method.id);
    memo.storeProof(key, {
      revision: state.revision,
      capSig: capabilitySignature(state),
      observations: methodObs?.observations ?? [],
      template: cloneTemplate(node),
    });
  }
  return { ok: true, node, leaves: chosen.allLeaves };
}

// 穷举模式：枚举每个复合任务的全部适用方法与可行分派（受 200 计划上限保护），
// 作为基准 oracle 统计“合法分解总数”，用于核对缓存模式漏掉的合法分解数量。
function enumeratePlans(state, requests, limit = 200, opts = {}) {
  const results = [];
  const seen = new Set();
  const walk = (reqIdx, acc) => {
    if (results.length >= limit) return;
    if (reqIdx >= requests.length) {
      const sig = acc.map((n) => planSignature(n)).join('||');
      if (!seen.has(sig)) { seen.add(sig); results.push(acc); }
      return;
    }
    const req = requests[reqIdx];
    const registry = opts.registry?.[req.task] ?? METHODS[req.task];
    for (const method of registry.methods) {
      if (!method.applicable(state, req.ctx)) continue;
      const trace = [];
      const ledger = new ReservationLedger(state);
      const localMemo = new Memo('off');
      const r = expandCompound(state, req, req.ctx, req.id, trace,
        { memo: localMemo, ledger, reservationEvents: ledger.events, localRegistry: null,
          registry: opts.registry, actions: opts.actions });
      if (!r.ok) continue;
      walk(reqIdx + 1, [...acc, r.node]);
    }
  };
  walk(0, []);
  return results;
}

export function planSignature(node) {
  const leaves = [];
  const collect = (n) => {
    for (const s of n.subCompounds ?? []) collect(s);
    for (const l of n.leaves ?? []) leaves.push(`${l.localId}:${l.assignee ?? '?'}`);
  };
  collect(node);
  return `${node.task}|${node.methodId}|${leaves.sort().join(',')}`;
}

// 去成员化结构签名：只比较任务-方法-叶子骨架与预订结构，不受均衡分派的具体队员影响。
// 用于漏分解对照：缓存模式产出的计划骨架必须属于穷举 oracle 的合法骨架集合。
export function planSkeleton(node) {
  const leaves = [];
  const collect = (n) => {
    for (const s of n.subCompounds ?? []) collect(s);
    for (const l of n.leaves ?? []) {
      leaves.push(`${l.localId}[${(l.reserve ?? []).map((r) => r.vehicleId ?? r.deviceId).join('|')}]`);
    }
  };
  collect(node);
  return `${node.task}|${node.methodId}|${leaves.sort().join(',')}`;
}

export function plan(state, requests, opts = {}) {
  uid = 0;
  const mode = opts.mode ?? 'proof';
  const memo = opts.memo ?? new Memo(mode, { nogoodTtlTicks: opts.nogoodTtlTicks });
  const ledger = opts.ledger ?? new ReservationLedger(state);
  const trace = [];
  const roots = [];
  for (const req of requests) {
    const r = expandCompound(state, req, req.ctx, req.id, trace,
      { memo, ledger, reservationEvents: ledger.events, localRegistry: null, registry: opts.registry, actions: opts.actions });
    if (!r.ok) {
      return {
        ok: false, reason: r.reason, trace, roots, stats: memo.stats,
        ledger: ledger.occupancy(), reservationEvents: [...ledger.events], memo,
      };
    }
    roots.push({ requestId: req.id, ...r.node });
  }
  return {
    ok: true, roots, trace, mode,
    stats: memo.stats,
    reservationEvents: [...ledger.events],
    ledger: ledger.occupancy(),
    memo,
  };
}

export { Memo, enumeratePlans };
