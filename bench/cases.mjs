// 分解搜索优化基准用例。每个用例给出：世界构造、重复请求、模式选项、
// 世界变更注入（条件改动）、断言函数（漏分解数、撤回/换人/命中计数、可执行性）。
import { benchWorld, BENCH_METHODS } from './domain.mjs';

const benchOpts = { registry: BENCH_METHODS };

// 四个团队同请返程：只有一辆两车面包车（两个座位），8 个席位需求争 2 座。
// 首个团队占满席位后，后续团队预订即冲突 → 撤回该分支预订并换人，台账留痕谁最终上车。
function seatConflictCase() {
  const build = () => benchWorld({
    members: 6,
    vehicles: [{ id: 'van1', name: '面包车', seats: 2 }],
  });
  const requests = Array.from({ length: 4 }, (_, i) => ({
    id: `team${String.fromCharCode(65 + i)}`, task: 'teamReturn', ctx: { teamId: String.fromCharCode(65 + i) },
  }));
  return {
    id: 'seatConflict',
    name: '席位冲突·撤回换人',
    build, requests, opts: benchOpts,
    expect(result) {
      const events = result.reservationEvents ?? [];
      return {
        '席位容量被占满（两人上车）': result.ledger?.some((o) => o.key === 'seat:van1' && o.used === 2 && o.total === 2) ?? false,
        '记录到冲突/撤回/换人留痕': events.some((e) => ['conflict', 'rollback', 'swap'].includes(e.type))
          || (result.stats?.swaps ?? 0) > 0,
      };
    },
  };
}

// 同名装备互换：调换 deviceA/deviceB 后，与不缓存展开对照，漏分解必须为 0
function deviceSwapCase() {
  const build = () => benchWorld({
    members: 4,
    devices: [
      { id: 'sensorX1', name: '同型号观测仪-1', locId: 'siteA' },
      { id: 'sensorX2', name: '同型号观测仪-2', locId: 'base' },
    ],
  });
  const requests = [
    { id: 'swap1', task: 'deviceSwap', ctx: { pairId: 'p1', deviceA: 'sensorX1', deviceB: 'sensorX2' } },
  ];
  return {
    id: 'deviceSwap',
    name: '同名装备互换·复用键区分实体',
    build, requests, opts: benchOpts,
    mutate(state) {
      const a = state.device('sensorX1');
      const b = state.device('sensorX2');
      const tmp = a.locId;
      a.locId = b.locId;
      b.locId = tmp;
      state.touch();
    },
    expect() { return {}; },
  };
}

// 世界事实变化失效：首次分解后撤走一名队员，再分解必须重核前提，不能复用旧证明
function worldChangeCase() {
  const build = () => benchWorld({
    members: 4,
    vehicles: [{ id: 'van1', name: '面包车', seats: 2 }],
    devices: [{ id: 'scope1', name: '便携核查仪', locId: 'base' }],
  });
  const requests = [
    { id: 'c1', task: 'instrumentCheck', ctx: { targetId: 't1', deviceId: 'scope1' } },
  ];
  return {
    id: 'worldChange',
    name: '世界事实变化·缓存及时失效',
    build, requests, opts: benchOpts,
    mutate(state) {
      state.withdraw('m1'); // 工程师退出，能力集合变化
    },
    expect(result, ctx) {
      return {
        '版本号随事实变化递增': ctx.afterRevision > ctx.beforeRevision,
        '变化后未把旧证明当命中': !(result._forbiddenHit),
      };
    },
  };
}

// 失败前提 + TTL：在缺乏载具的世界反复请求返程，nogood 命中；TTL 过后必须重新展开
function nogoodTtlCase() {
  const build = () => benchWorld({ members: 4, vehicles: [] });
  const requests = [{ id: 'r1', task: 'teamReturn', ctx: { teamId: 'A' } }];
  return {
    id: 'nogoodTtl',
    name: '失败前提缓存·TTL 与失效',
    build, requests, opts: { ...benchOpts, nogoodTtlTicks: 3 },
    expect() { return {}; },
  };
}

// 重复子任务负载：同形态 instrumentCheck 反复出现，proof 模式展开数应显著少于 off。
// 8 个请求配 8 台仪器，避免资源容量干扰，纯粹度量重复子任务的复用收益。
function repeatedLoadCase() {
  const build = () => benchWorld({
    members: 6,
    devices: Array.from({ length: 8 }, (_, i) => ({ id: `scope${i + 1}`, name: `核查仪${i + 1}`, locId: 'base' })),
  });
  const requests = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`, task: 'instrumentCheck', ctx: { targetId: `t${i}`, deviceId: `scope${i + 1}` },
  }));
  return {
    id: 'repeatedLoad',
    name: '重复子任务负载',
    build, requests, opts: benchOpts,
    expect() { return {}; },
  };
}

// 嵌套复合复用：returnAfterCheck 内部含两个嵌套复合，重复请求时嵌套子树也应命中缓存。
// 4 个团队各配独立车辆与仪器，保证全部计划可执行，重点观察嵌套展开数下降。
function nestedReuseCase() {
  const build = () => benchWorld({
    members: 8,
    vehicles: Array.from({ length: 4 }, (_, i) => ({ id: `van${i + 1}`, name: `面包车${i + 1}`, seats: 2 })),
    devices: Array.from({ length: 4 }, (_, i) => ({ id: `nscope${i + 1}`, name: `核查仪${i + 1}`, locId: 'base' })),
  });
  const requests = Array.from({ length: 4 }, (_, i) => ({
    id: `n${i}`, task: 'returnAfterCheck',
    ctx: { teamId: `T${i}`, targetId: `tg${i}`, deviceId: `nscope${i + 1}`, vanId: `van${i + 1}` },
  }));
  return {
    id: 'nestedReuse',
    name: '嵌套复合子树复用',
    build, requests, opts: benchOpts,
    expect() { return {}; },
  };
}export const BENCH_CASES = {
  seatConflict: seatConflictCase(),
  deviceSwap: deviceSwapCase(),
  worldChange: worldChangeCase(),
  nogoodTtl: nogoodTtlCase(),
  repeatedLoad: repeatedLoadCase(),
  nestedReuse: nestedReuseCase(),
};

export const BENCH_CASE_IDS = Object.keys(BENCH_CASES);
