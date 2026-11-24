// 分解搜索优化：带证明的子计划复用（proof memo）与失败前提缓存（nogood + TTL）。
//
// 计算顺序（为什么这样复用是安全的）：
// 1. 分解一个复合任务前，先由 makeKey() 计算复用键：任务名 + 任务上下文 +
//    当前在岗队员“实际具备的能力签名”。签名按队员 id 排序后摘要，保证换人/能力变化会改键。
// 2. 键命中且世界版本 revision 未变 → 直接信任证明中记录的观察快照（同版本内谓词真值不变）。
// 3. 键命中但 revision 已变 → 不把未观察到的条件当作确定：逐条重放证明里记录的前提观察，
//    任一观察与当前世界不符即作废，回退为完整展开（proofMiss）。
// 4. 仅 nogood 模式只缓存失败前提及其 TTL：同版本且未超时才短路，世界事实变化（revision 变）即失效。
// 5. 重放通过后，物化时再核对被分派队员仍在岗且具备该叶子“实际消耗的能力”，
//    席位/器材预订冲突则交回规划器撤回分支并换人。

// 在岗队员能力签名：记录该世界状态下可消耗的实际能力（含队员身份，避免同名装备/同能力混淆）
export function capabilitySignature(state) {
  return state.activeMembers()
    .map((m) => `${m.id}:{[...m.capabilities].sort().join(',')}`)
    .sort()
    .join('|');
}

// 稳定序列化任务上下文
export function stableJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableJson).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function makeKey(taskName, taskCtx, state) {
  return `${taskName}::${stableJson(taskCtx)}::${capabilitySignature(state)}`;
}

// 在受控包装状态上运行一次方法适用性核对，记录它真正读过的世界前提（证明）。
// 未被读取的条件不会进入观察表，因此复用时也不会被假定为真/假。
export function trackApplicable(state, fn) {
  const observations = [];
  const rec = (kind, ref, expected) => observations.push({ kind, ref, expected });

  const tracked = {
    fact(p) { const v = state.fact(p); rec('fact', p, v); return v; },
    item(id) { const v = state.item(id); rec('itemExists', id, !!v); return v; },
    device(id) { const v = state.device(id); rec('deviceExists', id, !!v); return v; },
    vehicle(id) { const v = state.vehicle(id); rec('vehicleExists', id, !!v); return v; },
    member(id) {
      const v = state.member(id);
      rec('memberExists', id, !!v);
      if (v) {
        rec('memberStatus', id, v.status);
        rec('memberLoc', id, v.locId);
      }
      return v;
    },
    hasCap(memberId, cap) {
      const v = state.hasCap(memberId, cap);
      rec('hasCap', `${memberId}|${cap}`, v);
      return v;
    },
    activeMembers() {
      const members = state.activeMembers();
      // 记录在岗队员名单与每人能力集合：退出/换人/能力增减都必须使证明作废
      rec('activeRoster', null, members.map((m) => m.id).sort());
      for (const m of members) rec('activeCaps', m.id, [...m.capabilities].sort());
      return members;
    },
    stationAt(siteId) { return state.stationAt(siteId); },
  };

  const result = fn(tracked);
  return { result, observations };
}

// 重放观察表：逐条用当前世界重新核对，全部与记录值一致才返回 true
export function replayObservations(state, observations) {
  for (const o of observations) {
    switch (o.kind) {
      case 'fact':
        if (state.fact(o.ref) !== o.expected) return false;
        break;
      case 'itemExists':
        if (!!state.item(o.ref) !== o.expected) return false;
        break;
      case 'deviceExists':
        if (!!state.device(o.ref) !== o.expected) return false;
        break;
      case 'vehicleExists':
        if (!!state.vehicle(o.ref) !== o.expected) return false;
        break;
      case 'memberExists':
        if (!!state.member(o.ref) !== o.expected) return false;
        break;
      case 'memberStatus':
        if (state.member(o.ref)?.status !== o.expected) return false;
        break;
      case 'memberLoc':
        if (state.member(o.ref)?.locId !== o.expected) return false;
        break;
      case 'hasCap': {
        const [memberId, cap] = o.ref.split('|');
        if (state.hasCap(memberId, cap) !== o.expected) return false;
        break;
      }
      case 'activeCaps': {
        const m = state.member(o.ref);
        if (!m || m.status !== 'active') return false;
        const now = [...m.capabilities].sort();
        if (now.length !== o.expected.length || now.some((c, i) => c !== o.expected[i])) return false;
        break;
      }
      case 'activeRoster': {
        const now = state.activeMembers().map((m) => m.id).sort();
        if (now.length !== o.expected.length || now.some((id, i) => id !== o.expected[i])) return false;
        break;
      }
      default:
        return false; // 未知观察类型：保守作废，绝不假定
    }
  }
  return true;
}

export class Memo {
  constructor(mode = 'proof', { nogoodTtlTicks = 8 } = {}) {
    if (!['off', 'proof', 'nogood'].includes(mode)) throw new Error(`未知缓存模式 ${mode}`);
    this.mode = mode;
    this.nogoodTtlTicks = nogoodTtlTicks;
    this.proofs = new Map(); // key -> 证明条目
    this.nogoods = new Map(); // key -> 失败前提条目
    this.stats = {
      expansions: 0, proofHits: 0, proofMiss: 0, proofRejected: 0,
      nogoodHits: 0, invalidations: 0, swaps: 0, rollbacks: 0,
    };
  }

  get enabled() { return this.mode !== 'off'; }
  get proofEnabled() { return this.mode === 'proof'; }

  // 世界事实显式变更时调用：清空全部缓存（配合 revision 双保险）
  invalidate(reason = 'world-change') {
    if (!this.enabled) return;
    const n = this.proofs.size + this.nogoods.size;
    this.proofs.clear();
    this.nogoods.clear();
    if (n) this.stats.invalidations += 1;
    this._lastReason = reason;
  }

  // 查找仍有效的证明；返回 null 表示必须完整展开
  lookupProof(key, state) {
    if (!this.proofEnabled) return null;
    const entry = this.proofs.get(key);
    if (!entry) return null;
    if (entry.revision === state.revision) { this.stats.proofHits += 1; return entry; }
    // 版本变化：重放全部前提观察；不能把尚未观察到的条件当作确定
    if (replayObservations(state, entry.observations)
      && entry.capSig === capabilitySignature(state)) {
      this.stats.proofHits += 1;
      return entry;
    }
    this.proofs.delete(key);
    this.stats.proofRejected += 1;
    return null;
  }

  storeProof(key, entry) {
    if (!this.proofEnabled) return;
    this.proofs.set(key, entry);
  }

  // 单条证明作废：观察重放通过但方法在当前世界已不适用时使用
  rejectProof(key) {
    if (this.proofs.delete(key)) this.stats.proofRejected += 1;
  }

  // 失败前提缓存：同版本且未超 TTL 才可短路
  lookupNogood(key, state) {
    if (!this.enabled) return;
    const ng = this.nogoods.get(key);
    if (!ng) return;
    const expired = state.tick - ng.tick > this.nogoodTtlTicks;
    if (ng.revision !== state.revision || expired) {
      this.nogoods.delete(key);
      return;
    }
    this.stats.nogoodHits += 1;
    return ng;
  }

  storeNogood(key, reason, state) {
    if (!this.enabled) return;
    this.nogoods.set(key, { reason, revision: state.revision, tick: state.tick });
  }
}
