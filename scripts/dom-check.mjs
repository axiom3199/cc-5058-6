// 无浏览器环境下的界面逻辑验证：用最小 DOM 桩加载真实 web/app.mjs，
// 驱动其控件事件并核对引擎联动（WebGL 画面需在真实浏览器中查看）。
import { readFile } from 'node:fs/promises';

class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.style = {};
    this.listeners = {}; this.className = ''; this.value = ''; this._html = '';
    this.classList = {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { c.parentNode = this; this.children.unshift(c); }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    }
  }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  dispatch(t) { (this.listeners[t] ?? []).forEach((fn) => fn({ target: this })); }
  click() { this.dispatch('click'); }
  change() { this.dispatch('change'); }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text ?? this._html.replace(/<[^>]+>/g, ' '); }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() {
    return this.children.length
      ? this.children.map((c) => c.innerHTML).join('')
      : this._html;
  }
  get lastChild() { return this.children[this.children.length - 1]; }
  get selectedOptions() { return [{ textContent: '' }]; }
}

const ids = ['view', 'scenarioSelect', 'recoveryMode', 'cacheMode', 'btnPlan', 'btnStep', 'btnAuto',
  'btnReset', 'btnWithdraw', 'btnBreakDrone', 'btnDeliverBattery', 'btnReplan',
  'banner', 'conditions', 'trace', 'tree', 'results', 'events', 'optStats'];
const els = Object.fromEntries(ids.map((id) => [id, new El()]));
els.view.clientWidth = 800; els.view.clientHeight = 600;
// 桩不解析静态 HTML 的 <option>，手动给出与 index.html 首项一致的默认值
els.cacheMode.value = 'proof';
els.recoveryMode.value = 'substitute';

global.document = {
  querySelector: (s) => els[s.slice(1)] ?? new El(),
  createElement: () => {
    const c = new El();
    c.style = {};
    c.getContext = () => ({ fillRect() {}, fillText() {}, roundRect() {}, fill() {} });
    return c;
  },
};
global.window = { addEventListener() {}, devicePixelRatio: 1 };
global.devicePixelRatio = 1;
global.performance = { now: () => Date.now() };
// 桩：rAF 在真实浏览器是异步宏任务；这里丢弃回调，避免同步无限递归（图形渲染不在本测试范围）
global.requestAnimationFrame = () => 0;
global.setInterval = () => 0;
global.clearInterval = () => {};

// ---- three.js 最小桩，使 Scene3D 可在 Node 中实例化 ----
const V = class {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new V(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  distanceTo() { return 99; }
  lerpVectors(a, b) { this.copy(b); return this; }
  setY(y) { this.y = y; return this; }
};
const mat = () => ({ color: { set() {}, getHex: () => 0 }, emissive: { set() {} } });
const threeStub = {
  Scene: class { constructor() { this.children = []; this.background = null; this.fog = null; } add() {} remove() {} },
  Color: class {}, Fog: class {}, HemisphereLight: class {},
  DirectionalLight: class { position = { set() {} }; shadowMap = {}; shadow = { mapSize: { set() {} } }; castShadow = false; },
  PerspectiveCamera: class { position = new V(); aspect = 0; updateProjectionMatrix() {} },
  WebGLRenderer: class { setSize() {} setPixelRatio() {} render() {} shadowMap = {}; domElement = new El('canvas'); },
  Mesh: class { constructor() { this.position = new V(); this.rotation = { x: 0, y: 0, z: 0 }; this.material = mat(); this.scale = { y: 1 }; this.castShadow = false; this.receiveShadow = false; } },
  PlaneGeometry: class {}, CylinderGeometry: class {}, GridHelper: class { constructor() { this.position = new V(); } },
  CapsuleGeometry: class {}, SphereGeometry: class {}, BoxGeometry: class {}, ConeGeometry: class {},
  Group: class { constructor() { this.position = new V(); this.rotation = { x: 0 }; this.children = []; this.visible = true; } add() {} },
  MeshStandardMaterial: class { constructor(o) { Object.assign(this, o); this.color = { set() {}, getHex: () => 0 }; this.emissive = { set() {} }; } },
  CanvasTexture: class {},
  Sprite: class { constructor() { this.position = new V(); this.scale = { set() {} }; } },
  SpriteMaterial: class {}, Vector3: V, Clock: class { getDelta() { return 0.016; } },
};
globalThis.__three = threeStub;

const loadAsData = async (path, transform) => {
  const code = await readFile(new URL(path, import.meta.url), 'utf8');
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(transform(code)));
};

const { Scene3D } = await loadAsData('../web/scene3d.mjs', (code) => {
  const names = Object.keys(threeStub).join(',');
  return code
    .replace("import * as THREE from './three.module.js';", '')
    .replace("import { OrbitControls } from './OrbitControls.js';", '')
    .replace(/THREE\.(\w+)/g, '$1')
    .replace('export class Scene3D',
      `class OrbitControls { constructor() { this.target = { set() {} }; this.enableDamping = false; } update() {} }\nconst { ${names} } = globalThis.__three;\nexport class Scene3D`);
});
globalThis.__sceneMod = { Scene3D };

const rootUrl = new URL('../', import.meta.url).href;
const mod = await loadAsData('../web/app.mjs', (code) =>
  code
    .replace("import { Scene3D } from './scene3d.mjs';",
      'const { Scene3D } = globalThis.__sceneMod;')
    .replaceAll("from '../src/", `from '${rootUrl}src/`));

const app = new mod.App();
const checks = [];
const expect = (name, cond) => checks.push([name, !!cond]);
const eventText = () => els.events.children.map((c) => c.innerHTML).join(' ');

expect('初始加载即产生分解树', els.tree.innerHTML.includes('node'));
expect('方法适用性核对已渲染', els.trace.innerHTML.includes('适用'));
expect('结果区渲染世界条件', els.results.innerHTML.includes('built'));

const tick0 = app.state.tick;
els.btnStep.click();
expect('单步推进时钟递增', app.state.tick === tick0 + 1);

let guard = 0;
while (!app.rt.finished && guard++ < 100) els.btnStep.click();
expect('S1 跑完', app.rt.finished);
expect('S1 观测站世界条件满足', app.state.stationReady('siteA'));
expect('S1 验收事实成立', app.state.fact('verified:siteA'));
expect('成功横幅提示', els.banner.textContent.includes('世界条件确认'));

els.scenarioSelect.value = 'lightTeam'; els.scenarioSelect.change();
expect('S2 显示方法排除', els.trace.innerHTML.includes('排除'));
expect('S2 选中轻量化方案', app.rt.roots[0].methodId === 'deploy.light');

els.scenarioSelect.value = 'missingPower'; els.scenarioSelect.change();
expect('S3 初始为轻量方案', app.rt.roots[0].methodId === 'deploy.light');
els.btnDeliverBattery.click();
els.btnReplan.click();
expect('S3 补送后重新分解为标准方案', app.rt.roots[0].methodId === 'deploy.standard');

els.scenarioSelect.value = 'withdraw'; els.scenarioSelect.change();
els.recoveryMode.value = 'substitute'; els.recoveryMode.change();
for (let i = 0; i < 30 && !app.rt.finished; i++) els.btnStep.click();
expect('S4 界面事件含 substitute', eventText().includes('substitute'));
expect('S4 任务最终成功', app.rt.roots[0].closed === 'succeeded');

els.scenarioSelect.value = 'sharedDevice'; els.scenarioSelect.change();
for (let i = 0; i < 4; i++) els.btnStep.click();
els.btnBreakDrone.click();
expect('S5 故障横幅提示', els.banner.textContent.includes('航测仪'));
expect('S5 出现失败/阻止事件', eventText().includes('leaf-failed') || eventText().includes('blocked'));

// 分解搜索优化控件：切换模式后重新分解，指标区由内核真实统计驱动
expect('优化指标区渲染完整展开数', els.optStats.innerHTML.includes('完整展开'));
els.cacheMode.value = 'off'; els.cacheMode.change();
expect('切换 off 模式后仍产生分解树', els.tree.innerHTML.includes('node'));
expect('off 模式指标显示当前模式', els.optStats.innerHTML.includes('off'));
els.cacheMode.value = 'nogood'; els.cacheMode.change();
expect('切换 nogood 模式后分解树正常', els.tree.innerHTML.includes('node'));
els.cacheMode.value = 'proof'; els.cacheMode.change();
els.btnPlan.click();
expect('proof 模式指标含命中/展开计数', /证明命中|完整展开/.test(els.optStats.innerHTML));
// 条件更改后重新分解：世界事实变化驱动缓存失效/重核，界面不伪报
els.btnDeliverBattery.click();
els.btnReplan.click();
expect('条件更改后重新分解成功', els.tree.innerHTML.includes('node'));

let fail = 0;
for (const [n, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
