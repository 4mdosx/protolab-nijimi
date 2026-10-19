/**
 * 输出段：ToneMap + Encode 两段（替掉 three 的 OutputPass）。
 *
 * 为什么拆（文档 §3.5(5)）：`OutputPass` 把**色调映射**与**sRGB 编码**焊在同一个
 * shader 里，而这两件事之间正是「颗粒、暗角、色差、扫描线」该在的位置
 * （UE 的 Blendable Location 也是这么分的）。拆开之后 `afterTonemap` 锚点才存在。
 *
 * 实现纪律：
 *   ① 复用 three 的 `tonemapping_pars_fragment` / `colorspace_pars_fragment`，
 *      **不手写 pow(1/2.2)**——否则暗部会和场景里其它材质对不上；
 *   ② defines 按 renderer 的实时设置来（和 OutputPass 一样在 render 里比对更新）；
 *   ③ ToneMap 用 NoBlending：它读的是线性 HDR、写的是「显示参考但未编码」的中间结果，
 *      这一步不能和缓冲里的旧内容做 alpha 合成，否则半透明像素会被预乘两次。
 *      Encode 保持默认 NormalBlending——它才是最终写屏那一步，预乘在这里发生一次。
 *
 * 像素等价性：默认链（scene → bloom → grade → tonemap → encode）与旧
 * OutputPass 逐像素一致（P1 验收项）。
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

const TONE_MAP_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;

#include <tonemapping_pars_fragment>

varying vec2 vUv;

void main() {
	gl_FragColor = texture2D( tDiffuse, vUv );

	#ifdef LINEAR_TONE_MAPPING
		gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
	#elif defined( REINHARD_TONE_MAPPING )
		gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
	#elif defined( CINEON_TONE_MAPPING )
		gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
	#elif defined( ACES_FILMIC_TONE_MAPPING )
		gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
	#elif defined( AGX_TONE_MAPPING )
		gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
	#elif defined( NEUTRAL_TONE_MAPPING )
		gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
	#elif defined( CUSTOM_TONE_MAPPING )
		gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
	#endif
}
`;

const ENCODE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;

#include <colorspace_pars_fragment>

varying vec2 vUv;

void main() {
	gl_FragColor = texture2D( tDiffuse, vUv );

	#ifdef SRGB_TRANSFER
		gl_FragColor = sRGBTransferOETF( gl_FragColor );
	#endif
}
`;

function toneMappingDefine(toneMapping: THREE.ToneMapping): string | null {
  switch (toneMapping) {
    case THREE.LinearToneMapping: return 'LINEAR_TONE_MAPPING';
    case THREE.ReinhardToneMapping: return 'REINHARD_TONE_MAPPING';
    case THREE.CineonToneMapping: return 'CINEON_TONE_MAPPING';
    case THREE.ACESFilmicToneMapping: return 'ACES_FILMIC_TONE_MAPPING';
    case THREE.AgXToneMapping: return 'AGX_TONE_MAPPING';
    case THREE.NeutralToneMapping: return 'NEUTRAL_TONE_MAPPING';
    case THREE.CustomToneMapping: return 'CUSTOM_TONE_MAPPING';
    default: return null;
  }
}

/** 线性 HDR → 显示参考（已 tone map、**未编码**） */
export class ToneMapPass extends Pass {
  readonly material: THREE.RawShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly quad: FullScreenQuad;
  private toneMapping: THREE.ToneMapping | null = null;

  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      toneMappingExposure: { value: 1 },
    };
    this.material = new THREE.RawShaderMaterial({
      name: 'ToneMapPass',
      uniforms: this.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: TONE_MAP_FRAG,
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
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;

    if (this.toneMapping !== renderer.toneMapping) {
      this.toneMapping = renderer.toneMapping;
      const define = toneMappingDefine(this.toneMapping);
      this.material.defines = define ? { [define]: '' } : {};
      this.material.needsUpdate = true;
    }

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.quad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

/** 显示参考 → 编码到输出色彩空间（最终写屏） */
export class EncodePass extends Pass {
  readonly material: THREE.RawShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly quad: FullScreenQuad;
  private colorSpace: string | null = null;

  constructor() {
    super();
    this.uniforms = { tDiffuse: { value: null } };
    this.material = new THREE.RawShaderMaterial({
      name: 'EncodePass',
      uniforms: this.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: ENCODE_FRAG,
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

    if (this.colorSpace !== renderer.outputColorSpace) {
      this.colorSpace = renderer.outputColorSpace;
      const srgb =
        THREE.ColorManagement.getTransfer(this.colorSpace as THREE.ColorSpace) === THREE.SRGBTransfer;
      this.material.defines = srgb ? { SRGB_TRANSFER: '' } : {};
      this.material.needsUpdate = true;
    }

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.quad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export function createToneMapPass(): ToneMapPass {
  return new ToneMapPass();
}

export function createEncodePass(): EncodePass {
  return new EncodePass();
}
