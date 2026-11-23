// 无头运行器：CLI 与自检共用。命令行仅作辅助，图形界面才是考察任务主入口。
import { SCENARIOS } from '../src/scenarios.mjs';
import { plan } from '../src/planner.mjs';
import { Runtime } from '../src/runtime.mjs';

export function runScenario(id, opts = {}) {
  const sc = SCENARIOS[id];
  if (!sc) throw new Error(`未知场景 ${id}`);
  const state = sc.build();
  const requests = sc.tasks.map((t) => ({ ...t }));
  const planned = plan(state, requests);
  if (!planned.ok) return { ok: false, stage: 'plan', reason: planned.reason, trace: planned.trace, state };

  const rt = new Runtime(state, planned, { recovery: opts.recovery ?? 'substitute' });
  const events = [];
  const pull = () => { for (const e of rt.events.splice(0)) events.push(e); };

  const trigger = opts.trigger ?? (sc.withdrawAt
    ? ((t) => {
      if (t === sc.withdrawAt.afterTick && state.member(sc.withdrawAt.memberId)?.status === 'active') {
        rt.withdraw(sc.withdrawAt.memberId);
      }
    })
    : null);

  let guard = 0;
  while (!rt.finished && guard++ < 200) {
    rt.tick();
    pull();
    trigger?.(state.tick);
    if (opts.breakDroneAtTick && state.tick === opts.breakDroneAtTick) {
      const d = state.device('drone1');
      if (d) {
        d.broken = true;
        state.setFact('broken:drone1');
        events.push({ tick: state.tick, type: 'inject', message: '注入故障：航测仪D-1 损坏' });
        const ownerUid = rt.locks.get('drone1');
        if (ownerUid) {
          const leaf = rt.index.get(ownerUid);
          rt._releaseLeafRuntime(leaf);
          rt._failLeaf(leaf, '航测仪D-1 中途损坏');
        } else {
          // 设备空闲时损坏：仍需使用它的未完成动作直接失败并级联阻止下游
          for (const l of rt.index.values()) {
            if (l.resources.includes('drone1') && ['ready', 'running'].includes(l.status)) {
              rt._failLeaf(l, '航测仪D-1 已损坏，该动作无法执行');
            }
          }
        }
      }
    }
  }
  pull();
  return {
    ok: true,
    trace: planned.trace,
    tree: rt.treeView(),
    events,
    summary: rt.summary(),
    state: state.snapshot(),
    methodByRoot: Object.fromEntries(rt.roots.map((r) => [r.requestId, r.methodId])),
  };
}
