/**
 * 轻科幻展示棚（LAB 专用）：浅灰摄影棚背景 + 蓝图网格地面 + 远处升天线。
 * 参照：少前2 / 终末地角色展示页——中央提亮的浅灰棚壁 + 细板缝线，
 * 地面蓝图网格（1m 细线 / 4m 主线，平铺），远处网格主轴位置竖起渐隐光柱接进天空，
 * 配合雾 + BokehPass 景深，远处地面「糊进天里」。
 *
 * 只给 lab 编辑器用，主工程房间不动。灯光不归这里管（沿用编辑器原标定）。
 */

import * as THREE from 'three';
import { setQueue } from '../src/queue';

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface StudioHandles {
  /** 地面（可按需隐藏） */
  floor: THREE.Mesh;
  /** 蓝图网格线层（透明平铺） */
  grid: THREE.Mesh;
  /** 远处升天光柱组 */
  pillars: THREE.Group;
}

/** 棚壁背景纹理（单独导出：场景/集成编辑器只垫背景，不加雾和地面） */
export function createBackdropTexture(): THREE.CanvasTexture {
  return canvasTexture(1024, 1024, (ctx, s) => {
    const g = ctx.createRadialGradient(s * 0.5, s * 0.42, s * 0.04, s * 0.5, s * 0.5, s * 0.78);
    // 冷灰基底：编辑器灯光是暖主光 + 紫蓝环境，这里预先偏冷去抵消（否则会被染成奶油橙）
    g.addColorStop(0, '#dfe2e6');
    g.addColorStop(0.55, '#c2c7cd');
    g.addColorStop(1, '#9ba1ab');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // 竖向板缝：地平线(0.68)以下偏实（接地面），向上渐隐——「延长线升进天空」
    const xs = [0.09, 0.22, 0.36, 0.5, 0.63, 0.77, 0.91];
    for (const x of xs) {
      const up = ctx.createLinearGradient(0, s * 0.68, 0, s * 0.1);
      up.addColorStop(0, 'rgba(45,45,58,0.10)');
      up.addColorStop(1, 'rgba(45,45,58,0)');
      ctx.strokeStyle = up;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s * x, s * 0.68);
      ctx.lineTo(s * x, s * 0.1);
      ctx.stroke();

      const down = ctx.createLinearGradient(0, s * 0.68, 0, s);
      down.addColorStop(0, 'rgba(45,45,58,0.12)');
      down.addColorStop(1, 'rgba(45,45,58,0.04)');
      ctx.strokeStyle = down;
      ctx.beginPath();
      ctx.moveTo(s * x, s * 0.68);
      ctx.lineTo(s * x, s);
      ctx.stroke();
    }
    // 地平线横缝（轻科幻地平基准线）
    ctx.strokeStyle = 'rgba(45,45,58,0.11)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.68);
    ctx.lineTo(s, s * 0.68);
    ctx.stroke();
    // 顶部一条
    ctx.strokeStyle = 'rgba(45,45,58,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, s * 0.28);
    ctx.lineTo(s, s * 0.28);
    ctx.stroke();
  });
}

/** 只垫棚壁背景（给场景/集成编辑器；注意 EffectComposer 会丢 alpha，CSS 背景透不出来） */
export function applyBackdrop(scene: THREE.Scene): void {
  scene.background = createBackdropTexture();
}

/** 蓝图网格平铺纹理：tile = 4m，1m 细线 + 4m 主线（钢蓝，透明底） */
function createGridTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(256, 256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    // 1m 细线
    ctx.strokeStyle = 'rgba(84,110,148,0.9)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      const p = (s * i) / 4;
      ctx.beginPath();
      ctx.moveTo(p, 0); ctx.lineTo(p, s);
      ctx.moveTo(0, p); ctx.lineTo(s, p);
      ctx.stroke();
    }
    // 4m 主线（tile 边缘）
    ctx.strokeStyle = 'rgba(58,80,116,1)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** 升天光柱贴图：底实上虚的竖向渐变（白色，靠 material.color 调色） */
function createPillarTexture(): THREE.CanvasTexture {
  return canvasTexture(16, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export function buildStudio(scene: THREE.Scene): StudioHandles {
  // ---- 背景：无穷远棚壁（屏幕空间，不随轨道相机转动）----
  scene.background = createBackdropTexture();

  // 雾：把地面远端融进背景边缘色
  scene.fog = new THREE.Fog(0x9ba1ab, 9, 28);

  // ---- 地面基底：柔光斑渐变（棚顶光落地的感觉；偏冷抵消暖主光染色）----
  const floorTex = canvasTexture(1024, 1024, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.62);
    g.addColorStop(0, '#ccd4dc');
    g.addColorStop(0.5, '#bcc4ce');
    g.addColorStop(1, '#98a2ae');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  floorTex.anisotropy = 8;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 48),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.96, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.12; // 略低于展示台面，pad 仍是「台」
  floor.receiveShadow = true;
  scene.add(floor);

  // ---- 蓝图网格层：1m 细线 / 4m 主线，独立透明平面叠在基底上 ----
  const gridTex = createGridTexture();
  gridTex.repeat.set(12, 12); // 48m / 4m tile
  gridTex.anisotropy = 8;
  const grid = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 48),
    new THREE.MeshBasicMaterial({ map: gridTex, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -0.119;
  setQueue(grid, 'decal', 0);
  scene.add(grid);

  // ---- 升天光柱：远处一圈（r=13m），网格主轴方向的竖线，渐隐接进天空 ----
  const pillarTex = createPillarTexture();
  const pillarMat = new THREE.MeshBasicMaterial({
    map: pillarTex, color: 0x4a6690, transparent: true, opacity: 1,
    depthWrite: false, side: THREE.DoubleSide,
    fog: false, // 天上的线不吃雾——雾把远处棚体洗白时，光柱要留下来读出「延长线」
  });
  const pillars = new THREE.Group();
  const COUNT = 12;
  const R = 13;
  for (let i = 0; i < COUNT; i++) {
    const ang = (i / COUNT) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 12), pillarMat);
    p.position.set(Math.cos(ang) * R, 12 / 2 - 0.12, Math.sin(ang) * R);
    p.lookAt(0, 12 / 2 - 0.12, 0); // 面朝圆心，从棚内看是「线」不是「面」
    setQueue(p, 'decal', 1);
    pillars.add(p);
  }
  scene.add(pillars);

  return { floor, grid, pillars };
}
