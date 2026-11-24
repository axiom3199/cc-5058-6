// 分解期预订台账：把“载具席位表”与“可借用器材”作为有限容量资源在规划阶段预订。
// - 两名队员合用一辆车：车辆按席位容量（seats）预订；同一队员不可重复占座。
// - 可借用器材按容量（默认 1）借给某个分支；分支失败时撤回该分支的全部借用（rollback），再换人重试。
//
// 两层所有权（关键）：
// - root 预订：已成功落地的前序团队/复合所持容量，跨后续分支长期保留（真正的“已被占用”）。
// - branch 预订：当前方法尝试内的临时预订，该方法失败/换人时只撤回本分支，不动 root 预订。
// 因此后到团队遇到满员席位会真实冲突，而不是把前人的预订一起撤掉。

export class ReservationLedger {
  constructor(state) {
    this.state = state;
    this.capacity = new Map(); // 容量键 -> 总容量
    this.holders = new Map();  // 容量键 -> [{ token, scope, branchId, ref }]
    this.branchSeq = 0;
    this.tokenSeq = 0;
    this.events = []; // 预订/撤回/冲突审计，供界面与基准对应执行证据
  }

  static seatKey(vehicleId) { return `seat:${vehicleId}`; }
  static memberSeatKey(memberId) { return `member:${memberId}`; }
  static loanKey(deviceId) { return `loan:${deviceId}`; }

  _ensure(key, total) {
    if (!this.capacity.has(key)) this.capacity.set(key, total);
  }

  _list(key) { return this.holders.get(key) ?? []; }

  beginBranch(label) {
    const branchId = `B${++this.branchSeq}`;
    this.events.push({ type: 'branch-begin', branchId, label });
    return branchId;
  }

  // 一个复合任务成功落地：把它的 branch 预订提升为 root 预订（后续团队不可撤回）
  commitBranch(branchId) {
    let n = 0;
    for (const list of this.holders.values()) {
      for (const h of list) {
        if (h.branchId === branchId && h.scope === 'branch') { h.scope = 'root'; n += 1; }
      }
    }
    if (n) this.events.push({ type: 'commit', branchId, count: n });
    return n;
  }

  reserve(key, total, branchId, ref, scope = 'branch') {
    this._ensure(key, total);
    const list = this._list(key);
    if (list.length >= this.capacity.get(key)) {
      this.events.push({ type: 'conflict', branchId, key, ref, reason: '容量已满' });
      return null;
    }
    const token = `R${++this.tokenSeq}`;
    list.push({ token, scope, branchId, ref });
    this.holders.set(key, list);
    this.events.push({ type: 'reserve', branchId, key, ref, token, scope, used: list.length, total: this.capacity.get(key) });
    return token;
  }

  reserveSeat(vehicleId, memberId, branchId) {
    const v = this.state.vehicle(vehicleId);
    const total = v?.seats ?? 0;
    const key = ReservationLedger.seatKey(vehicleId);
    const list = this._list(key);
    if (list.some((h) => h.ref.memberId === memberId)) {
      return { ok: true, reused: true }; // 同一队员已占该车席位：幂等
    }
    const token = this.reserve(key, total, branchId, { kind: 'seat', memberId });
    if (!token) return { ok: false, reason: `载具 ${vehicleId} 席位已被占用` };
    const mk = ReservationLedger.memberSeatKey(memberId);
    const mToken = this.reserve(mk, 1, branchId, { kind: 'member-seat', vehicleId, memberId });
    if (!mToken) {
      this.release(token);
      return { ok: false, reason: `队员 ${memberId} 已在另一辆车上` };
    }
    return { ok: true, token, memberToken: mToken };
  }

  reserveLoan(deviceId, branchId, leafUid) {
    const key = ReservationLedger.loanKey(deviceId);
    const list = this._list(key);
    const mine = list.find((h) => h.branchId === branchId && h.ref.deviceId === deviceId);
    if (mine) return { ok: true, reused: true, token: mine.token };
    const token = this.reserve(key, 1, branchId, { kind: 'loan', deviceId, leafUid });
    if (!token) return { ok: false, reason: `器材 ${deviceId} 已被其他分支借用` };
    return { ok: true, token };
  }

  release(token) {
    for (const [key, list] of this.holders) {
      const i = list.findIndex((h) => h.token === token);
      if (i >= 0) {
        const [removed] = list.splice(i, 1);
        this.events.push({ type: 'release', key, token, branchId: removed.branchId, ref: removed.ref });
        if (!list.length) this.holders.delete(key);
        return true;
      }
    }
    return false;
  }

  // 只撤回某分支的临时预订；root 预订（前序成功团队）保留
  releaseBranch(branchId, reason = '分支撤回') {
    let count = 0;
    for (const [key, list] of this.holders) {
      const keep = [];
      for (const h of list) {
        if (h.branchId === branchId && h.scope === 'branch') {
          count += 1;
          this.events.push({ type: 'rollback', branchId, key, ref: h.ref, reason });
        } else keep.push(h);
      }
      if (keep.length) this.holders.set(key, keep);
      else this.holders.delete(key);
    }
    return count;
  }

  occupancy() {
    const out = [];
    for (const [key, list] of this.holders) {
      out.push({ key, used: list.length, total: this.capacity.get(key), holders: list.map((h) => h.ref) });
    }
    return out;
  }
}
