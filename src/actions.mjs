// 底层可执行动作（primitive tasks）。
// 动作不是状态名：每个动作声明能力前提、资源占用、耗时、是否允许途中退出，
// 并在结束时由 finish() 对世界状态做真实变更；运行时再用世界谓词确认完成。

export const ACTIONS = {
  travel: {
    label: '前往 {locName}',
    caps: ['travel'],
    duration: 3,
    enRoute: true,
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      return m && m.status === 'active' && m.locId !== ctx.locId;
    },
    enter(s, ctx) { s.record(`${s.member(ctx.memberId).name} 出发前往 ${s.loc(ctx.locId).name}`); },
    settle(s, ctx) {
      const m = s.member(ctx.memberId);
      return !!m && m.locId === ctx.locId; // 已在目的地（可能由搬运顺带抵达）
    },
    finish(s, ctx) {
      const m = s.member(ctx.memberId);
      m.locId = ctx.locId;
      s.record(`${m.name} 抵达 ${s.loc(ctx.locId).name}`);
    },
  },

  carry: {
    label: '搬运 {itemName} 至 {locName}',
    caps: ['carry'],
    duration: 4,
    enRoute: true,
    pre(s, ctx) {
      const it = s.item(ctx.itemId);
      if (!it || it.mounted) return false;
      const m = s.member(ctx.memberId);
      if (!m || m.status !== 'active') return false;
      // 已持有该物资（如前人退出后就地接手）可继续搬运；持有别的物资则不行
      if (m.carrying && m.carrying !== it.id) return false;
      const at = s.itemLoc(ctx.itemId);
      // 物资在队员所在地点（含他人退出时就地放下的物资），且尚不在目的地
      const accessible = (at.type === 'loc' && at.id === m.locId)
        || (at.type === 'holder' && at.id === ctx.memberId);
      return accessible && m.locId !== ctx.locId;
    },
    // 队员与物资已在目的地时的就地落位（无需移动）
    settle(s, ctx) {
      const it = s.item(ctx.itemId);
      const m = s.member(ctx.memberId);
      if (it.locId === ctx.locId && (!it.holderId || it.holderId === m.id)) {
        it.locId = ctx.locId;
        if (it.holderId === m.id) { it.holderId = null; m.carrying = null; }
        return true;
      }
      return false;
    },
    enter(s, ctx) {
      const m = s.member(ctx.memberId);
      const it = s.item(ctx.itemId);
      if (m.carrying === it.id) return; // 已持有（接手场景），不重复拿起
      it.holderId = m.id;
      m.carrying = it.id;
      s.record(`${m.name} 扛起 ${it.name}`);
    },
    finish(s, ctx) {
      const m = s.member(ctx.memberId);
      const it = s.item(ctx.itemId);
      m.locId = ctx.locId;
      it.locId = ctx.locId;
      it.holderId = null;
      m.carrying = null;
      s.record(`${m.name} 把 ${it.name} 送达 ${s.loc(ctx.locId).name}`);
    },
    verifyEnd(s, ctx) {
      const m = s.member(ctx.memberId);
      const it = s.item(ctx.itemId);
      return m?.status === 'active' && it && it.holderId === m.id && m.carrying === it.id;
    },
  },

  assemble: {
    label: '组装 {itemName}',
    caps: ['assemble'],
    duration: 4,
    pre(s, ctx) {
      const it = s.item(ctx.itemId);
      const m = s.member(ctx.memberId);
      return it && !it.assembled && m.locId === it.locId;
    },
    finish(s, ctx) {
      const it = s.item(ctx.itemId);
      it.assembled = true;
      const st = s.stationAt(it.locId);
      if (st) st.built = true;
      s.record(`${s.member(ctx.memberId).name} 完成 ${it.name} 的组装`);
    },
  },

  mount: {
    label: '安装 {itemName} 到观测点',
    caps: ['mount'],
    duration: 3,
    resources: (ctx) => (ctx.benchId ? [ctx.benchId] : []),
    pre(s, ctx) {
      const it = s.item(ctx.itemId);
      const m = s.member(ctx.memberId);
      // 观测杆已组装、待安装部件已运抵，队员同在现场
      const mast = s.item('mast');
      return it && !it.mounted && m.locId === ctx.locId && it.locId === ctx.locId
        && mast && mast.assembled && mast.locId === ctx.locId;
    },
    finish(s, ctx) {
      const it = s.item(ctx.itemId);
      it.mounted = true;
      const st = s.stationAt(ctx.locId);
      if (st) { st.built = true; st.mounted = true; }
      s.record(`${s.member(ctx.memberId).name} 将 ${it.name} 安装就位`);
    },
  },

  setupPower: {
    label: '建立供电（{powerName}）',
    caps: ['electrical'],
    duration: 4,
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      return m.locId === ctx.locId && !!s.item(ctx.powerId)
        && s.item(ctx.powerId).locId === ctx.locId && !s.fact(`powered:${ctx.locId}`);
    },
    finish(s, ctx) {
      const st = s.stationAt(ctx.locId);
      if (st) st.powered = true;
      s.setFact(`powered:${ctx.locId}`);
      s.record(`${s.member(ctx.memberId).name} 在 ${s.loc(ctx.locId).name} 接通供电`);
    },
  },

  calibrate: {
    label: '标定观测仪器',
    caps: ['calibrate'],
    duration: 4,
    resources: (ctx) => (ctx.deviceId ? [ctx.deviceId] : []),
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      const st = s.stationAt(ctx.locId);
      return m.locId === ctx.locId && st && st.mounted && s.fact(`powered:${ctx.locId}`);
    },
    finish(s, ctx) {
      const st = s.stationAt(ctx.locId);
      st.calibrated = true;
      s.record(`${s.member(ctx.memberId).name} 完成仪器标定`);
    },
  },

  inspect: {
    label: '检查观测点',
    caps: ['inspect'],
    duration: 2,
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      return m.locId === ctx.locId;
    },
    finish(s, ctx) {
      const ok = s.stationReady(ctx.locId);
      s.setFact(`inspected:${ctx.locId}`);
      s.setFact(ok ? `verified:${ctx.locId}` : `inspect-failed:${ctx.locId}`);
      s.record(`${s.member(ctx.memberId).name} 检查观测点，${ok ? '全部条件满足，验收通过' : '条件不完整，验收未通过'}`);
    },
  },

  deviceScan: {
    label: '用 {deviceName} 航测路线',
    caps: ['drone'],
    duration: 5,
    resources: (ctx) => [ctx.deviceId],
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      const d = s.device(ctx.deviceId);
      // 设备由资源锁保证独占；队员在其当前位置即可展开航测，不绑定分解时的地点
      return !!m && m.status === 'active' && d && !d.broken;
    },
    finish(s, ctx) {
      s.setFact(`surveyed:${ctx.routeId}`);
      s.record(`${s.member(ctx.memberId).name} 在 ${s.member(ctx.memberId).locId === 'base' ? '营地' : '野外'} 完成航测`);
    },
  },

  walkSurvey: {
    label: '徒步踏勘 {routeName}',
    caps: ['scout'],
    duration: 6,
    enRoute: true,
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      return !!m && m.status === 'active';
    },
    finish(s, ctx) {
      s.setFact(`surveyed:${ctx.routeId}`);
      s.record(`${s.member(ctx.memberId).name} 完成徒步踏勘`);
    },
  },

  repair: {
    label: '抢修 {deviceName}',
    caps: ['repair'],
    duration: 3,
    resources: (ctx) => [ctx.deviceId],
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      const d = s.device(ctx.deviceId);
      return m.locId === ctx.locId && d && d.broken;
    },
    finish(s, ctx) {
      const d = s.device(ctx.deviceId);
      d.broken = false;
      s.facts.delete(`broken:${d.id}`);
      s.record(`${s.member(ctx.memberId).name} 修复了 ${d.name}`);
    },
  },
};

export function renderLabel(actionId, ctx, state) {
  const tpl = ACTIONS[actionId]?.label ?? actionId;
  const nameOf = (kind, id) => {
    if (!id) return id;
    const table = { item: state.items, loc: state.locations,
      member: state.members, device: state.devices };
    return table[kind]?.get(id)?.name ?? id;
  };
  return tpl.replace(/\{(\w+)\}/g, (_, key) => {
    if (key.endsWith('Name')) {
      const idKey = `${key.slice(0, -4)}Id`;
      const kind = key.slice(0, -4);
      return nameOf(kind, ctx[idKey]);
    }
    if (key.endsWith('Id')) {
      const kind = key.slice(0, -2);
      return nameOf(kind, ctx[key]);
    }
    return ctx[key] ?? '';
  });
}
