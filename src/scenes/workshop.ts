/**
 * 程序化房间：Box 拼 + CanvasTexture（M0 骨架 + M3 打光）。
 * 布局：地板 8×6，后墙(z=-3) + 左墙(x=-4)，等距相机从 (+x,+z) 看进去。
 * 大家具：壁炉（可开关，火光+粒子挂点）、喷泉（可开关）、书架（氛围）。
 *
 * 分层接口：本文件是「场景层」（MVP原型设计 §4.1）——布局 hash 从这里出，
 * 将来实时光换烘焙时只换场景层实现。
 *
 * ⚠️ 定位（2026-10-16 拆分后）：这是**引擎随带的示例内容包**——用 ScenePack 契约
 * 告诉引擎「我有多大、注视点在哪、每帧动什么」。它同时是游戏侧「只关心业务」的
 * 起点：游戏要自建房间时，把本文件整体 fork 到游戏仓（实现同一 ScenePack），
 * 引擎不必改一行。锚点（slotPositions）就是给玩法用的家具位。
 */

import * as THREE from 'three';
import { woodFloorTexture, wallpaperTexture, stoneTexture, tableTexture, workbenchTexture, windowTexture } from '../textures';
import { ElementParticles } from '../particles';
import { buildIndustrial } from '../kits/industrial';
import type { ScenePack } from './types';

export const SLOT_COUNT = 5;
export const TABLE_TOP_Y = 0.9;
/** slot 间距（工坊空间尺度 §2.1：桌面级 D=0.75） */
export const SLOT_PITCH = 0.78;

export interface RoomHandles {
  group: THREE.Group;
  /** slot 中心点（世界坐标，台面上） */
  slotPositions: THREE.Vector3[];
  /** 壁炉火焰挂点（粒子发射原点） */
  fireplacePoint: THREE.Vector3;
  /** 喷泉挂点 */
  fountainPoint: THREE.Vector3;
  /** 可开关家具的拾取体 */
  fireplaceMesh: THREE.Mesh;
  fountainMesh: THREE.Mesh;
  /** 壁炉点光（开关/闪烁由外部驱动） */
  fireplaceLight: THREE.PointLight;
  fireplaceGlow: THREE.Mesh;
  /** 布局 hash：家具开关 + slot 占用变化时更新（房间渲染架构 §5，MVP 只留接口） */
  layoutKey: string;
}

function buildFireplace(stone: THREE.Texture): { group: THREE.Group; light: THREE.PointLight; glow: THREE.Mesh; point: THREE.Vector3 } {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 });
  // 主体：两侧柱 + 顶梁 + 背板
  const pillar = new THREE.BoxGeometry(0.3, 1.5, 0.55);
  const left = new THREE.Mesh(pillar, mat);
  left.position.set(-0.55, 0.75, 0);
  const right = new THREE.Mesh(pillar, mat);
  right.position.set(0.55, 0.75, 0);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 0.65), mat);
  top.position.set(0, 1.62, 0);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.12), mat);
  back.position.set(0, 0.75, -0.22);
  const hearth = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.8), mat);
  hearth.position.set(0, 0.06, 0.1);
  group.add(left, right, top, back, hearth);

  // 火膛内壁自发光（开关时调整）
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.8),
    new THREE.MeshBasicMaterial({ color: 0xff7a26, transparent: true, opacity: 0.9 }),
  );
  glow.position.set(0, 0.62, -0.14);
  group.add(glow);

  const light = new THREE.PointLight(0xff8c3a, 2.2, 7, 1.6);
  light.position.set(0, 0.75, 0.35);
  light.castShadow = true;
  group.add(light);

  const point = new THREE.Vector3(0, 0.55, 0);
  group.add(new THREE.Object3D()); // 占位保持结构
  return { group, light, glow, point };
}

function buildFountain(): { group: THREE.Group; point: THREE.Vector3; pool: THREE.Mesh } {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x6a7684, roughness: 0.8 });
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 0.35, 24), stone);
  basin.position.y = 0.175;
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.55, 12), stone);
  pedestal.position.y = 0.6;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.2, 0.14, 20), stone);
  bowl.position.y = 0.92;
  // 水面
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(0.48, 24),
    new THREE.MeshStandardMaterial({ color: 0x4aa8d8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.36;
  group.add(basin, pedestal, bowl, water);
  return { group, point: new THREE.Vector3(0, 1.0, 0), pool: water };
}

function buildBookshelf(wood: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.2, 1.6), mat);
  frame.position.y = 1.1;
  g.add(frame);
  // 书脊色块
  const bookColors = [0x7a3b2e, 0x3b5a7a, 0x5a7a3b, 0x7a6a3b, 0x5a3b7a];
  for (let shelf = 0; shelf < 4; shelf++) {
    let z = -0.7;
    while (z < 0.6) {
      const w = 0.05 + Math.random() * 0.08;
      const h = 0.24 + Math.random() * 0.08;
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, h, w),
        new THREE.MeshStandardMaterial({ color: bookColors[Math.floor(Math.random() * bookColors.length)], roughness: 0.9 }),
      );
      book.position.set(0.16, 0.32 + shelf * 0.5 + h / 2, z + w / 2);
      g.add(book);
      z += w + 0.015;
    }
  }
  return g;
}

export function buildRoom(): RoomHandles {
  const group = new THREE.Group();

  // 地板
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(8, 0.1, 6),
    new THREE.MeshStandardMaterial({ map: woodFloorTexture(), roughness: 0.9 }),
  );
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  group.add(floor);

  // 地毯（工作台下方）
  const rug = new THREE.Mesh(
    new THREE.BoxGeometry(4.8, 0.02, 3.4),
    new THREE.MeshStandardMaterial({ color: 0x6a4a52, roughness: 1 }),
  );
  rug.position.set(0.5, 0.011, 0.2);
  rug.receiveShadow = true;
  group.add(rug);

  // 墙
  const wallMat = new THREE.MeshStandardMaterial({ map: wallpaperTexture(), roughness: 1 });
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 0.15), wallMat);
  backWall.position.set(0, 1.5, -3.075);
  backWall.receiveShadow = true;
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3, 6), wallMat);
  leftWall.position.set(-4.075, 1.5, 0);
  leftWall.receiveShadow = true;
  group.add(backWall, leftWall);

  // 窗（后墙，自发光）
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 1.6),
    new THREE.MeshBasicMaterial({ map: windowTexture() }),
  );
  win.position.set(1.9, 1.7, -2.99);
  group.add(win);

  // 工作台
  const wood = tableTexture();
  const table = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 0.09, 2.5),
    new THREE.MeshStandardMaterial({ map: workbenchTexture(), roughness: 0.85 }),
  );
  top.position.y = TABLE_TOP_Y - 0.045;
  top.castShadow = true;
  top.receiveShadow = true;
  table.add(top);
  const legMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 });
  for (const [lx, lz] of [[-2.0, -1.05], [2.0, -1.05], [-2.0, 1.05], [2.0, 1.05]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, TABLE_TOP_Y - 0.09, 0.14), legMat);
    leg.position.set(lx, (TABLE_TOP_Y - 0.09) / 2, lz);
    leg.castShadow = true;
    table.add(leg);
  }
  table.position.set(0.5, 0, 0);
  group.add(table);

  // slot 圈（空工位提示环）
  const slotPositions: THREE.Vector3[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const x = 0.5 + (i - 2) * SLOT_PITCH;
    slotPositions.push(new THREE.Vector3(x, TABLE_TOP_Y + 0.005, 0));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.36, 32),
      new THREE.MeshBasicMaterial({ color: 0xd4b478, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(slotPositions[i]).y += 0.002;
    ring.name = `slot-ring-${i}`;
    ring.userData = { kind: 'slotRing', slotIndex: i };
    group.add(ring);
    // 透明拾取圆盘：ring 中心是洞，点击中心要能命中
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 24),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.001, depthWrite: false }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(slotPositions[i]).y += 0.001;
    disc.userData = { kind: 'slotRing', slotIndex: i };
    group.add(disc);
  }

  // 壁炉（后墙左段）
  const stone = stoneTexture();
  const fp = buildFireplace(stone);
  fp.group.position.set(-2.3, 0, -2.65);
  fp.group.traverse((o) => {
    o.userData = { ...o.userData, kind: 'fireplace' };
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  fp.glow.castShadow = false;
  fp.glow.userData = { kind: 'fireplace' };
  group.add(fp.group);
  const fireplacePoint = fp.group.localToWorld(fp.point.clone());

  // 喷泉（左前角）
  const ft = buildFountain();
  ft.group.position.set(-3.0, 0, 1.6);
  ft.group.traverse((o) => {
    o.userData = { ...o.userData, kind: 'fountain' };
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  group.add(ft.group);
  const fountainPoint = ft.group.localToWorld(ft.point.clone());

  // 书架（左墙）
  const shelf = buildBookshelf(wood);
  shelf.position.set(-3.85, 0, -1.2);
  shelf.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  group.add(shelf);

  // 蜡烛：氛围，小火苗自发光（不加点光，省性能）
  const candleMat = new THREE.MeshStandardMaterial({ color: 0xe8ddc8, roughness: 0.6 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc060 });
  const candleSpots: [number, number, number][] = [
    [0.5, TABLE_TOP_Y + 0.05, -1.0],
    [-1.9, 1.72, -2.99],
    [3.4, TABLE_TOP_Y + 0.05, -0.9],
  ];
  for (const [x, y, z] of candleSpots) {
    const h = 0.1 + Math.random() * 0.08;
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, h, 10), candleMat);
    candle.position.set(x, y + h / 2 - 0.05, z);
    candle.castShadow = true;
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), flameMat);
    flame.scale.y = 1.6;
    flame.position.set(x, y + h - 0.04, z);
    group.add(candle, flame);
  }

  // 盆栽
  for (const [x, z] of [[3.4, -2.5], [-3.4, 2.4]] as const) {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.12, 0.22, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.9 }),
    );
    pot.position.set(x, 0.11, z);
    const plant = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.18, 1),
      new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 1, flatShading: true }),
    );
    plant.position.set(x, 0.34, z);
    plant.castShadow = true;
    group.add(pot, plant);
  }

  return {
    group,
    slotPositions,
    fireplacePoint,
    fountainPoint,
    fireplaceMesh: fp.group.children[0] as THREE.Mesh,
    fountainMesh: (ft.group.children[0] as THREE.Mesh),
    fireplaceLight: fp.light,
    fireplaceGlow: fp.glow,
    layoutKey: '',
  };
}

/* ------------------------------------------------------------------ *
 * 内容包：工坊 diorama
 * ------------------------------------------------------------------ */

/** 房间含外墙的世界宽（对角投影）——取景用 */
const SPAN_W = 7.8;
/** 房间含墙体的世界投影高 */
const SPAN_H = 5.8;

export interface WorkshopHandles extends RoomHandles {
  /** 工业簇（反应釜/管路/齿轮，引擎 kit 拼装） */
  industrial: ReturnType<typeof buildIndustrial>;
  /** 元素粒子（壁炉/喷泉/坩埚） */
  particles: ElementParticles;
}

/**
 * 工坊内容包。内容动画（火光闪烁 / 粒子 / 机械簇）都在这里，
 * 引擎的帧循环只管按动画层步长调 update。
 */
export const workshopScene: ScenePack<WorkshopHandles> = {
  id: 'workshop',
  cn: '女巫工坊',
  span: { w: SPAN_W, h: SPAN_H },
  focus: [0.3, 0.6, 0.1],
  build({ scene, depth, params }) {
    const room = buildRoom();
    scene.add(room.group);

    const particles = new ElementParticles(
      room.fireplacePoint,
      room.fountainPoint,
      new THREE.Vector3(1.9, 1.7, -2.8),
      [new THREE.Vector3(3.4, 0.3, -2.5), new THREE.Vector3(-3.4, 0.3, 2.4)],
      // 舞台开了 softParticles 才有 depth；没开就不装模块（逐像素等于旧行为）
      { depth, params },
    );
    scene.add(particles.group);

    const industrial = buildIndustrial(undefined, { depth, params });
    scene.add(industrial.group);

    let t = 0;
    return {
      group: room.group,
      handles: { ...room, industrial, particles },
      update(dt) {
        t += dt;
        // 壁炉火光闪烁（能量感来自两个不同周期的正弦叠加，不是随机数）
        const flicker = 0.75 + Math.sin(t * 9.3) * 0.12 + Math.sin(t * 23.7) * 0.08;
        const on = (room.fireplaceLight.userData.on as boolean) ?? true;
        room.fireplaceLight.intensity = on ? 26 * flicker : 0;
        (room.fireplaceGlow.material as THREE.MeshBasicMaterial).opacity = on ? 0.85 * flicker : 0.05;
        particles.tick(dt);
        industrial.update(dt, t, true);
      },
    };
  },
};
