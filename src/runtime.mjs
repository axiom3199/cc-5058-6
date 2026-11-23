// 任务运行时：执行规划器产生的分解树。
// - 任务分解与动作执行分开；运行时按 dependsOn 与资源锁调度，不按树的书写顺序执行。
// - 叶子动作结束时再次核对动作前提，父复合节点的成功必须由世界谓词 goal(state) 确认。
// - 队员途中退出支持两种办法：局部换人（substitute）与回溯祖先方法重新分工（rollback）。
// - 局部换人若无法保持后段能力条件，自动升级为祖先回退。
// - 依赖失败会阻止所有不再适用的后续动作；共享资源串行化。

import { ACTIONS, renderLabel } from './actions.mjs';
import { METHODS } from './methods.mjs';
import { plan } from './planner.mjs';

const READY = 'ready', RUNNING = 'running', DONE = 'done',
  FAILED = 'failed', SKIPPED = 'skipped', BLOCKED = 'blocked';

export class Runtime {
  constructor(state, planResult, opts = {}) {
    this.state = state;
    this.roots = planResult.roots;
    this.recovery = opts.recovery ?? 'substitute'; // substitute | rollback
    this.events = [];
    this.finished = false;
    this.index = new Map();      // leaf.uid -> leaf runtime record
    this.compounds = new Map();  // compound.uid -> node
    this.locks = new Map();      // resourceId -> leaf uid
    this.busyMembers = new Map();// memberId -> leaf uid
    this._index(this.roots);
    this.emit('plan', '分解完成，开始按依赖与资源调度执行');
  }

  emit(type, message, data) {
    this.events.push({ tick: this.state.tick, type, message, data: data ?? null });
  }

  _index(nodes, parentUid = null) {
    // 第一趟：登记所有复合节点，保证跨层依赖可解析
    for (const node of nodes) {
      this.compounds.set(node.uid, node);
      node.parentUid = parentUid;
      this._index(node.subCompounds, node.uid);
    }
    // 第二趟：登记叶子并解析依赖
    for (const node of nodes) {
      for (const lf of node.leaves) this._registerLeaf(node, lf);
      this._indexLeaves(node.subCompounds);
    }
  }

  _indexLeaves(nodes) {
    for (const node of nodes) {
      for (const lf of node.leaves) this._registerLeaf(node, lf);
      this._indexLeaves(node.subCompounds);
    }
  }

  _registerLeaf(node, lf) {
    const ctx = { memberId: lf.assignee, ...lf.ctx };
    const rt = {
      ...lf, ctx, status: READY, progress: 0, total: ACTIONS[lf.action]?.duration ?? 1,
      rootUid: this._rootOf(node).uid, compoundUid: node.uid,
      dependsOn: this._resolveDeps(node, lf),
      resources: this._resourcesOf({ ...lf, ctx }),
    };
    rt.label = renderLabel(lf.action, ctx, this.state);
    this.index.set(lf.uid, rt);
  }

  _refreshLabel(leaf) {
    leaf.label = renderLabel(leaf.action, { memberId: leaf.assignee, ...leaf.ctx }, this.state);
  }

  _rootOf(node) {
    let cur = node;
    while (cur.parentUid) cur = this.compounds.get(cur.parentUid);
    return cur;
  }

  _resolveDeps(node, leaf) {
    const byLocal = new Map(node.leaves.map((l) => [l.localId, l.uid]));
    const out = [];
    for (const d of leaf.dependsOnLocal) {
      if (byLocal.has(d)) { out.push(byLocal.get(d)); continue; }
      // 依赖的是嵌套复合占位符：等待该子复合的全部叶子完成
      const ref = node.compoundRefs?.find((c) => c.name === d);
      if (ref) {
        const sub = this.compounds.get(ref.uid);
        for (const lf of sub.leaves) out.push(lf.uid);
      }
    }
    return [...new Set(out)];
  }

  _resourcesOf(leaf) {
    const def = ACTIONS[leaf.action];
    const r = def?.resources?.(leaf.ctx) ?? [];
    return [...new Set(r.filter(Boolean))];
  }

  // 外部事件：让某队员退出（仅在 travel/carry 途中才允许“途中退出”语义）
  withdraw(memberId) {
    const m = this.state.member(memberId);
    if (!m || m.status !== 'active') return;
    const leafUid = this.busyMembers.get(memberId);
    const leaf = leafUid ? this.index.get(leafUid) : null;
    const enRoute = leaf && ACTIONS[leaf.action]?.enRoute;
    this.state.withdraw(memberId);
    this.emit('withdraw', `${m.name} 退出考察队${enRoute ? '（途中退出）' : ''}`, { memberId, leafUid });
    if (leaf) this._handleWithdrawal(leaf, memberId, enRoute);
  }

  _handleWithdrawal(leaf, memberId, enRoute) {
    if (!enRoute) {
      this._failLeaf(leaf, `${this.state.member(memberId)?.name ?? '队员'}退出，动作 ${leaf.label} 中断`);
      return;
    }
    if (this.recovery === 'rollback') {
      this._ancestorRollback(leaf, `${this.state.member(memberId)?.name ?? '队员'}途中退出，按策略回溯上层重新分工`);
      return;
    }
    const replacement = this._findReplacement(leaf, memberId);
    if (replacement) {
      this._releaseLeafRuntime(leaf);
      leaf.status = READY; leaf.progress = 0; leaf.assignee = replacement;
      leaf.ctx = { ...leaf.ctx, memberId: replacement };
      // 重映射退出队员在整棵树内的所有未完成叶子（含其他复合节点中的后段能力动作）
      const remapped = [];
      for (const other of this.index.values()) {
        if (other.assignee !== memberId || other.rootUid !== leaf.rootUid) continue;
        if (![READY, RUNNING].includes(other.status)) continue;
        if (other.uid !== leaf.uid && !other.needs.every((c) => this.state.hasCap(replacement, c))) continue;
        if (this.busyMembers.get(other.assignee) === other.uid) this._releaseLeafRuntime(other);
        other.assignee = replacement;
        other.ctx = { ...other.ctx, memberId: replacement };
        other.status = READY; other.progress = 0;
        this._refreshLabel(other);
        remapped.push(other.uid);
      }
      // 替补可能不在物资/目标所在地：插入汇合动作并接好依赖
      const travelUid = this._insertApproachLeaf(leaf, replacement);
      if (travelUid && !leaf.dependsOn.includes(travelUid)) leaf.dependsOn.push(travelUid);
      this.emit('substitute',
        `局部换人：${this.state.member(replacement).name} 接替 ${this.state.member(memberId)?.name ?? memberId} 的 ${remapped.length} 项未完成动作（后段能力条件仍满足）`,
        { leafUid: leaf.uid, replacement, remapped });
    } else {
      this.emit('notice', '局部换人会破坏后段能力条件，升级为祖先方法回退');
      this._ancestorRollback(leaf, '无可用替补，回溯祖先方法重新分工');
    }
  }

  _insertApproachLeaf(leaf, memberId) {
    const targetLocId = leaf.action === 'carry'
      ? this.state.item(leaf.ctx.itemId)?.locId
      : leaf.ctx.locId;
    const m = this.state.member(memberId);
    if (!targetLocId || !m) return null;
    const uid = `L_approach_${leaf.uid}`;
    if (this.index.has(uid)) return uid;
    const ctx = { memberId, locId: targetLocId };
    const approach = {
      uid, localId: uid, action: 'travel', compound: null, needs: ['travel'],
      ctx, dependsOnLocal: [], assignee: memberId, actionLabel: ACTIONS.travel.label,
      status: READY, progress: 0, total: ACTIONS.travel.duration,
      rootUid: leaf.rootUid, compoundUid: leaf.compoundUid, dependsOn: [],
      resources: [], label: renderLabel('travel', ctx, this.state),
      synthetic: true,
    };
    this.index.set(uid, approach);
    const node = this.compounds.get(leaf.compoundUid);
    if (node && !node.leaves.some((l) => l.uid === uid)) node.leaves.push(approach);
    // 屏障：替补此前已排程/在途的其他移动必须先结束，避免他先走远而无法接手物资
    for (const other of this.index.values()) {
      if (other.uid !== uid && other.assignee === memberId
        && (other.status === READY || other.status === RUNNING)
        && other.action === 'travel' && !other.synthetic) {
        approach.dependsOn.push(other.uid);
      }
    }
    this.emit('notice',
      `安排 ${m.name} 在 ${this.state.loc(targetLocId).name} 汇合后接手`, { leafUid: uid });
    return uid;
  }

  _findReplacement(leaf, excludeId) {
    // 替补必须能接下退出者在同一任务内的全部未完成动作（保护后段能力条件）。
    // 只满足当前叶子但破坏后续能力条件的候选人不可取，返回空触发祖先方法回退。
    const pending = [...this.index.values()]
      .filter((l) => l.assignee === excludeId && l.rootUid === leaf.rootUid
        && [READY, RUNNING].includes(l.status));
    const requiredCaps = new Set(pending.flatMap((l) => l.needs));
    return this.state.activeMembers()
      .filter((m) => m.id !== excludeId
        && [...requiredCaps].every((c) => m.capabilities.has(c)))[0]?.id ?? null;
  }

  _releaseLeafRuntime(leaf) {
    this.busyMembers.delete(leaf.assignee);
    for (const r of leaf.resources) {
      if (this.locks.get(r) === leaf.uid) {
        this.locks.delete(r);
        const d = this.state.device(r);
        if (d) d.busy = false;
      }
    }
  }

  _ancestorRollback(leaf, reason) {
    // 找到包含该叶子的最顶层复合任务，重新分解；失败方案会因队员退出而不再适用。
    const rootUid = leaf.rootUid;
    const root = this.compounds.get(rootUid);
    this.emit('rollback', reason, { rootUid: root.uid, fromMethod: root.methodId });

    for (const lf of this.index.values()) {
      if (lf.rootUid !== rootUid) continue;
      this._releaseLeafRuntime(lf);
      if (lf.status === DONE) continue; // 已完成的世界变更保留
      lf.status = SKIPPED;
    }
    const requests = this.roots
      .filter((r) => r.uid === rootUid)
      .map((r) => ({ id: r.requestId, task: r.task, ctx: r.ctx }));
    const result = plan(this.state, requests);
    if (!result.ok) {
      this._failCompound(root, `祖先回退后仍无可行方案：${result.reason}`);
      return;
    }
    const newRoot = result.roots[0];
    this._replaceRoot(root, newRoot);
    this.emit('replan', `已重新分解为「${newRoot.methodLabel}」，按新分工继续`);
  }

  _replaceRoot(oldRoot, newRoot) {
    const idx = this.roots.indexOf(oldRoot);
    this.roots.splice(idx, 1, { ...newRoot, requestId: oldRoot.requestId });
    this.compounds.delete(oldRoot.uid);
    this._index([newRoot]);
  }

  _failCompound(node, reason) {
    for (const lf of this.index.values()) {
      if (lf.rootUid !== node.uid) continue;
      if (lf.status === READY) lf.status = SKIPPED;
      if (lf.status === RUNNING) { this._releaseLeafRuntime(lf); lf.status = FAILED; }
    }
    this.emit('failed', reason, { rootUid: node.uid });
  }

  _failLeaf(leaf, reason) {
    this._releaseLeafRuntime(leaf);
    leaf.status = FAILED;
    leaf.failure = reason;
    this.emit('leaf-failed', `${leaf.label} 失败：${reason}`, { leafUid: leaf.uid });
    this._cascadeBlock(leaf);
  }

  _cascadeBlock(failedLeaf) {
    // 传递闭包：依赖（直接或间接）失败叶子的后续动作全部阻止（工作队列，避免多路径递归）
    const blocked = new Set();
    const queue = [failedLeaf.uid];
    while (queue.length) {
      const depUid = queue.shift();
      for (const lf of this.index.values()) {
        if (lf.status !== READY || blocked.has(lf.uid)) continue;
        if (lf.dependsOn.includes(depUid)) {
          blocked.add(lf.uid);
          queue.push(lf.uid);
        }
      }
    }
    for (const uid of blocked) {
      const lf = this.index.get(uid);
      lf.status = BLOCKED;
      this.emit('blocked', `前置失败，阻止不再适用的后续动作：${lf.label}`, { leafUid: uid });
    }
  }

  tick() {
    if (this.finished) return this.summary();
    this.state.tick += 1;

    for (const leaf of this.index.values()) {
      if (leaf.status !== RUNNING) continue;
      this._advance(leaf);
    }
    for (const leaf of this.index.values()) {
      if (leaf.status !== READY) continue;
      this._tryStart(leaf);
    }
    this._evaluateCompounds();
    this.finished = this.roots.every((r) => this._compoundClosed(r));
    if (this.finished) this.emit('finished', '所有高层任务结束（完成状态由世界条件确认）');
    return this.summary();
  }

  _tryStart(leaf) {
    const m = this.state.member(leaf.assignee);
    if (!m || m.status !== 'active') return;
    if (this.busyMembers.has(leaf.assignee)) return;
    for (const dep of leaf.dependsOn) {
      const d = this.index.get(dep);
      if (!d || d.status !== DONE) return; // 依赖未完成（含 blocked/failed）则不可启动
    }
    for (const r of leaf.resources) {
      if (this.locks.has(r)) return; // 共享设备冲突：等待，串行化
    }
    const def = ACTIONS[leaf.action];
    if (def.settle && def.settle(this.state, leaf.ctx)) {
      leaf.status = DONE;
      this.emit('done', `${leaf.label} 已满足，无需执行`, { leafUid: leaf.uid });
      return;
    }
    if (!def.pre(this.state, leaf.ctx)) {
      this._failLeaf(leaf, '动作前提不满足（物件位置/状态与分解预期不符）');
      return;
    }
    leaf.status = RUNNING; leaf.progress = 0;
    this._refreshLabel(leaf);
    this.busyMembers.set(leaf.assignee, leaf.uid);
    for (const r of leaf.resources) {
      this.locks.set(r, leaf.uid);
      const d = this.state.device(r);
      if (d) d.busy = true;
    }
    def.enter?.(this.state, leaf.ctx);
    this.emit('start', `${m.name} 开始：${leaf.label}`, { leafUid: leaf.uid });
  }

  _advance(leaf) {
    const m = this.state.member(leaf.assignee);
    if (!m || m.status !== 'active') return; // withdraw() 已处理
    leaf.progress += 1;
    if (leaf.progress < leaf.total) return;
    const def = ACTIONS[leaf.action];
    // 结束时校验世界一致性（入口前提可能已被 enter 改变，如搬运已拿起物资）
    if (def.verifyEnd && !def.verifyEnd(this.state, leaf.ctx)) {
      this._failLeaf(leaf, '动作结束时世界状态不一致');
      return;
    }
    def.finish(this.state, leaf.ctx);
    this._releaseLeafRuntime(leaf);
    leaf.status = DONE;
    this.emit('done', `${leaf.label} 完成`, { leafUid: leaf.uid });
  }

  _evaluateCompounds() {
    for (const node of this._allCompounds()) {
      if (node.closed) continue;
      const leaves = this._leavesOf(node);
      const terminal = leaves.every((l) => [DONE, FAILED, SKIPPED, BLOCKED].includes(l.status));
      if (!terminal) continue;
      const allDone = leaves.every((l) => l.status === DONE);
      if (allDone && node.goal(this.state, node.ctx)) {
        node.closed = 'succeeded';
        this.emit('compound-done', `「${node.label}」世界条件确认通过，任务成功`, { rootUid: node.uid });
      } else {
        node.closed = 'failed';
        const why = !allDone ? '存在失败或被阻止的子动作' : '动作虽结束，但世界完成条件未满足';
        this.emit('compound-failed', `「${node.label}」未成功：${why}`, { rootUid: node.uid });
      }
    }
  }

  _allCompounds() {
    const out = [];
    const walk = (nodes) => { for (const n of nodes) { out.push(n); walk(n.subCompounds); } };
    walk(this.roots);
    return out;
  }
  _leavesOf(node) {
    return node.leaves.map((l) => this.index.get(l.uid));
  }
  _compoundClosed(node) {
    if (node.closed) return true;
    const leaves = this._leavesOf(node);
    return leaves.length > 0
      && leaves.every((l) => [DONE, FAILED, SKIPPED, BLOCKED].includes(l.status));
  }

  summary() {
    const leaves = [...this.index.values()];
    return {
      tick: this.state.tick,
      finished: this.finished,
      leafCounts: {
        ready: leaves.filter((l) => l.status === READY).length,
        running: leaves.filter((l) => l.status === RUNNING).length,
        done: leaves.filter((l) => l.status === DONE).length,
        failed: leaves.filter((l) => l.status === FAILED).length,
        blocked: leaves.filter((l) => l.status === BLOCKED).length,
        skipped: leaves.filter((l) => l.status === SKIPPED).length,
      },
      roots: this.roots.map((r) => ({
        uid: r.uid, requestId: r.requestId, label: r.label, methodId: r.methodId,
        closed: r.closed ?? null, goalMet: r.goal(this.state, r.ctx),
      })),
      events: this.events.slice(),
    };
  }

  treeView() {
    const view = (nodes) => nodes.map((n) => ({
      uid: n.uid, kind: n.kind, label: n.label, methodLabel: n.methodLabel,
      applicability: n.applicability, ctx: n.ctx, closed: n.closed ?? null,
      goalMet: n.goal(this.state, n.ctx),
      subCompounds: view(n.subCompounds),
      // 只展示本节点直接拥有的叶子，嵌套复合的叶子在其子树中展示
      leaves: n.leaves.filter((l) => this.index.get(l.uid)?.compoundUid === n.uid).map((l) => {
        const rt = this.index.get(l.uid);
        return {
          uid: l.uid, localId: l.localId, label: rt?.label ?? l.action,
          action: l.action, assignee: l.assignee, needs: l.needs,
          dependsOn: rt?.dependsOn ?? [], resources: rt?.resources ?? [],
          status: rt?.status ?? READY, progress: rt?.progress ?? 0, total: rt?.total ?? 1,
          failure: rt?.failure ?? null,
        };
      }),
    }));
    return view(this.roots);
  }
}
