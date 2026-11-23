// 考察任务图形界面控制器：所有任务分解与执行均调用 src 下的真实引擎运算，
// 界面只负责推进、展示与异常提示。
import { SCENARIOS, SCENARIO_IDS } from '../src/scenarios.mjs';
import { plan } from '../src/planner.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Scene3D } from './scene3d.mjs';

const $ = (sel) => document.querySelector(sel);
const STATUS_STYLE = {
  ready: '待执行', running: '执行中', done: '已完成',
  failed: '失败', blocked: '已阻止', skipped: '已跳过',
};

export class App {
  constructor() {
    this.scene3d = new Scene3D($('#view'));
    this.rt = null;
    this.state = null;
    this.timer = null;
    this.bind();
    this.loadScenario(SCENARIO_IDS[0]);
  }

  bind() {
    const sel = $('#scenarioSelect');
    for (const id of SCENARIO_IDS) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = SCENARIOS[id].name;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => this.loadScenario(sel.value));
    $('#btnPlan').addEventListener('click', () => this.loadScenario(sel.value));
    $('#btnStep').addEventListener('click', () => this.step());
    $('#btnAuto').addEventListener('click', () => this.toggleAuto());
    $('#btnReset').addEventListener('click', () => this.loadScenario(sel.value));
    $('#btnWithdraw').addEventListener('click', () => this.injectWithdraw());
    $('#btnBreakDrone').addEventListener('click', () => this.injectBrokenDrone());
    $('#btnDeliverBattery').addEventListener('click', () => this.deliverBattery());
    $('#btnReplan').addEventListener('click', () => this.replanCurrent());
    $('#recoveryMode').addEventListener('change', () => {
      if (this.rt) this.rt.recovery = $('#recoveryMode').value;
    });
  }

  loadScenario(id) {
    clearInterval(this.timer); this.timer = null;
    $('#btnAuto').textContent = '自动推进';
    const sc = SCENARIOS[id];
    this.scenarioId = id;
    this.state = sc.build();
    this.requests = sc.tasks.map((t) => ({ ...t }));
    const planned = plan(this.state, this.requests);
    this.planTrace = planned.trace;
    if (!planned.ok) {
      this.showBanner('error', `分解失败：${planned.reason}`);
      this.rt = null;
      this.renderAll();
      return;
    }
    this.rt = new Runtime(this.state, planned, { recovery: $('#recoveryMode').value });
    this.hideBanner();
    this.init3d();
    this.renderAll();
    this.logEvent({ tick: 0, type: 'plan', message: `已选择「${sc.name}」，分解完成，等待推进` });
  }

  init3d() {
    this.scene3d.markers.forEach((_, k) => {
      if (k.startsWith('station:') || k.startsWith('member:') || k.startsWith('item:') || k.startsWith('device:')) {
        const mk = this.scene3d.markers.get(k);
        this.scene3d.scene.remove(mk.group);
        this.scene3d.markers.delete(k);
      }
    });
    this.scene3d.anim.clear();
    const locs = [...this.state.locations.values()];
    this.scene3d.initLocations(locs);
    this.scene3d.initMembers([...this.state.members.values()], locs);
    this.scene3d.initItems([...this.state.items.values()], locs);
    this.scene3d.initDevices([...this.state.devices.values()], locs);
    this.scene3d.sync(this.state.snapshot());
  }

  step() {
    if (!this.rt || this.rt.finished) return;
    this.rt.tick();
    // 场景预设的途中退出事件
    const w = SCENARIOS[this.scenarioId].withdrawAt;
    if (w && this.state.tick === w.afterTick && this.state.member(w.memberId)?.status === 'active') {
      this.rt.withdraw(w.memberId);
    }
    this.afterTick();
  }

  toggleAuto() {
    if (this.timer) {
      clearInterval(this.timer); this.timer = null;
      $('#btnAuto').textContent = '自动推进';
    } else {
      this.timer = setInterval(() => {
        if (this.rt?.finished) return this.toggleAuto();
        this.step();
      }, 700);
      $('#btnAuto').textContent = '暂停';
    }
  }

  afterTick() {
    this.scene3d.sync(this.state.snapshot());
    this.renderAll();
    for (const e of this.rt.events.splice(0)) this.logEvent(e);
    if (this.rt.finished) {
      clearInterval(this.timer); this.timer = null;
      $('#btnAuto').textContent = '自动推进';
      const failed = this.rt.roots.filter((r) => r.closed === 'failed');
      if (failed.length) this.showBanner('error', `任务未成功：${failed.map((r) => r.label).join('、')}（详见事件日志与分解树）`);
      else this.showBanner('ok', '全部高层任务由世界条件确认完成');
    }
  }

  // ---- 异常/条件注入（图形界面提示） ----
  injectWithdraw() {
    if (!this.rt) return;
    const active = this.state.activeMembers();
    if (!active.length) return this.showBanner('error', '已无在岗队员');
    const target = active[0];
    this.rt.withdraw(target.id);
    this.showBanner('warn', `已令 ${target.name} 退出考察队`);
    this.afterTick();
  }

  injectBrokenDrone() {
    const d = this.state.device('drone1');
    if (!d) return;
    d.broken = true;
    this.state.setFact('broken:drone1');
    const ownerUid = this.rt?.locks.get('drone1');
    if (ownerUid) {
      const leaf = this.rt.index.get(ownerUid);
      this.rt._releaseLeafRuntime(leaf);
      this.rt._failLeaf(leaf, '航测仪D-1 中途损坏');
    } else {
      // 设备空闲时损坏：所有仍需使用它的未完成动作直接失败，并级联阻止其下游
      const users = [...this.rt.index.values()]
        .filter((l) => l.resources.includes('drone1') && ['ready', 'running'].includes(l.status));
      for (const l of users) this.rt._failLeaf(l, '航测仪D-1 已损坏，该动作无法执行');
    }
    this.showBanner('error', '异常注入：航测仪D-1 损坏，占用它的动作失败并阻止后续争用动作');
    this.afterTick();
  }

  deliverBattery() {
    if (this.state.item('battery')) return this.showBanner('warn', '电源箱已在场');
    this.state.addItem({ id: 'battery', name: '电源箱', kind: 'power', locId: 'base' });
    this.scene3d.initItems([this.state.item('battery')], [...this.state.locations.values()]);
    this.showBanner('ok', '条件更改：电源箱已补送到营地，可重新分解');
    this.renderAll();
  }

  replanCurrent() {
    const planned = plan(this.state, this.requests);
    if (!planned.ok) return this.showBanner('error', `重新分解失败：${planned.reason}`);
    this.rt = new Runtime(this.state, planned, { recovery: $('#recoveryMode').value });
    this.planTrace = planned.trace;
    this.showBanner('ok', '已按当前世界状态重新分解搜索');
    this.renderAll();
  }

  // ---- 渲染 ----
  renderAll() {
    this.renderConditions();
    this.renderTree();
    this.renderTrace();
    this.renderResults();
  }

  renderConditions() {
    const mem = [...this.state.members.values()].map((m) =>
      `<span class="chip ${m.status === 'active' ? 'ok' : 'off'}">${m.name}·${this.roleName(m.role)}${m.status === 'withdrawn' ? '·已退出' : ''}</span>`).join('');
    const items = [...this.state.items.values()].map((i) =>
      `<span class="chip">${i.name}${i.assembled ? '·已组装' : ''}${i.mounted ? '·已安装' : ''}</span>`).join('');
    const dev = [...this.state.devices.values()].map((d) =>
      `<span class="chip ${d.broken ? 'off' : d.busy ? 'warn' : ''}">${d.name}${d.broken ? '·损坏' : d.busy ? '·占用中' : '·空闲'}</span>`).join('');
    $('#conditions').innerHTML =
      `<div><b>队员（能力核对）</b><div>${mem}</div></div>
       <div><b>物资状态</b><div>${items || '<span class="muted">无</span>'}</div></div>
       <div><b>共享设备</b><div>${dev}</div></div>
       <div class="muted">时钟 t${this.state.tick} · 恢复策略：${$('#recoveryMode').selectedOptions[0]?.textContent ?? ''}</div>`;
  }

  roleName(r) {
    return { engineer: '工程师', worker: '技工', scout: '侦察员', medic: '医疗员' }[r] ?? r;
  }

  renderTrace() {
    $('#trace').innerHTML = this.planTrace.map((t) => `
      <div class="trace-block">
        <div class="trace-title">${t.label}</div>
        ${t.checks.map((c) => `
          <div class="trace-check ${c.applicable ? 'yes' : 'no'}">
            <span>${c.applicable ? '✓ 适用' : '✗ 排除'}</span> ${c.label}
          </div>`).join('')}
      </div>`).join('');
  }

  renderTree() {
    if (!this.rt) { $('#tree').innerHTML = '<div class="muted">无可行分解</div>'; return; }
    const view = this.rt.treeView();
    $('#tree').innerHTML = view.map((n) => this.nodeHtml(n, 0)).join('');
  }

  nodeHtml(n, depth) {
    const status = n.closed === 'succeeded' ? 'node-ok' : n.closed === 'failed' ? 'node-fail' : '';
    const sub = n.subCompounds.map((c) => this.nodeHtml(c, depth + 1)).join('');
    const leaves = n.leaves.map((l) => this.leafHtml(l)).join('');
    return `<details ${depth === 0 ? 'open' : ''} class="node ${status}" style="margin-left:${depth * 14}px">
      <summary>
        <b>${n.label}</b>
        <span class="method">方案：${n.methodLabel}</span>
        <span class="tag">${n.closed === 'succeeded' ? '世界条件已确认' : n.closed === 'failed' ? '未成功' : '执行中'}</span>
      </summary>
      <div class="node-source">
        任务来源：高层任务「${n.label}」→ 方法适用性核对 → 选中「${n.methodLabel}」
        <div class="deps">叶子依赖与资源在节点内显式声明，调度不依赖书写顺序</div>
      </div>
      ${sub}${leaves}
    </details>`;
  }

  leafHtml(l) {
    const member = this.state.member(l.assignee);
    const depNames = l.dependsOn.map((d) => this.rt.index.get(d)?.localId ?? d).join(', ');
    const pct = l.total ? Math.round((l.progress / l.total) * 100) : 0;
    return `<div class="leaf leaf-${l.status}" style="margin-left:14px">
      <div class="leaf-head">
        <span class="status status-${l.status}">${STATUS_STYLE[l.status]}</span>
        <span class="leaf-label">${l.label}</span>
        <span class="leaf-who">${member?.name ?? '—'}</span>
      </div>
      <div class="leaf-meta">
        能力需求 [${l.needs.join('+')}] ·
        依赖 [${depNames || '无'}] ·
        资源 [${l.resources.join(',') || '无'}]
        ${l.failure ? `· <b class="fail-text">${l.failure}</b>` : ''}
      </div>
      ${l.status === 'running' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    </div>`;
  }

  renderResults() {
    const snap = this.state.snapshot();
    const stations = snap.stations.map((st) => {
      const loc = snap.locations.find((l) => l.id === st.siteId);
      const rows = [
        ['建成 built', st.built], ['安装 mounted', st.mounted],
        ['供电 powered', st.powered], ['标定 calibrated', st.calibrated],
        ['验收 verified', snap.facts.includes(`verified:${st.siteId}`)],
      ].map(([k, v]) => `<li class="${v ? 'yes' : 'no'}">${k}：${v ? '真' : '假'}</li>`).join('');
      return `<div class="station"><b>${loc?.name}</b><ul>${rows}</ul></div>`;
    }).join('') || '<div class="muted">尚未建立观测站</div>';
    const facts = snap.facts.length ? [...snap.facts].map((f) => `<span class="chip">${f}</span>`).join('') : '<span class="muted">无</span>';
    $('#results').innerHTML = `${stations}<div class="facts"><b>世界事实谓词</b><div>${facts}</div></div>`;
  }

  logEvent(e) {
    const box = $('#events');
    const div = document.createElement('div');
    div.className = `event ev-${e.type}`;
    div.innerHTML = `<span class="ev-tick">t${String(e.tick).padStart(2, '0')}</span>
      <span class="ev-type">${e.type}</span><span>${e.message}</span>`;
    box.prepend(div);
    while (box.children.length > 60) box.lastChild.remove();
  }

  showBanner(kind, msg) {
    const b = $('#banner');
    b.className = `banner ${kind}`;
    b.textContent = msg; b.style.display = 'flex';
  }
  hideBanner() { $('#banner').style.display = 'none'; }
}

window.addEventListener('DOMContentLoaded', () => new App());
