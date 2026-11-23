// 世界状态：考察队、物资、共享设备、地点、观测站与事实谓词。
// 规划器与执行器都只通过这里的查询/变更接口读写，动作的“完成”由状态谓词确认。

export class WorldState {
  constructor() {
    this.tick = 0;
    this.locations = new Map(); // id -> {id,name,pos:{x,y,z},kind}
    this.members = new Map();   // id -> {id,name,role,capabilities:Set,locId,status,carrying}
    this.items = new Map();     // id -> {id,name,kind,locId,holderId,assembled,mounted}
    this.devices = new Map();   // id -> {id,name,requires:Set,busy,pos/locId}
    this.stations = new Map();  // id -> {id,siteId,built,mounted,powered,calibrated}
    this.facts = new Set();     // 任意谓词字符串
    this.log = [];
  }

  clone() {
    const s = new WorldState();
    s.tick = this.tick;
    for (const [k, v] of this.locations) s.locations.set(k, structuredClone(v));
    for (const [k, v] of this.members) s.members.set(k, structuredClone({ ...v, capabilities: [...v.capabilities] }));
    for (const [k, v] of this.items) s.items.set(k, structuredClone(v));
    for (const [k, v] of this.devices) s.devices.set(k, structuredClone({ ...v, requires: [...v.requires] }));
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
    }
  }

  // ---- 物资 ----
  addItem(it) {
    this.items.set(it.id, {
      assembled: false, mounted: false, holderId: null, ...it,
    });
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
  }
  device(id) { return this.devices.get(id); }

  // ---- 观测站 ----
  stationAt(siteId) { return [...this.stations.values()].find((s) => s.siteId === siteId); }
  stationReady(siteId) {
    const s = this.stationAt(siteId);
    return !!s && s.built && s.mounted && s.powered && s.calibrated;
  }

  // ---- 事实谓词 ----
  fact(p) { return this.facts.has(p); }
  setFact(p) { this.facts.add(p); }

  // 供界面与 CLI 序列化
  snapshot() {
    return {
      tick: this.tick,
      locations: [...this.locations.values()],
      members: [...this.members.values()].map((m) => ({ ...m, capabilities: [...m.capabilities] })),
      items: [...this.items.values()],
      devices: [...this.devices.values()].map((d) => ({ ...d, requires: [...d.requires] })),
      stations: [...this.stations.values()],
      facts: [...this.facts],
      log: this.log.slice(-40),
    };
  }
}
