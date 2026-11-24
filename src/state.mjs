// 世界状态：考察队、物资、共享设备、地点、观测站与事实谓词。
// 规划器与执行器都只通过这里的查询/变更接口读写，动作的“完成”由状态谓词确认。

export class WorldState {
  constructor() {
    this.tick = 0;
    // 世界版本号：任何会改变前提真值的世界变更都调用 touch() 递增。
    // 带证明缓存只在版本未变时直接信任观察快照；版本变化必须重核前提，不能把未观察条件当确定。
    this.revision = 0;
    this.locations = new Map(); // id -> {id,name,pos:{x,y,z},kind}
    this.members = new Map();   // id -> {id,name,role,capabilities:Set,locId,status,carrying}
    this.items = new Map();     // id -> {id,name,kind,locId,holderId,assembled,mounted}
    this.devices = new Map();   // id -> {id,name,requires:Set,busy,pos/locId}
    this.vehicles = new Map();  // id -> {id,name,seats:number}（载具席位表）
    this.stations = new Map();  // id -> {id,siteId,built,mounted,powered,calibrated}
    this.facts = new Set();     // 任意谓词字符串
    this.log = [];
  }

  // 世界事实变更入口：递增版本号，供缓存失效判定（“世界事实改变后及时失效”）
  touch() { this.revision += 1; }

  clone() {
    const s = new WorldState();
    s.tick = this.tick;
    s.revision = this.revision;
    for (const [k, v] of this.locations) s.locations.set(k, structuredClone(v));
    for (const [k, v] of this.members) s.members.set(k, structuredClone({ ...v, capabilities: [...v.capabilities] }));
    for (const [k, v] of this.items) s.items.set(k, structuredClone(v));
    for (const [k, v] of this.devices) s.devices.set(k, structuredClone({ ...v, requires: [...v.requires] }));
    for (const [k, v] of this.vehicles) s.vehicles.set(k, structuredClone(v));
    for (const [k, v] of this.stations) s.stations.set(k, structuredClone(v));
    s.facts = new Set(this.facts);
    s.log = [...this.log];
    // 克隆后恢复 Set
    for (const m of s.members.values()) m.capabilities = new Set(m.capabilities);
    for (const d of s.devices.values()) d.requires = new Set(d.requires);
    return s;
  }

  record(msg) { this.log.push(`t${this.tick} ${msg}`); }

  // ---- 地点 ----
  addLocation(id, name, pos, kind = 'site') {
    this.locations.set(id, { id, name, pos, kind });
  }
  loc(id) { return this.locations.get(id); }

  // ---- 队员 ----
  addMember(m) {
    const { capabilities, ...rest } = m;
    this.members.set(m.id, {
      status: 'active', carrying: null, locId: m.locId,
      ...rest,
      capabilities: new Set(capabilities),
    });
    this.touch(); // 队员/能力集合是方法适用性前提
  }
  member(id) { return this.members.get(id); }
  activeMembers() { return [...this.members.values()].filter((m) => m.status === 'active'); }
  hasCap(memberId, cap) {
    const m = this.members.get(memberId);
    return !!m && m.status === 'active' && m.capabilities.has(cap);
  }
  withdraw(id) {
    const m = this.members.get(id);
    if (m) {
      m.status = 'withdrawn';
      if (m.carrying) {
        const it = this.items.get(m.carrying);
        if (it) { it.holderId = null; it.locId = m.locId; }
        m.carrying = null;
      }
      this.touch(); // 在岗队员与持物关系变化：能力前提可能失效
    }
  }

  // ---- 物资 ----
  addItem(it) {
    this.items.set(it.id, {
      assembled: false, mounted: false, holderId: null, ...it,
    });
    this.touch(); // 部件在场与否是方法适用性前提
  }
  item(id) { return this.items.get(id); }
  itemLoc(id) {
    const it = this.items.get(id);
    if (!it) return null;
    if (it.holderId) return { type: 'holder', id: it.holderId };
    return { type: 'loc', id: it.locId };
  }
  freeHands(memberId) {
    const m = this.members.get(memberId);
    return m && m.status === 'active' && m.carrying === null;
  }

  // ---- 共享设备 ----
  addDevice(d) {
    this.devices.set(d.id, { busy: false, requires: new Set(), ...d, requires: new Set(d.requires ?? []) });
    this.touch();
  }
  device(id) { return this.devices.get(id); }

  // ---- 载具席位表（两名队员合用一辆车：席位容量有限，分解时需预订） ----
  addVehicle(v) {
    this.vehicles.set(v.id, { seats: 2, ...v });
    this.touch();
  }
  vehicle(id) { return this.vehicles.get(id); }

  // ---- 观测站 ----
  stationAt(siteId) { return [...this.stations.values()].find((s) => s.siteId === siteId); }
  stationReady(siteId) {
    const s = this.stationAt(siteId);
    return !!s && s.built && s.mounted && s.powered && s.calibrated;
  }

  // ---- 事实谓词 ----
  fact(p) { return this.facts.has(p); }
  setFact(p) {
    if (!this.facts.has(p)) { this.facts.add(p); this.touch(); }
  }
  removeFact(p) {
    if (this.facts.delete(p)) this.touch();
  }

  // 供界面与 CLI 序列化
  snapshot() {
    return {
      tick: this.tick,
      revision: this.revision,
      locations: [...this.locations.values()],
      members: [...this.members.values()].map((m) => ({ ...m, capabilities: [...m.capabilities] })),
      items: [...this.items.values()],
      devices: [...this.devices.values()].map((d) => ({ ...d, requires: [...d.requires] })),
      vehicles: [...this.vehicles.values()],
      stations: [...this.stations.values()],
      facts: [...this.facts],
      log: this.log.slice(-40),
    };
  }
}
