// HTN 分解搜索器。
// 分解与执行严格分开：规划器只产生带“任务来源”的节点树（方法、适用性核对记录、
// 依赖、所需能力、资源），并为每个叶子搜索满足能力条件的队员；找不到就回溯换方案。
// 规划器不假设动作一定成功——动作前提在执行时再次核对。

import { METHODS } from './methods.mjs';
import { ACTIONS } from './actions.mjs';

let uid = 0;
const nid = (prefix) => `${prefix}_${++uid}`;

function pickMembers(state, leaves) {
  // 为每个叶子选择满足能力条件的队员；同一队员可串行承担多个叶子，
  // 优先分配当前负担最小者以均衡分工，真正的时间冲突由运行时 busyMembers 调度。
  const assignment = {};
  const load = new Map(state.activeMembers().map((m) => [m.id, 0]));
  const order = leaves.slice().sort((a, b) => b.needs.length - a.needs.length);
  for (const leaf of order) {
    const candidates = state.activeMembers()
      .filter((m) => m.status === 'active' && leaf.needs.every((c) => m.capabilities.has(c)));
    if (!candidates.length) {
      return { ok: false, reason: `叶子「${leaf.actionLabel}」所需能力 ${leaf.needs.join('+')} 无在岗队员满足` };
    }
    candidates.sort((a, b) => (load.get(a.id) - load.get(b.id)) || a.id.localeCompare(b.id));
    const chosen = candidates[0];
    assignment[leaf.uid] = chosen.id;
    load.set(chosen.id, load.get(chosen.id) + 1);
  }
  return { ok: true, assignment };
}

function expandCompound(state, taskDef, taskCtx, prefix, trace, usedByTask, localRegistry = null) {
  const registry = localRegistry ?? METHODS[taskDef.task];
  if (!registry) return { ok: false, reason: `未知高层任务 ${taskDef.task}` };

  const checks = registry.methods.map((m) => ({
    methodId: m.id, label: m.label, applicable: m.applicable(state, taskCtx),
  }));
  trace.push({ task: taskDef.task, label: registry.label, ctx: taskCtx, checks });

  let chosen = null;
  let lastReason = '';
  for (const method of registry.methods) {
    if (!method.applicable(state, taskCtx)) continue;
    const built = method.build(state, taskCtx);
    const subNodes = [];
    const allLeaves = [];
    const compoundRefs = new Map(); // 占位符名 -> 子复合节点
    let fatal = null;

    // 先展开嵌套复合节点（方法内部注册的局部复合，如“建立供电”）
    for (const [compName, localReg] of Object.entries(built.compounds ?? {})) {
      const r = expandCompound(state, { task: compName }, taskCtx,
        `${prefix}.${compName}`, trace, usedByTask, localReg);
      if (!r.ok) { fatal = r.reason; break; }
      subNodes.push({ name: compName, ...r.node });
      allLeaves.push(...r.leaves);
      compoundRefs.set(compName, r.node);
    }
    if (fatal) { lastReason = fatal; continue; }

    // 方法直接给出的叶子；带 compound 字段的是嵌套复合占位符，不是动作
    for (const lf of built.leaves ?? []) {
      if (lf.compound) {
        const refNode = compoundRefs.get(lf.compound);
        if (refNode) compoundRefs.set(lf.id, refNode);
        continue;
      }
      allLeaves.push({
        uid: nid('L'), localId: lf.id, action: lf.action, compound: null,
        needs: lf.needs ?? [], ctx: lf.ctx ?? {}, dependsOnLocal: lf.dependsOn ?? [],
        actionLabel: ACTIONS[lf.action]?.label ?? lf.action,
      });
    }

    const picked = pickMembers(state, allLeaves);
    if (!picked.ok) { lastReason = `${method.label}：${picked.reason}`; continue; }
    for (const lf of allLeaves) lf.assignee = picked.assignment[lf.uid];

    chosen = { method, built, subNodes, allLeaves, compoundRefs };
    break;
  }

  if (!chosen) {
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
    leaves: chosen.allLeaves,
  };
  return { ok: true, node, leaves: chosen.allLeaves };
}

export function plan(state, requests) {
  uid = 0;
  const trace = [];
  const roots = [];
  const usedByTask = new Map();
  for (const req of requests) {
    const used = new Set();
    usedByTask.set(req.id, used);
    const r = expandCompound(state, req, req.ctx, req.id, trace, used);
    if (!r.ok) {
      return { ok: false, reason: r.reason, trace, roots };
    }
    roots.push({ requestId: req.id, ...r.node });
  }
  return { ok: true, roots, trace };
}
