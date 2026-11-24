// 分解搜索优化基准域：在考察任务内核之外构造可重复的层级任务负载。
// 对应题面隐喻：
// - teamReturn（队伍返程）：两名队员合用一辆车 → 向载具席位表预订返程席位；
// - instrumentCheck（仪器核查）：向器材台账借用仪器，分支失败要撤回借用再换人；
// - deviceSwap（同名装备互换）：两台同型号装备调换，验证复用键记录的是“实际消耗的能力/具体实体”。
//
// 叶子上的 reserve 字段由规划器在分派时写入 ReservationLedger：
//   { vehicleId } 预订车辆席位；{ deviceId } 借用可借器材。

import { WorldState } from '../src/state.mjs';

export const BENCH_METHODS = {
  teamReturn: {
    label: '队伍返程',
    goal: (s, ctx) => s.fact(`returned:${ctx.teamId}`),
    methods: [
      {
        id: 'return.van',
        label: '面包车合乘方案（两席位）',
        applicable: (s, c) => s.activeMembers().length >= 2
          && s.activeMembers().filter((m) => m.capabilities.has('travel')).length >= 2
          && !!s.vehicle(c.vanId ?? 'van1'),
        build(s, ctx) {
          const vanId = ctx.vanId ?? 'van1';
          return {
            leaves: [
              { id: 'seatA', action: 'boardVehicle', needs: ['travel'],
                ctx: { teamId: ctx.teamId, vehicleId: vanId }, reserve: [{ vehicleId: vanId }], dependsOn: [] },
              { id: 'seatB', action: 'boardVehicle', needs: ['travel'],
                ctx: { teamId: ctx.teamId, vehicleId: vanId }, reserve: [{ vehicleId: vanId }], dependsOn: [] },
              { id: 'depart', action: 'departReturn', needs: ['drive'],
                ctx: { vehicleId: vanId, teamId: ctx.teamId }, dependsOn: ['seatA', 'seatB'] },
            ],
            goal: (st) => st.fact(`returned:${ctx.teamId}`),
          };
        },
      },
    ],
  },

  instrumentCheck: {
    label: '仪器核查',
    goal: (s, ctx) => s.fact(`checked:${ctx.targetId}`),
    methods: [
      {
        id: 'check.borrowed',
        label: '借用核查方案',
        applicable: (s, c) => !!s.device(c.deviceId)
          && s.activeMembers().some((m) => m.capabilities.has('inspect')),
        build(s, ctx) {
          return {
            leaves: [
              { id: 'borrow', action: 'loanInstrument', needs: ['carry'],
                ctx: { deviceId: ctx.deviceId }, reserve: [{ deviceId: ctx.deviceId }], dependsOn: [] },
              { id: 'check', action: 'benchInspect', needs: ['inspect'],
                ctx: { targetId: ctx.targetId, deviceId: ctx.deviceId }, dependsOn: ['borrow'] },
            ],
            goal: (st) => st.fact(`checked:${ctx.targetId}`),
          };
        },
      },
    ],
  },

  deviceSwap: {
    label: '同名装备互换',
    goal: (s, ctx) => s.fact(`swapped:${ctx.pairId}`),
    methods: [
      {
        id: 'swap.manual',
        label: '人工互换方案',
        applicable: (s) => s.activeMembers().some((m) => m.capabilities.has('carry'))
          && s.activeMembers().some((m) => m.capabilities.has('repair')),
        build(s, ctx) {
          return {
            leaves: [
              { id: 'unmountA', action: 'unmount', needs: ['carry'],
                ctx: { deviceId: ctx.deviceA }, dependsOn: [] },
              { id: 'unmountB', action: 'unmount', needs: ['carry'],
                ctx: { deviceId: ctx.deviceB }, dependsOn: [] },
              { id: 'remount', action: 'remount', needs: ['repair'],
                ctx: { deviceA: ctx.deviceA, deviceB: ctx.deviceB, pairId: ctx.pairId },
                dependsOn: ['unmountA', 'unmountB'] },
            ],
            goal: (st) => st.fact(`swapped:${ctx.pairId}`),
          };
        },
      },
    ],
  },

  // 嵌套复合：返程前先核查仪器（演示缓存中嵌套子树的复用）
  returnAfterCheck: {
    label: '核查后返程',
    goal: (s, ctx) => s.fact(`returned:${ctx.teamId}`) && s.fact(`checked:${ctx.targetId}`),
    methods: [
      {
        id: 'rac.standard',
        label: '先核查后合乘',
        applicable: (s) => true,
        build(s, ctx) {
          // 嵌套子复合复用外层任务 ctx（teamId/targetId/deviceId），方法内全部经 taskCtx 取值
          const checkMethods = [{
            id: 'check.borrowed.nested',
            label: '借用核查方案（嵌套）',
            applicable: (st, c) => !!st.device(c.deviceId)
              && st.activeMembers().some((m) => m.capabilities.has('inspect')),
            build(st, c) {
              return {
                leaves: [
                  { id: 'borrow', action: 'loanInstrument', needs: ['carry'],
                    ctx: { deviceId: c.deviceId }, reserve: [{ deviceId: c.deviceId }], dependsOn: [] },
                  { id: 'check', action: 'benchInspect', needs: ['inspect'],
                    ctx: { targetId: c.targetId, deviceId: c.deviceId }, dependsOn: ['borrow'] },
                ],
                goal: (sst) => sst.fact(`checked:${c.targetId}`),
              };
            },
          }];
          return {
            compounds: {
              check: {
                label: '仪器核查（嵌套）',
                goal: (st, c2) => st.fact(`checked:${c2.targetId}`),
                methods: checkMethods,
              },
              ret: {
                label: '队伍返程（嵌套）',
                goal: (st, c2) => st.fact(`returned:${c2.teamId}`),
                methods: [{
                  id: 'return.van.nested',
                  label: '面包车合乘方案（嵌套）',
                  applicable: (st, c) => st.activeMembers().length >= 2
                    && st.activeMembers().filter((m) => m.capabilities.has('travel')).length >= 2
                    && !!st.vehicle(c.vanId),
                  build(st, c) {
                    return {
                      leaves: [
                        { id: 'seatA', action: 'boardVehicle', needs: ['travel'],
                          ctx: { teamId: c.teamId, vehicleId: c.vanId }, reserve: [{ vehicleId: c.vanId }], dependsOn: [] },
                        { id: 'seatB', action: 'boardVehicle', needs: ['travel'],
                          ctx: { teamId: c.teamId, vehicleId: c.vanId }, reserve: [{ vehicleId: c.vanId }], dependsOn: [] },
                        { id: 'depart', action: 'departReturn', needs: ['drive'],
                          ctx: { vehicleId: c.vanId, teamId: c.teamId }, dependsOn: ['seatA', 'seatB'] },
                      ],
                      goal: (sst) => sst.fact(`returned:${c.teamId}`),
                    };
                  },
                }],
              },
            },
            leaves: [
              { id: 'check', compound: 'check', dependsOn: [] },
              { id: 'ret', compound: 'ret', dependsOn: ['check'] },
            ],
            goal: (st) => st.fact(`returned:${ctx.teamId}`) && st.fact(`checked:${ctx.targetId}`),
          };
        },
      },
    ],
  },
};

export const BENCH_ACTIONS = {
  boardVehicle: {
    label: '登车占座 {vehicleId}',
    caps: ['travel'],
    duration: 1,
    pre(s, ctx) {
      const m = s.member(ctx.memberId);
      return !!m && m.status === 'active';
    },
    finish(s, ctx) { s.record(`${s.member(ctx.memberId).name} 登车`); },
  },
  departReturn: {
    label: '发车返程',
    caps: ['drive'],
    duration: 2,
    pre(s, ctx) { return !!s.vehicle(ctx.vehicleId); },
    finish(s, ctx) {
      s.setFact(`returned:${ctx.teamId}`);
      s.record(`面包车载两队成员返程`);
    },
  },
  loanInstrument: {
    label: '借用仪器 {deviceId}',
    caps: ['carry'],
    duration: 1,
    pre(s, ctx) { return !!s.device(ctx.deviceId); },
    finish(s, ctx) { s.record(`${s.member(ctx.memberId).name} 借用 ${ctx.deviceId}`); },
  },
  benchInspect: {
    label: '核查 {targetId}',
    caps: ['inspect'],
    duration: 2,
    pre() { return true; },
    finish(s, ctx) {
      s.setFact(`checked:${ctx.targetId}`);
      s.record(`完成 ${ctx.targetId} 核查`);
    },
  },
  unmount: {
    label: '拆下 {deviceId}',
    caps: ['carry'],
    duration: 1,
    pre(s, ctx) { return !!s.device(ctx.deviceId); },
    finish(s, ctx) { s.record(`拆下 ${ctx.deviceId}`); },
  },
  remount: {
    label: '互换重装 {deviceA}/{deviceB}',
    caps: ['repair'],
    duration: 2,
    pre(s, ctx) { return !!s.device(ctx.deviceA) && !!s.device(ctx.deviceB); },
    finish(s, ctx) {
      const a = s.device(ctx.deviceA);
      const b = s.device(ctx.deviceB);
      const tmp = a.locId;
      a.locId = b.locId;
      b.locId = tmp;
      s.setFact(`swapped:${ctx.pairId ?? `${ctx.deviceA}-${ctx.deviceB}`}`);
      s.record(`两台同名装备完成互换`);
    },
  },
};

// ---- 基准世界工厂 ----
export function benchWorld({ members = 4, vehicles = [], devices = [], items = [] } = {}) {
  const s = new WorldState();
  s.addLocation('base', '营地', { x: 0, y: 0, z: 0 }, 'base');
  s.addLocation('siteA', 'A号点', { x: 10, y: 0, z: 10 }, 'site');
  const roles = [
    ['m1', '队员一', 'engineer'],
    ['m2', '队员二', 'worker'],
    ['m3', '队员三', 'scout'],
    ['m4', '队员四', 'medic'],
    ['m5', '队员五', 'engineer'],
    ['m6', '队员六', 'worker'],
    ['m7', '队员七', 'scout'],
    ['m8', '队员八', 'medic'],
  ];
  const caps = {
    engineer: ['travel', 'carry', 'assemble', 'mount', 'electrical', 'calibrate', 'repair', 'drive', 'inspect'],
    worker: ['travel', 'carry', 'assemble', 'inspect'],
    scout: ['travel', 'carry', 'scout', 'drone', 'inspect'],
    medic: ['travel', 'carry', 'inspect'],
  };
  for (let i = 0; i < members; i++) {
    const [id, name, role] = roles[i];
    s.addMember({ id, name, role, locId: 'base', capabilities: caps[role] });
  }
  for (const v of vehicles) s.addVehicle({ seats: 2, ...v });
  for (const d of devices) s.addDevice({ requires: [], ...d });
  for (const it of items) s.addItem(it);
  return s;
}
