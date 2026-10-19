/**
 * 工业簇（现代魔法世界的「魔法=被工业化的能源」具象化）——
 * 《现代魔法世界-终末地风格融合定稿》§3 转译表的场景层实现，从视觉样张沉淀。
 * 布局按主房间坐标系（room.ts：地板 8×6，后墙 z=-3.075，左墙 x=-4.075，台面 y=0.9）：
 *   反应釜   (0.5, -2.55)   后墙中段（壁炉与窗之间）
 *   墙面管路 y=2.3 沿后墙  釜顶立管 → 横管 → 阀门手轮 ×2 → 玻璃管液流下到台面高度
 *   立式储罐 (3.2, -1.9)   右后角（程序化，与反应釜同语言）
 *   齿轮组   后墙左侧       缓转（反向啮合）
 *   坩埚    (-2.9, -0.1)   台左侧地面，暖光锚点（fire halo + 点光）
 *   木桶    (2.15, -1.75)  台后
 * 动画全部 30fps 节流驱动（scene.render 里调 update）。
 */

import * as THREE from 'three';
import { modernMaterials, type ModernMaterials } from '../materials';
import { gaugeDialTexture, radialGlowTexture, warningStripeTexture } from '../textures';
import { applySoftParticles } from '../soft-particles';
import type { DepthPrepass } from '../depth-prepass';
import type { ParamBus } from '../shader/params';

/** 萤火微尘要不要软淡出（给了深度预 pass 才有意义） */
export interface IndustrialOptions {
  depth?: DepthPrepass | null;
  params?: ParamBus;
}

export interface IndustrialHandles {
  group: THREE.Group;
  /** 每帧推进（dt 为动画步长，t 为累计时间；flowOn=false 时停产线动画） */
  update(dt: number, t: number, flowOn: boolean): void;
}

/** 世界坐标 box-UV：平铺贴图在盒体各面上连续（样张同款） */
function worldBoxUV(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const scale = m.userData.worldUV as number | undefined;
    if (!scale) return;
    let geom = m.geometry;
    if (geom.index) { geom = geom.toNonIndexed(); m.geometry = geom; }
    const pos = geom.attributes.position;
    const nor = geom.attributes.normal;
    const uv = new Float32Array(pos.count * 2);
    const wp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      wp.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
      let u: number, v: number;
      if (nx >= ny && nx >= nz) { u = wp.z; v = wp.y; }
      else if (ny >= nz) { u = wp.x; v = wp.z; }
      else { u = wp.x; v = wp.y; }
      uv[i * 2] = u / scale;
      uv[i * 2 + 1] = v / scale;
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  });
}

function std(opt: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial(opt);
}

function shadowAll(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
}

export function buildIndustrial(
  mats: ModernMaterials = modernMaterials(),
  opts: IndustrialOptions = {},
): IndustrialHandles {
  const group = new THREE.Group();

  /* ---------- 反应釜（后墙中段） ---------- */
  const reactor = new THREE.Group();
  reactor.position.set(0.5, 0, -2.55);
  group.add(reactor);
  let sightLiquid: THREE.Mesh | null = null;
  let gaugeNeedle: THREE.Group | null = null;
  let reactorGlowLight: THREE.PointLight | null = null;
  {
    for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.34, 8), mats.iron);
      leg.position.set(x, 0.17, z);
      reactor.add(leg);
    }
    // 警戒条纹裙边（终末地标志；UI 侧同语言见 index.html）
    const stripeTex = warningStripeTexture();
    stripeTex.repeat.set(10, 1);
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.36, 0.13, 20, 1, true),
      std({ map: stripeTex, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }),
    );
    skirt.position.y = 0.4;
    reactor.add(skirt);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.82, 20), mats.brass);
    body.position.y = 0.87;
    reactor.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mats.brass);
    dome.position.y = 1.28;
    reactor.add(dome);
    // 顶部排气嘴 + 小喷口（自发光，Bloom 拾取）
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 10), mats.brassDark);
    nozzle.position.y = 1.6;
    reactor.add(nozzle);
    const nozzleTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffb46a).multiplyScalar(2.2), toneMapped: false }),
    );
    nozzleTip.position.y = 1.69;
    reactor.add(nozzleTip);
    // 侧面短管 ×2
    for (const s of [-1, 1]) {
      const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.18, 8), mats.brassDark);
      stub.rotation.z = Math.PI / 2;
      stub.position.set(s * 0.36, 0.95, 0);
      reactor.add(stub);
    }
    // 视镜（玻璃柱 + 内部液流）
    const sight = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 10), mats.glass);
    sight.position.set(0, 0.9, 0.295);
    reactor.add(sight);
    sightLiquid = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.42, 8), mats.liquid.clone());
    sightLiquid.position.set(0, 0.9, 0.295);
    reactor.add(sightLiquid);
    // 底部自发光环
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.335, 0.014, 8, 28),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc880).multiplyScalar(1.8), toneMapped: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4;
    reactor.add(ring);
    // 压力表（前脸 + 缓漂指针）
    const gauge = new THREE.Group();
    gauge.position.set(0, 1.08, 0.3);
    reactor.add(gauge);
    const dial = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.085, 0.025, 24),
      std({ map: gaugeDialTexture(), roughness: 0.4, metalness: 0.6 }),
    );
    dial.rotation.x = Math.PI / 2;
    gauge.add(dial);
    gaugeNeedle = new THREE.Group();
    const needle = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.062, 0.006),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a4a).multiplyScalar(1.6), toneMapped: false }),
    );
    needle.position.y = 0.026;
    gaugeNeedle.add(needle);
    gaugeNeedle.position.z = 0.016;
    gauge.add(gaugeNeedle);
    // 视镜补光（暖）
    reactorGlowLight = new THREE.PointLight(0xffb46a, 2.2, 2.2, 1.8);
    reactorGlowLight.position.set(0, 0.95, 0.55);
    reactor.add(reactorGlowLight);
    shadowAll(reactor);
  }

  /* ---------- 墙面管路 + 玻璃管液流（元素流可视化） ---------- */
  let flowTubeLiquid: THREE.Mesh | null = null;
  {
    const yRun = 2.3;
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 10), mats.brass);
    riser.position.set(0.5, 1.85, -2.55);
    group.add(riser);
    const run = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.0, 10), mats.brass);
    run.rotation.z = Math.PI / 2;
    run.position.set(1.5, yRun, -2.55);
    group.add(run);
    for (const x of [0.5, 2.5]) {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mats.brassDark);
      joint.position.set(x, yRun, -2.55);
      group.add(joint);
    }
    // 阀门手轮 ×2
    for (const x of [1.0, 1.9]) {
      const valve = new THREE.Group();
      valve.position.set(x, yRun, -2.55);
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 8, 18), mats.brass);
      valve.add(wheel);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), mats.brassDark);
      hub.rotation.x = Math.PI / 2;
      valve.add(hub);
      for (let i = 0; i < 4; i++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.01, 0.01), mats.brassDark);
        spoke.rotation.z = (i * Math.PI) / 4;
        valve.add(spoke);
      }
      group.add(valve);
    }
    // 玻璃管液流：横管右端下到台面高度（x=2.5，桌面 y≈0.945）
    const tubeX = 2.5;
    const tubeTop = 2.25;
    const tubeBottom = 0.98;
    const tubeH = tubeTop - tubeBottom;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, tubeH, 12), mats.glass);
    tube.position.set(tubeX, (tubeTop + tubeBottom) / 2, -2.55);
    group.add(tube);
    for (const y of [tubeBottom + 0.02, tubeTop - 0.02]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 12), mats.brassDark);
      cap.position.set(tubeX, y, -2.55);
      group.add(cap);
    }
    flowTubeLiquid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, tubeH - 0.08, 10),
      mats.liquid.clone(),
    );
    flowTubeLiquid.position.set(tubeX, (tubeTop + tubeBottom) / 2, -2.55);
    group.add(flowTubeLiquid);
  }

  /* ---------- 立式储罐（右后角，程序化） ---------- */
  {
    const tank = new THREE.Group();
    tank.position.set(3.2, 0, -1.9);
    group.add(tank);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.35, 18), mats.brass);
    body.position.y = 0.72;
    tank.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), mats.brass);
    dome.position.y = 1.395;
    tank.add(dome);
    for (const y of [0.45, 1.1]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.435, 0.435, 0.07, 18), mats.iron);
      band.position.y = y;
      tank.add(band);
    }
    const stripeTex = warningStripeTexture();
    stripeTex.repeat.set(12, 1);
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.425, 0.425, 0.12, 18, 1, true),
      std({ map: stripeTex, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }),
    );
    skirt.position.y = 0.14;
    tank.add(skirt);
    const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 12), mats.brassDark);
    hatch.position.y = 1.72;
    tank.add(hatch);
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), mats.brassDark);
    stub.rotation.z = Math.PI / 2;
    stub.position.set(-0.48, 1.0, 0);
    tank.add(stub);
    shadowAll(tank);
  }

  /* ---------- 齿轮组（后墙左段，缓转反向啮合） ---------- */
  const gears: THREE.Group[] = [];
  function makeGear(r: number, teeth: number, mat: THREE.Material): THREE.Group {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 20), mat));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.28, 0.08, 12), mat));
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(r * 0.3, 0.06, r * 0.34), mat);
      tooth.position.set(Math.cos(a) * r * 1.06, 0, Math.sin(a) * r * 1.06);
      tooth.rotation.y = -a;
      g.add(tooth);
    }
    shadowAll(g);
    return g;
  }
  {
    const g1 = makeGear(0.22, 10, mats.brass);
    g1.position.set(-0.55, 1.95, -2.96);
    const g2 = makeGear(0.15, 8, mats.brassDark);
    g2.position.set(-0.12, 1.78, -2.96);
    group.add(g1, g2);
    gears.push(g1, g2);
  }

  /* ---------- 坩埚（台左侧地面，暖光锚点） ---------- */
  const fireHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialGlowTexture('rgba(255,190,110,0.95)', 'rgba(255,120,40,0.5)'),
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  fireHalo.scale.set(1.5, 1.2, 1);
  fireHalo.position.set(-2.9, 0.42, -0.1);
  group.add(fireHalo);
  const fireLight = new THREE.PointLight(0xff8c3a, 10, 5.5, 1.8);
  fireLight.position.set(-2.9, 0.6, 0.0);
  group.add(fireLight);
  // 坩埚三足 + 锅体（程序化，GLB 坩埚仅样张验证期使用）
  {
    const pot = new THREE.Group();
    pot.position.set(-2.9, 0, -0.1);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.24, 0.3, 16), mats.iron);
    bowl.position.y = 0.42;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 8, 16), mats.brass);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.56;
    pot.add(bowl, rim);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.28, 8), mats.iron);
      leg.position.set(Math.cos(a) * 0.2, 0.14, Math.sin(a) * 0.2);
      leg.rotation.z = Math.cos(a) * 0.25;
      leg.rotation.x = -Math.sin(a) * 0.25;
      pot.add(leg);
    }
    shadowAll(pot);
    group.add(pot);
  }

  /* ---------- 木桶（台后） ---------- */
  {
    const barrel = new THREE.Group();
    barrel.position.set(2.15, 0, -1.75);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.62, 14), mats.woodDark);
    body.position.y = 0.31;
    barrel.add(body);
    for (const y of [0.16, 0.47]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.045, 14), mats.iron);
      band.position.y = y;
      barrel.add(band);
    }
    shadowAll(barrel);
    group.add(barrel);
  }

  /* ---------- 萤火微尘 ---------- */
  const MOTES = 26;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(MOTES * 3);
  const moteSeed: number[] = [];
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = -3.4 + Math.random() * 6.4;
    motePos[i * 3 + 1] = 0.7 + Math.random() * 1.7;
    motePos[i * 3 + 2] = -2.4 + Math.random() * 3.6;
    moteSeed.push(Math.random() * Math.PI * 2);
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      map: radialGlowTexture('rgba(255,230,170,1)', 'rgba(255,200,120,0.4)'),
      size: 0.09, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }),
  );
  // 微尘穿过反应釜/储罐时按距离淡出——不装软粒子的话它们会「糊」在金属表面上，
  // 这是加色粒子的通病（没有体积感，只有一层脏点）。
  if (opts.depth && motes.material instanceof THREE.PointsMaterial) {
    applySoftParticles(motes.material, opts.depth, { params: opts.params, distance: 0.28 });
  }
  group.add(motes);

  // 木桶/坩埚等程序化几何上的平铺贴图连续化
  worldBoxUV(group);

  /* ---------- 动画 ---------- */
  let flowOffset = 0;

  return {
    group,
    update(dt: number, t: number, flowOn: boolean) {
      // 坩埚火光闪烁
      const flicker = 0.75 + Math.sin(t * 9.3) * 0.12 + Math.sin(t * 23.7) * 0.08;
      fireLight.intensity = 10 * flicker;
      fireHalo.material.opacity = 0.55 + 0.4 * flicker;

      if (!flowOn) return;
      // 齿轮缓转
      gears[0].rotation.y += dt * 0.4;
      gears[1].rotation.y -= dt * 0.58;
      // 液流滚动 + 视镜液位脉动
      flowOffset += dt * 0.55;
      if (flowTubeLiquid) {
        const mat = flowTubeLiquid.material as THREE.MeshStandardMaterial;
        if (mat.map) mat.map.offset.y = -flowOffset % 1;
      }
      if (sightLiquid) {
        const s = 0.9 + Math.sin(t * 2.1) * 0.08;
        sightLiquid.scale.y = s;
        sightLiquid.position.y = 0.9 - (0.42 * (1 - s)) / 2;
      }
      if (reactorGlowLight) reactorGlowLight.intensity = 2.2 + Math.sin(t * 2.1) * 0.5;
      // 压力表针缓漂
      if (gaugeNeedle) {
        const v = 0.45 + Math.sin(t * 0.7) * 0.12 + Math.sin(t * 3.1) * 0.04;
        gaugeNeedle.rotation.z = -Math.PI * 0.75 + v * Math.PI * 1.5;
      }
      // 微尘漂移
      const pa = moteGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < MOTES; i++) {
        pa.setY(i, pa.getY(i) + Math.sin(t * 0.6 + moteSeed[i]) * 0.0006);
        pa.setX(i, pa.getX(i) + Math.cos(t * 0.4 + moteSeed[i]) * 0.0005);
      }
      pa.needsUpdate = true;
    },
  };
}
