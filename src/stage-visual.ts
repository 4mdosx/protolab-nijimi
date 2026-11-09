/** Three.js 适配只留在这里；数据契约和校验不依赖渲染器。 */
import type * as THREE from 'three';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { PostChain } from './post';
import { createVisualPresetController } from './visual-preset';

interface Bindings {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  moon: THREE.DirectionalLight;
  fill: THREE.PointLight;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  post: PostChain;
  getNpr(): boolean;
  setNpr(on: boolean): void;
}
export function bindStageVisual(b: Bindings) {
  const readLight = (l: THREE.Light) => ({ color: `#${l.color.getHexString()}`, intensity: l.intensity, position: l.position.toArray() as [number, number, number] });
  const writeLight = (l: THREE.Light, p: ReturnType<typeof readLight>) => {
    l.color.set(p.color); l.intensity = p.intensity; l.position.fromArray(p.position);
  };
  const u = b.grade.uniforms;
  return createVisualPresetController(() => ({
    version: 1, exposure: b.renderer.toneMappingExposure, npr: b.getNpr(), environmentIntensity: b.scene.environmentIntensity,
    lights: {
      hemi: { color: `#${b.hemi.color.getHexString()}`, groundColor: `#${b.hemi.groundColor.getHexString()}`, intensity: b.hemi.intensity },
      ambient: { color: `#${b.ambient.color.getHexString()}`, intensity: b.ambient.intensity },
      key: { ...readLight(b.key), target: b.key.target.position.toArray() as [number, number, number] },
      moon: readLight(b.moon), fill: readLight(b.fill),
    },
    bloom: { enabled: b.post.isEnabled('bloom'), strength: b.bloom.strength, radius: b.bloom.radius, threshold: b.bloom.threshold },
    grade: {
      vignette: u.uVignette.value, vignettePower: u.uVignettePower.value, strength: u.uSplit.value,
      saturation: u.uSaturation.value, contrast: u.uContrast.value,
      shadowTint: `#${u.uShadowTint.value.getHexString()}`, highlightTint: `#${u.uHighlightTint.value.getHexString()}`,
    },
  }), (p) => {
    b.renderer.toneMappingExposure = p.exposure;
    b.setNpr(p.npr);
    // setNpr 的旧默认行为会改环境强度；显式预设最后覆盖它。
    b.scene.environmentIntensity = p.environmentIntensity;
    b.hemi.color.set(p.lights.hemi.color); b.hemi.groundColor.set(p.lights.hemi.groundColor); b.hemi.intensity = p.lights.hemi.intensity;
    b.ambient.color.set(p.lights.ambient.color); b.ambient.intensity = p.lights.ambient.intensity;
    writeLight(b.key, p.lights.key); b.key.target.position.fromArray(p.lights.key.target);
    writeLight(b.moon, p.lights.moon); writeLight(b.fill, p.lights.fill);
    b.post.setEnabled('bloom', p.bloom.enabled);
    b.bloom.strength = p.bloom.strength; b.bloom.radius = p.bloom.radius; b.bloom.threshold = p.bloom.threshold;
    u.uVignette.value = p.grade.vignette; u.uVignettePower.value = p.grade.vignettePower;
    u.uSplit.value = p.grade.strength; u.uSaturation.value = p.grade.saturation; u.uContrast.value = p.grade.contrast;
    u.uShadowTint.value.set(p.grade.shadowTint); u.uHighlightTint.value.set(p.grade.highlightTint);
  });
}
