// 预置考察场景：不同人员组合、缺少部件、共享设备、队员途中退出。
// 每个场景构建一个 WorldState 并给出待分解的高层任务请求。

import { WorldState } from './state.mjs';

export const ROLE_CAPS = {
  engineer: ['travel', 'carry', 'assemble', 'mount', 'electrical', 'calibrate', 'repair', 'inspect'],
  worker: ['travel', 'carry', 'assemble', 'inspect'],
  scout: ['travel', 'carry', 'scout', 'drone', 'inspect'],
  medic: ['travel', 'carry', 'inspect'],
};

const BASE = { x: -18, y: 0, z: -12 };
const SITE_A = { x: 14, y: 0, z: 10 };
const SITE_B = { x: -14, y: 0, z: 12 };

function baseWorld() {
  const s = new WorldState();
  s.addLocation('base', '营地', BASE, 'base');
  s.addLocation('siteA', 'A号观测点', SITE_A, 'site');
  s.addLocation('siteB', 'B号观测点', SITE_B, 'site');
  return s;
}

function addMember(s, id, name, role, locId = 'base') {
  s.addMember({ id, name, role, locId, capabilities: ROLE_CAPS[role] });
}

function standardStock(s) {
  s.addItem({ id: 'mast', name: '观测杆', kind: 'mast', locId: 'base' });
  s.addItem({ id: 'sensor', name: '观测仪', kind: 'sensor', locId: 'base' });
  s.addItem({ id: 'battery', name: '电源箱', kind: 'power', locId: 'base' });
}

function sharedInfra(s) {
  // 工地作业台（安装动作的受限资源）与共享航测仪（两任务争用）
  s.addDevice({ id: 'benchA', name: 'A点作业台', locId: 'siteA', requires: [] });
  s.addDevice({ id: 'drone1', name: '航测仪D-1', locId: 'base', requires: ['drone'] });
}

export const SCENARIOS = {
  // S1 标准四人全编制、部件齐全
  standard: {
    name: 'S1 标准编队 · 部件齐全',
    desc: '工程师+技工+侦察员+医疗员，全部部件在营地，布置 A 号观测点。',
    build() {
      const s = baseWorld();
      addMember(s, 'eng', '林工', 'engineer');
      addMember(s, 'wrk', '石磊', 'worker');
      addMember(s, 'sct', '高察', 'scout');
      addMember(s, 'med', '苏医', 'medic');
      standardStock(s);
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
    ],
  },

  // S2 精简编队 + 缺少观测仪/电源箱：标准方案不适用，只能用轻量化方案
  lightTeam: {
    name: 'S2 精简编队 · 缺少部件',
    desc: '只有侦察员与技工，且观测仪、电源箱未运抵；核对方案适用性后改走轻量化布置。',
    build() {
      const s = baseWorld();
      addMember(s, 'wrk', '石磊', 'worker');
      addMember(s, 'sct', '高察', 'scout');
      s.addItem({ id: 'mast', name: '观测杆', kind: 'mast', locId: 'base' });
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
    ],
  },

  // S3 有工程师但缺电源箱：标准方案因条件不满足被拒，运行中可补送部件后重新分解
  missingPower: {
    name: 'S3 缺电源箱 · 方案动态切换',
    desc: '工程师与技工在场，但电源箱缺失；先按可行方案分解，补送部件后可重新分解为标准方案。',
    build() {
      const s = baseWorld();
      addMember(s, 'eng', '林工', 'engineer');
      addMember(s, 'wrk', '石磊', 'worker');
      s.addItem({ id: 'mast', name: '观测杆', kind: 'mast', locId: 'base' });
      s.addItem({ id: 'sensor', name: '观测仪', kind: 'sensor', locId: 'base' });
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
    ],
  },

  // S4 途中退出：工程师在前往观测点途中退出，演示局部换人 / 回溯祖先方法两种办法
  withdraw: {
    name: 'S4 队员途中退出',
    desc: '主工程师携部件前往观测点途中退出；副工程师可局部换人保持标准方案，也可强制回溯到上层方法重新分工。',
    build() {
      const s = baseWorld();
      addMember(s, 'eng', '林工', 'engineer');
      addMember(s, 'eng2', '郑工', 'engineer');
      addMember(s, 'wrk', '石磊', 'worker');
      addMember(s, 'sct', '高察', 'scout');
      addMember(s, 'med', '苏医', 'medic');
      standardStock(s);
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
    ],
    withdrawAt: { memberId: 'eng', afterTick: 2 },
  },

  // S6 唯一工程师退出且无人具备电气/标定能力：局部换人不可行，必须自动升级祖先回退
  noSubstitute: {
    name: 'S6 无替补能力 · 自动祖先回退',
    desc: '只有一名工程师，他在搬运电源箱途中退出；局部换人无法保持后段电气能力，运行时自动回溯到轻量化方案。',
    build() {
      const s = baseWorld();
      addMember(s, 'eng', '林工', 'engineer');
      addMember(s, 'wrk', '石磊', 'worker');
      addMember(s, 'sct', '高察', 'scout');
      standardStock(s);
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
    ],
    withdrawAt: { memberId: 'eng', afterTick: 2 },
  },

  // S5 两任务共享航测仪：资源冲突串行化；设备故障时先失败方阻止后续争用动作
  sharedDevice: {
    name: 'S5 两任务共享航测仪',
    desc: '布置观测点（标定需航测仪做基准）与路线踏勘同时下达，航测仪只有一台。',
    build() {
      const s = baseWorld();
      addMember(s, 'eng', '林工', 'engineer');
      addMember(s, 'wrk', '石磊', 'worker');
      addMember(s, 'sct', '高察', 'scout');
      addMember(s, 'med', '苏医', 'medic');
      standardStock(s);
      sharedInfra(s);
      return s;
    },
    tasks: [
      { id: 't1', task: 'deployObservation', ctx: { siteId: 'siteA' } },
      { id: 't2', task: 'surveyRoute', ctx: { routeId: 'routeN', routeName: '北翼路线', locId: 'base' } },
    ],
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);
