// 高层任务方法（HTN methods）。
// 关键约束：编辑树的书写顺序不等于执行顺序——节点显式声明 dependsOn 与资源，
// 运行时按依赖和资源占用调度；每个方法用 applicable(state,ctx) 核对当前角色能力与物件状态。

const cap = (memberId, ...need) => (s) => need.every((c) => s.hasCap(memberId, c));
const at = (memberId, locId) => (s) => s.member(memberId)?.locId === locId;
const itemExists = (itemId) => (s) => !!s.item(itemId);

// ---- 复合任务：在某观测点建立供电（嵌套复合，注册在标准方案内部，演示祖先回溯） ----
function setupPowerRegistry(ctx) {
  const { siteId } = ctx;
  return {
    label: '建立供电',
    goal: (s) => s.fact(`powered:${siteId}`),
    methods: [{
      id: 'setupPower.standard',
      label: '电池供电方案',
      applicable: (s) => !!s.item('battery')
        && s.activeMembers().some((m) => m.capabilities.has('electrical')),
      build() {
        return {
          leaves: [
            { id: 'carryBattery', action: 'carry', needs: ['carry'],
              ctx: { itemId: 'battery', locId: siteId }, dependsOn: [] },
            { id: 'doPower', action: 'setupPower', needs: ['electrical'],
              ctx: { locId: siteId, powerId: 'battery' }, dependsOn: ['carryBattery'] },
          ],
          goal: (st) => st.fact(`powered:${siteId}`),
        };
      },
    }],
  };
}

export const METHODS = {
  deployObservation: {
    label: '布置观测点',
    goal: (s, ctx) => s.stationReady(ctx.siteId) && s.fact(`verified:${ctx.siteId}`),
    methods: [
      {
        id: 'deploy.standard',
        label: '标准方案：观测杆+观测仪+供电+标定验收',
        // 适用性核对：部件齐全且具备电气/标定能力的队员在场
        applicable: (s) => ['mast', 'sensor', 'battery'].every((id) => !!s.item(id))
          && s.activeMembers().some((m) => m.capabilities.has('electrical'))
          && s.activeMembers().some((m) => m.capabilities.has('calibrate')),
        build(s, ctx) {
          const { siteId } = ctx;
          s.stations.set(`st-${siteId}`, { id: `st-${siteId}`, siteId, built: false, mounted: false, powered: false, calibrated: false });
          return {
            compounds: { setupPower: setupPowerRegistry(ctx) },
            leaves: [
              { id: 'carryMast', action: 'carry', needs: ['carry'],
                ctx: { itemId: 'mast', locId: siteId }, dependsOn: [] },
              { id: 'carrySensor', action: 'carry', needs: ['carry'],
                ctx: { itemId: 'sensor', locId: siteId }, dependsOn: [] },
              { id: 'travelEng', action: 'travel', needs: ['travel'],
                ctx: { locId: siteId }, dependsOn: [] },
              { id: 'travelWrk', action: 'travel', needs: ['travel'],
                ctx: { locId: siteId }, dependsOn: [] },
              { id: 'assembleMast', action: 'assemble', needs: ['assemble'],
                ctx: { itemId: 'mast' }, dependsOn: ['carryMast', 'travelWrk'] },
              // 嵌套复合节点：电力子任务整体是安装/标定的前置
              { id: 'setupPower', compound: 'setupPower', dependsOn: ['travelEng'] },
              { id: 'mountSensor', action: 'mount', needs: ['mount'],
                ctx: { itemId: 'sensor', locId: siteId, benchId: `bench${siteId.replace('site', '')}` },
                dependsOn: ['carrySensor', 'assembleMast', 'setupPower'] },
              { id: 'calibrate', action: 'calibrate', needs: ['calibrate'],
                ctx: { locId: siteId, deviceId: 'drone1' },
                dependsOn: ['mountSensor', 'setupPower'] },
              { id: 'inspect', action: 'inspect', needs: ['inspect'],
                ctx: { locId: siteId }, dependsOn: ['calibrate'] },
            ],
            goal: (st) => st.stationReady(siteId) && st.fact(`verified:${siteId}`),
          };
        },
      },
      {
        id: 'deploy.light',
        label: '轻量化方案：仅立杆并人工检查',
        // 只要有可搬运/组装/检查的人力和一根观测杆即可
        applicable: (s) => !!s.item('mast')
          && s.activeMembers().some((m) => m.capabilities.has('assemble'))
          && s.activeMembers().some((m) => m.capabilities.has('inspect')),
        build(s, ctx) {
          const { siteId } = ctx;
          s.stations.set(`st-${siteId}`, { id: `st-${siteId}`, siteId, built: false, mounted: false, powered: false, calibrated: false });
          return {
            leaves: [
              { id: 'carryMast', action: 'carry', needs: ['carry'],
                ctx: { itemId: 'mast', locId: siteId }, dependsOn: [] },
              { id: 'travelInspector', action: 'travel', needs: ['travel'],
                ctx: { locId: siteId }, dependsOn: [] },
              { id: 'assembleMast', action: 'assemble', needs: ['assemble'],
                ctx: { itemId: 'mast' }, dependsOn: ['carryMast'] },
              { id: 'inspect', action: 'inspect', needs: ['inspect'],
                ctx: { locId: siteId }, dependsOn: ['assembleMast', 'travelInspector'] },
            ],
            goal: (st) => st.fact(`inspected:${siteId}`)
              && !!st.stationAt(siteId) && st.stationAt(siteId).built,
          };
        },
      },
    ],
  },

  surveyRoute: {
    label: '路线踏勘',
    goal: (s, ctx) => s.fact(`surveyed:${ctx.routeId}`),
    methods: [
      {
        id: 'survey.drone',
        label: '航测方案：使用共享航测仪',
        applicable: (s) => !!s.device('drone1')
          && s.activeMembers().some((m) => m.capabilities.has('drone')),
        build(s, ctx) {
          return {
            leaves: [
              { id: 'scan', action: 'deviceScan', needs: ['drone'],
                ctx: { deviceId: 'drone1', locId: ctx.locId, routeId: ctx.routeId }, dependsOn: [] },
            ],
            goal: (st) => st.fact(`surveyed:${ctx.routeId}`),
          };
        },
      },
      {
        id: 'survey.foot',
        label: '徒步踏勘方案',
        applicable: (s) => s.activeMembers().some((m) => m.capabilities.has('scout')),
        build(s, ctx) {
          return {
            leaves: [
              { id: 'walk', action: 'walkSurvey', needs: ['scout'],
                ctx: { locId: ctx.locId, routeId: ctx.routeId }, dependsOn: [] },
            ],
            goal: (st) => st.fact(`surveyed:${ctx.routeId}`),
          };
        },
      },
    ],
  },
};
