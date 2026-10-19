/**
 * 元素粒子（MVP原型设计 §5/§7）：Points + 径向渐变贴图。
 * 火（橙，壁炉上升）、水（蓝，喷泉）参与玩法反馈；
 * 风（灰，窗边飘散）、土（棕，盆栽沉积）只做视觉。
 * 粒子密度随对应元素强度变化 —— 「不看数字也能感知」。
 *
 * 2026-10-17（P3）：支持**软粒子**。给了 `opts.depth`（舞台的深度预 pass）就装上
 * `soft-particles` 模块——粒子贴近墙面/地板时按距离淡出，不再「啪」地被深度裁掉。
 * 不给也完全正常：模块不装，行为和以前逐像素一致。
 */

import * as THREE from 'three';
import { particleTexture } from './textures';
import { applySoftParticles } from './soft-particles';
import type { DepthPrepass } from './depth-prepass';
import type { ParamBus } from './shader/params';
import type { NoticeSink } from './notice';

interface P {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

/** 粒子系统的可选能力（软粒子是唯一的，但都从舞台来） */
export interface ElementParticlesOptions {
  /** 深度预 pass；给了才装软粒子 */
  depth?: DepthPrepass | null;
  /** 参数总线（`uSoftDistance` 要能被编辑器/演出驱动） */
  params?: ParamBus;
  notices?: NoticeSink;
  /** 软粒子过渡距离（世界单位，默认 0.35） */
  softDistance?: number;
}

function makePoints(
  count: number,
  color: number,
  size: number,
  name: string,
  soft?: { depth: DepthPrepass; params?: ParamBus; notices?: NoticeSink; distance?: number },
): { points: THREE.Points; positions: Float32Array } {
  const positions = new Float32Array(count * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    name: `particles/${name}`,
    color,
    size,
    map: particleTexture(),
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  // 软粒子：模块 + 深度 uniform。所有粒子材质共享同一个 uSoftDistance 与深度图，
  // 变体键相同 → 五个系统仍然只有一个 program。
  if (soft) {
    applySoftParticles(mat, soft.depth, {
      params: soft.params,
      notices: soft.notices,
      distance: soft.distance,
    });
  }
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  return { points, positions };
}

class ParticleSystem {
  points: THREE.Points;
  positions: Float32Array;
  parts: P[] = [];
  /** 0..1 发射强度（元素强度/开关驱动） */
  intensity = 1;

  constructor(
    count: number,
    color: number,
    size: number,
    private origin: THREE.Vector3,
    private spawn: (p: P) => void,
    private update: (p: P, dt: number) => void,
    soft?: { depth: DepthPrepass; params?: ParamBus; notices?: NoticeSink; distance?: number },
    name = 'points',
  ) {
    const { points, positions } = makePoints(count, color, size, name, soft);
    this.points = points;
    this.positions = positions;
    for (let i = 0; i < count; i++) {
      const p: P = { pos: origin.clone(), vel: new THREE.Vector3(), life: 0, maxLife: 1 };
      this.spawn(p);
      p.life = Math.random() * p.maxLife; // 错峰
      this.parts.push(p);
    }
  }

  tick(dt: number) {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        if (Math.random() < this.intensity) {
          this.spawn(p);
        } else {
          p.life = 0;
          p.pos.copy(this.origin);
          p.pos.y -= 10; // 隐藏
        }
      }
      this.update(p, dt);
      this.positions[i * 3] = p.pos.x;
      this.positions[i * 3 + 1] = p.pos.y;
      this.positions[i * 3 + 2] = p.pos.z;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class ElementParticles {
  group = new THREE.Group();
  private systems: ParticleSystem[] = [];

  constructor(
    fireplacePoint: THREE.Vector3,
    fountainPoint: THREE.Vector3,
    windowPoint: THREE.Vector3,
    plantPoints: THREE.Vector3[],
    opts: ElementParticlesOptions = {},
  ) {
    const soft = opts.depth
      ? { depth: opts.depth, params: opts.params, notices: opts.notices, distance: opts.softDistance }
      : undefined;
    // 火：壁炉上升
    const fire = new ParticleSystem(
      42,
      0xff9a40,
      0.075,
      fireplacePoint,
      (p) => {
        p.pos.set(fireplacePoint.x + (Math.random() - 0.5) * 0.5, fireplacePoint.y + Math.random() * 0.1, fireplacePoint.z + (Math.random() - 0.5) * 0.3);
        p.vel.set((Math.random() - 0.5) * 0.1, 0.45 + Math.random() * 0.35, (Math.random() - 0.5) * 0.1);
        p.maxLife = 1.2 + Math.random() * 0.8;
        p.life = 0;
      },
      (p, dt) => {
        p.pos.addScaledVector(p.vel, dt);
        p.vel.y += 0.12 * dt;
        p.vel.x += (Math.random() - 0.5) * 0.02;
      },
      soft,
      'fire',
    );
    // 水：喷泉上抛下落
    const water = new ParticleSystem(
      30,
      0x66b8f0,
      0.055,
      fountainPoint,
      (p) => {
        p.pos.copy(fountainPoint);
        p.vel.set((Math.random() - 0.5) * 0.5, 0.9 + Math.random() * 0.5, (Math.random() - 0.5) * 0.5);
        p.maxLife = 1.0 + Math.random() * 0.4;
        p.life = 0;
      },
      (p, dt) => {
        p.vel.y -= 2.4 * dt;
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.35) p.life = p.maxLife;
      },
      soft,
      'water',
    );
    // 风：窗边飘散（纯视觉）
    const wind = new ParticleSystem(
      20,
      0xb8c4d4,
      0.04,
      windowPoint,
      (p) => {
        p.pos.set(windowPoint.x + (Math.random() - 0.5) * 0.8, windowPoint.y + (Math.random() - 0.5) * 1.0, windowPoint.z);
        p.vel.set(0.15 + Math.random() * 0.2, 0.03, 0.25 + Math.random() * 0.2);
        p.maxLife = 3 + Math.random() * 2;
        p.life = 0;
      },
      (p, dt) => {
        p.pos.addScaledVector(p.vel, dt);
        p.vel.y += Math.sin(p.life * 3) * 0.01 * dt * 60;
      },
      soft,
      'wind',
    );
    // 土：盆栽周围缓慢沉积（纯视觉）
    const earthPts: ParticleSystem[] = plantPoints.map(
      (pt) =>
        new ParticleSystem(
          12,
          0xa88858,
          0.045,
          pt,
          (p) => {
            p.pos.set(pt.x + (Math.random() - 0.5) * 0.5, pt.y + 0.5 + Math.random() * 0.3, pt.z + (Math.random() - 0.5) * 0.5);
            p.vel.set(0, -0.12, 0);
            p.maxLife = 3 + Math.random() * 2;
            p.life = 0;
          },
          (p, dt) => p.pos.addScaledVector(p.vel, dt),
          soft,
          `earth-${plantPoints.indexOf(pt)}`,
        ),
    );

    this.systems = [fire, water, wind, ...earthPts];
    for (const s of this.systems) this.group.add(s.points);

    // 外部调节入口：fire/water
    this.fireSystem = fire;
    this.waterSystem = water;
  }

  private fireSystem: ParticleSystem;
  private waterSystem: ParticleSystem;

  /** 元素强度 0..1（相对 target）与家具开关 → 粒子密度 */
  setElementIntensity(fire: number, water: number, fireplaceOn: boolean, fountainOn: boolean) {
    this.fireSystem.intensity = fireplaceOn ? Math.max(0.15, fire) : 0;
    this.waterSystem.intensity = fountainOn ? Math.max(0.15, water) : 0;
  }

  tick(dt: number) {
    for (const s of this.systems) s.tick(dt);
  }
}
