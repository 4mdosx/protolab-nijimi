/**
 * 连线：TubeGeometry + 流动 shader。
 * 「流动才亮」（工坊空间尺度 §4.3）：有流量→流光，停摆→变暗。
 * 悬停穿透（§4.2）：depthTest=false + renderOrder。
 * 布线（§3）：端口 → 上升到 h_edge → 水平 → 下降到目标端口（三段曼哈顿）。
 */

import * as THREE from 'three';
import { setQueue } from '../queue';
import type { ParamBus } from '../shader/params';
import { defineMaterial } from '../shader/define';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 注意：uniform 声明由 defineMaterial 按参数表自动生成，这里**不要**再写 `uniform ...;`
// （重复声明会编译失败）。这是层 B 和手写 ShaderMaterial 最不一样的约定。
const FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    // 沿线流动的亮段
    float stripes = fract(vUv.x * 6.0 - uTime * 1.6);
    float pulse = smoothstep(0.05, 0.5, stripes) * smoothstep(0.95, 0.5, stripes);
    float base = 0.28;
    vec3 col = uColor * (base + (1.0 - base) * pulse * uFlow);
    col += uColor * uHighlight * 0.5;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

export interface Conduit {
  edgeKey: string;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  fromSlot: number;
  toSlot: number;
  /** 悬停穿透状态 */
  highlight: boolean;
}

export class ConduitManager {
  group = new THREE.Group();
  private conduits = new Map<string, Conduit>();
  /**
   * 参数总线（可选）。传了就把 `uTime` 绑到引擎的内建时间上——
   * 流光按**真实 dt** 走，不再靠内容侧每帧 `setTime()` 喂 1/30 的动画时钟。
   */
  private readonly params: ParamBus | null;

  constructor(params: ParamBus | null = null) {
    this.params = params;
  }

  private static edgeKey(fromSlot: number, fromPort: number, toSlot: number, toPort: number): string {
    return `${fromSlot}:${fromPort}>${toSlot}:${toPort}`;
  }

  /** 曼哈顿三段路径 */
  private static makePath(a: THREE.Vector3, b: THREE.Vector3, h: number): THREE.CatmullRomCurve3 {
    const mid1 = new THREE.Vector3(a.x, h, a.z);
    const mid2 = new THREE.Vector3(b.x, h, b.z);
    return new THREE.CatmullRomCurve3([a, mid1, mid2, b], false, 'catmullrom', 0.0);
  }

  add(
    fromSlot: number,
    fromPort: number,
    a: THREE.Vector3,
    toSlot: number,
    toPort: number,
    b: THREE.Vector3,
  ): Conduit {
    const key = ConduitManager.edgeKey(fromSlot, fromPort, toSlot, toPort);
    this.remove(key);
    const h = Math.max(a.y, b.y) + 0.22;
    const curve = ConduitManager.makePath(a, b, h);
    const geom = new THREE.TubeGeometry(curve, 32, 0.014, 8, false);
    // 层 B：时间由引擎给（`builtins: ['time']` → 内建 uTime，真实 dt），
    // 队列由语义定（`effect` 带），参数表同时生成 uniform 声明。
    // `local` 里的是**每条线私有**的量：共享 uOpacity 会让「悬停一条、全部变淡」。
    const material = defineMaterial(
      {
        id: 'conduit-flow',
        name: 'ConduitFlow',
        queue: 'effect',
        blending: 'additive',
        depth: { write: false },
        builtins: ['time'],
        params: [
          { id: 'uFlow', type: 'float', label: '流量（0 停摆 / 1 流动）' },
          { id: 'uColor', type: 'color', label: '连线颜色' },
          { id: 'uOpacity', type: 'float', label: '不透明度' },
          { id: 'uHighlight', type: 'float', label: '悬停高亮（0/1）' },
        ],
        local: ['uFlow', 'uColor', 'uOpacity', 'uHighlight'],
        values: {
          uFlow: 0,
          uColor: new THREE.Color(0x8ad8ff),
          uOpacity: 0.85,
          uHighlight: 0,
        },
        vert: VERTEX,
        frag: FRAGMENT,
      },
      { params: this.params ?? undefined },
    );
    const mesh = new THREE.Mesh(geom, material);
    setQueue(mesh, 'effect', 0);
    const conduit: Conduit = { edgeKey: key, mesh, material, fromSlot, toSlot, highlight: false };
    this.group.add(mesh);
    this.conduits.set(key, conduit);
    return conduit;
  }

  remove(key: string) {
    const c = this.conduits.get(key);
    if (!c) return;
    this.group.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.material.dispose();
    this.conduits.delete(key);
  }

  clear() {
    for (const key of [...this.conduits.keys()]) this.remove(key);
  }

  get(key: string): Conduit | undefined {
    return this.conduits.get(key);
  }

  all(): Conduit[] {
    return [...this.conduits.values()];
  }

  /**
   * 手动喂时间（旧接口）。
   * @deprecated 传了 `ParamBus` 时不要调：`uTime` 归引擎（真实时间），这里写就是抢写。
   */
  setTime(t: number) {
    for (const c of this.conduits.values()) c.material.uniforms.uTime.value = t;
  }

  /** 悬停某 slot：相关边穿透高亮，无关边淡出 15% */
  hoverSlot(slot: number | null) {
    for (const c of this.conduits.values()) {
      const related = slot == null || c.fromSlot === slot || c.toSlot === slot;
      c.highlight = related && slot != null;
      c.material.uniforms.uHighlight.value = related && slot != null ? 1 : 0;
      c.material.depthTest = !(related && slot != null);
      // 同一条带（effect）内把悬停的那几条压到后面画：带内偏移，不跨带抢号
      setQueue(c.mesh, 'effect', related && slot != null ? 10 : 0);
      if (slot != null && !related) c.material.uniforms.uOpacity.value = 0.15;
      else c.material.uniforms.uOpacity.value = 0.85;
    }
  }
}
