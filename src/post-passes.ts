/**
 * 常用的全屏 pass 成品（层 C 的「内容侧不用自己写 shader」那一档）。
 *
 * 为什么要成品：`PassDescriptor.create(ctx)` 要求调用方会写 GLSL + 管 quad + 管 uniform，
 * 而 80% 的全屏效果是这几种。给成品不是限制，是让「加个冲击波」不必先读三个 three 文件。
 *
 * 这里每个 pass 都声明 `anchor`：
 *
 *   shockwave    afterTonemap  显示参考空间做径向折射（线性光里做会过曝）
 *   depthEdge    afterTonemap  深度拉普拉斯描边（读深度缓冲）
 *
 * 深度：`post` 的 RT 现在挂了 depthTexture（见 post.ts）。深度只在 **RenderPass 写进去的
 * 那个缓冲** 上有效，所以 DepthEdgePass 拿的是 `post.depthTexture`（= renderTarget1 的）。
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const QUAD_VERT = /* glsl */ `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

attribute vec3 position;
attribute vec2 uv;

varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/* ------------------------------------------------------------------ *
 * 冲击波：径向折射 + 一圈加色
 * ------------------------------------------------------------------ */

const SHOCKWAVE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uCenter;     // 0..1，默认画面中心
uniform float uProgress;  // 0..1
uniform float uWidth;     // 环宽（屏幕高度的比例）
uniform float uStrength;  // 0 = 关
uniform vec3 uColor;
uniform float uAspect;

varying vec2 vUv;

void main() {
	vec4 base = texture2D( tDiffuse, vUv );

	// 圆在屏幕空间是椭圆 → 先按宽高比拉正 x，再算半径
	vec2 d = vUv - uCenter;
	d.x *= uAspect;
	float r = length( d );
	float radius = uProgress * 1.05;

	// 高斯环：比 smoothstep 对撞更干净（不会出现两条边）
	float ring = exp( -pow( ( r - radius ) / max( uWidth, 0.001 ), 2.0 ) );

	vec2 dir = r > 1e-5 ? d / r : vec2( 0.0 );
	// 折射方向在屏幕空间要按 aspect 还原，否则水平与竖直的偏移量不一致
	vec2 offset = vec2( dir.x / uAspect, dir.y ) * ring * 0.02 * uStrength;
	vec3 rgb = texture2D( tDiffuse, vUv - offset ).rgb + uColor * ring * uStrength * 0.55;

	gl_FragColor = vec4( mix( base.rgb, rgb, step( 0.0001, uStrength ) ), base.a );
}
`;

export interface ShockwaveOptions {
  /** 环色（默认冰蓝） */
  color?: THREE.ColorRepresentation;
  /** 强度 0–2（0 = 完全不影响画面） */
  strength?: number;
  /** 环宽（屏幕高度比例，默认 0.05） */
  width?: number;
  /** 波心（0–1，默认画面中心） */
  center?: { x: number; y: number };
}

export class ShockwavePass extends Pass {
  readonly material: THREE.RawShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly quad: FullScreenQuad;

  constructor(opts: ShockwaveOptions = {}) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      uCenter: { value: new THREE.Vector2(opts.center?.x ?? 0.5, opts.center?.y ?? 0.5) },
      uProgress: { value: 0 },
      uWidth: { value: opts.width ?? 0.05 },
      uStrength: { value: opts.strength ?? 1 },
      uColor: { value: new THREE.Color(opts.color ?? 0x9fd8ff) },
      uAspect: { value: 1 },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'ShockwavePass',
      uniforms: this.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: SHOCKWAVE_FRAG,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uAspect.value = writeBuffer.width / Math.max(1, writeBuffer.height);

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.quad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export function createShockwavePass(opts: ShockwaveOptions = {}): ShockwavePass {
  return new ShockwavePass(opts);
}

/* ------------------------------------------------------------------ *
 * 深度描边：深度拉普拉斯 → 线
 * ------------------------------------------------------------------ */

const DEPTH_EDGE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform float uOrtho;      // 1 = 正交（舞台），0 = 透视（编辑器）
uniform float uStrength;
uniform float uThreshold;
uniform vec3 uColor;

varying vec2 vUv;

// 自己写线性化，不用 #include <packing>：那个 chunk 里有 modf()，
// 在 GLSL ES 1.00（three 默认）下没有这个重载，整段 fragment 直接编译失败。
float viewDepth( vec2 uv ) {
	float d = texture2D( tDepth, uv ).x;
	float near = uNearFar.x;
	float far = uNearFar.y;
	float v = uOrtho > 0.5
		? d * ( near - far ) - near
		: ( near * far ) / ( ( far - near ) * d - far );
	return -v; // 视空间 z 是负的 → 取正
}

void main() {
	vec4 base = texture2D( tDiffuse, vUv );

	float c = viewDepth( vUv );
	float l = viewDepth( vUv - vec2( uTexel.x, 0.0 ) );
	float r = viewDepth( vUv + vec2( uTexel.x, 0.0 ) );
	float t = viewDepth( vUv + vec2( 0.0, uTexel.y ) );
	float b = viewDepth( vUv - vec2( 0.0, uTexel.y ) );

	// 用相对差（除以本像素深度）→ 近处和远处都能出线，不用按景别调阈值
	float lap = abs( l + r + t + b - 4.0 * c ) / max( c, 0.001 );
	float edge = smoothstep( uThreshold, uThreshold * 2.0 + 0.0001, lap ) * uStrength;

	gl_FragColor = vec4( mix( base.rgb, uColor, clamp( edge, 0.0, 1.0 ) ), base.a );
}
`;

/** 没有深度缓冲时的替身：全 1（远平面）→ 拉普拉斯恒为 0 → 画面上什么都不加 */
const FALLBACK_DEPTH = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
FALLBACK_DEPTH.needsUpdate = true;

export interface DepthEdgeOptions {
  camera: THREE.Camera;
  /** `post.depthTexture`；没有深度缓冲时这个 pass 什么都不做 */
  depthTexture: THREE.Texture | null;
  color?: THREE.ColorRepresentation;
  /** 0–1，线强度 */
  strength?: number;
  /** 相对深度差阈值（0.02 适合正交 diorama；透视场景调大到 0.05–0.1） */
  threshold?: number;
}

export class DepthEdgePass extends Pass {
  readonly material: THREE.RawShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly quad: FullScreenQuad;
  private readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  constructor(opts: DepthEdgeOptions) {
    super();
    this.camera = opts.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: opts.depthTexture ?? FALLBACK_DEPTH },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.1, 60) },
      uOrtho: { value: (opts.camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0 },
      uStrength: { value: opts.strength ?? 0.85 },
      uThreshold: { value: opts.threshold ?? 0.02 },
      uColor: { value: new THREE.Color(opts.color ?? 0x1a1622) },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'DepthEdgePass',
      uniforms: this.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: DEPTH_EDGE_FRAG,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** 换深度纹理（舞台重建 RT 后调用） */
  setDepthTexture(tex: THREE.Texture | null): void {
    this.uniforms.tDepth.value = tex ?? FALLBACK_DEPTH;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uTexel.value.set(1 / Math.max(1, writeBuffer.width), 1 / Math.max(1, writeBuffer.height));
    this.uniforms.uNearFar.value.set(this.camera.near, this.camera.far);
    this.uniforms.uOrtho.value = (this.camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.quad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export function createDepthEdgePass(opts: DepthEdgeOptions): DepthEdgePass {
  return new DepthEdgePass(opts);
}
