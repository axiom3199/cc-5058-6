// Three.js 三维场景：渲染地形、地点、队员、物资、共享设备与观测站，
// 并依据世界状态每帧插值播放队员移动与搬运动作。仅负责呈现，不参与任务运算。
import * as THREE from './three.module.js';
import { OrbitControls } from './OrbitControls.js';

const ROLE_COLORS = { engineer: 0xd94848, worker: 0x4f86d9, scout: 0x4fb06a, medic: 0xf0f0f0 };

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101826);
    this.scene.fog = new THREE.Fog(0x101826, 45, 95);

    const w = container.clientWidth, h = container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 300);
    this.camera.position.set(26, 30, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x223044, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(20, 34, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(hemi, sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 70),
      new THREE.MeshStandardMaterial({ color: 0x1c2b3d, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(90, 45, 0x2f4a66, 0x22364b);
    grid.position.y = 0.01;
    this.scene.add(grid);

    this.markers = new Map(); // location/device/item/member id -> {group, from, to, t}
    this.anim = new Map();
    this._raf = null;
    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _label(text, color = '#e8eef7') {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(12,20,32,0.78)';
    g.roundRect(4, 8, 248, 48, 10); g.fill();
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(4.4, 1.1, 1);
    return sp;
  }

  initLocations(locations) {
    for (const loc of locations) {
      const grp = new THREE.Group();
      grp.position.set(loc.pos.x, 0, loc.pos.z);
      const isBase = loc.kind === 'base';
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 2.4, 0.18, 24),
        new THREE.MeshStandardMaterial({ color: isBase ? 0x8a6d3b : 0x35506e, emissive: isBase ? 0x3a2c10 : 0x0d1c2e }));
      ring.position.y = 0.09;
      ring.receiveShadow = true;
      grp.add(ring);
      const label = this._label(loc.name, isBase ? '#ffd98a' : '#9ecbff');
      label.position.y = 3.4;
      grp.add(label);
      this.scene.add(grp);
      this.markers.set(`loc:${loc.id}`, { group: grp, pos: new THREE.Vector3(loc.pos.x, 0, loc.pos.z) });
    }
  }

  _v(pos) { return new THREE.Vector3(pos.x, pos.y ?? 0, pos.z); }

  initMembers(members, locations) {
    for (const m of members) {
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: ROLE_COLORS[m.role] ?? 0x999999, roughness: 0.5 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.0, 6, 14), mat);
      body.position.y = 0.95; body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0xffe0bd }));
      head.position.y = 1.85; head.castShadow = true;
      grp.add(body, head);
      const label = this._label(m.name);
      label.position.y = 2.7;
      grp.add(label);
      const loc = locations.find((l) => l.id === m.locId);
      grp.position.copy(this._v(loc?.pos ?? { x: 0, y: 0, z: 0 }));
      grp.visible = m.status === 'active';
      this.scene.add(grp);
      this.markers.set(`member:${m.id}`, { group: grp, body, head, label, locId: m.locId });
    }
  }

  initItems(items, locations) {
    const colors = { mast: 0xc98f4e, sensor: 0x67d0e8, power: 0xf2c14e };
    for (const it of items) {
      const grp = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshStandardMaterial({ color: colors[it.kind] ?? 0xaaaaaa, roughness: 0.6 }));
      box.castShadow = true; box.position.y = 0.45;
      grp.add(box);
      const label = this._label(it.name, '#d8f1ff');
      label.position.y = 1.7; label.scale.set(3.2, 0.8, 1);
      grp.add(label);
      const loc = locations.find((l) => l.id === it.locId);
      grp.position.copy(this._v(loc?.pos ?? { x: 0, y: 0, z: 0 }));
      this.scene.add(grp);
      this.markers.set(`item:${it.id}`, { group: grp, box, label, baseY: 0 });
    }
  }

  initDevices(devices, locations) {
    for (const d of devices) {
      const grp = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.2, 4),
        new THREE.MeshStandardMaterial({ color: 0xb07cf0, emissive: 0x2a1640, roughness: 0.4 }));
      mesh.position.y = 0.7; mesh.castShadow = true;
      grp.add(mesh);
      const label = this._label(d.name, '#e0ccff');
      label.position.y = 2; label.scale.set(3.6, 0.9, 1);
      grp.add(label);
      const loc = locations.find((l) => l.id === d.locId);
      grp.position.copy(this._v(loc?.pos ?? { x: 4, y: 0, z: 4 }));
      this.scene.add(grp);
      this.markers.set(`device:${d.id}`, { group: grp, mesh, label });
    }
  }

  _worldPos(state, ref) {
    if (ref.type === 'loc') {
      const loc = this.markers.get(`loc:${ref.id}`);
      return loc ? loc.pos.clone() : new THREE.Vector3();
    }
    const holder = this.markers.get(`member:${ref.id}`);
    return holder ? holder.group.position.clone().setY(1.4) : new THREE.Vector3();
  }

  // 依据最新世界快照增量更新；移动用插值动画呈现
  sync(snap) {
    for (const m of snap.members) {
      const mk = this.markers.get(`member:${m.id}`);
      if (!mk) continue;
      mk.group.visible = m.status === 'active';
      const loc = snap.locations.find((l) => l.id === m.locId);
      if (!loc) continue;
      const target = this._v(loc.pos);
      if (mk.group.position.distanceTo(target) > 0.6) {
        this.anim.set(`member:${m.id}`, { from: mk.group.position.clone(), to: target.clone(), t: 0, dur: 0.9 });
      } else {
        mk.group.position.copy(target);
      }
    }
    for (const it of snap.items) {
      const mk = this.markers.get(`item:${it.id}`);
      if (!mk) continue;
      const ref = it.holderId ? { type: 'holder', id: it.holderId } : { type: 'loc', id: it.locId };
      const target = this._worldPos(snap, ref);
      if (it.holderId) target.y = 1.5;
      if (mk.group.position.distanceTo(target) > 0.4) {
        this.anim.set(`item:${it.id}`, { from: mk.group.position.clone(), to: target.clone(), t: 0, dur: 0.7 });
      } else {
        mk.group.position.copy(target);
      }
      mk.box.material.color.set(it.mounted ? 0x7be08a : it.assembled ? 0x9fd8ff : mk.box.material.color.getHex());
      mk.box.scale.y = it.mounted ? 2.2 : 1;
    }
    for (const d of snap.devices) {
      const mk = this.markers.get(`device:${d.id}`);
      if (!mk) continue;
      mk.mesh.material.emissive.set(d.broken ? 0x551111 : d.busy ? 0x4a2d78 : 0x2a1640);
    }
    // 观测站建成后在对应地点竖起桅杆模型
    for (const st of snap.stations) {
      const key = `station:${st.siteId}`;
      if (!this.markers.has(key)) {
        const loc = this.markers.get(`loc:${st.siteId}`);
        const pole = new THREE.Group();
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.2, 10),
          new THREE.MeshStandardMaterial({ color: 0xd7dde6, metalness: 0.4, roughness: 0.4 }));
        mast.position.y = 2.1; mast.castShadow = true;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0x67d0e8, emissive: 0x0c3340 }));
        tip.position.y = 4.4;
        pole.add(mast, tip);
        pole.position.copy(loc.pos);
        this.scene.add(pole);
        this.markers.set(key, { group: pole, tip });
      }
      const mk = this.markers.get(key);
      mk.tip.material.emissive.set(st.calibrated ? 0x1e7a44 : 0x402020);
    }
  }

  _loop() {
    const clock = new THREE.Clock();
    const step = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      for (const [key, a] of this.anim) {
        a.t += dt / a.dur;
        const k = Math.min(a.t, 1);
        const eased = k * k * (3 - 2 * k);
        const mk = this.markers.get(key);
        if (mk) mk.group.position.lerpVectors(a.from, a.to, eased);
        if (k >= 1) this.anim.delete(key);
      }
      // 队员轻微起伏，呈现“工作中”
      const time = performance.now() * 0.004;
      for (const [key, mk] of this.markers) {
        if (key.startsWith('member:')) {
          const moving = this.anim.has(key);
          mk.body.position.y = 0.95 + (moving ? Math.abs(Math.sin(time)) * 0.12 : 0);
        }
        if (key.startsWith('device:')) mk.mesh.rotation.y += dt * 0.8;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(step);
    };
    step();
  }
}
