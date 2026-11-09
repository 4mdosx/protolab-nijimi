/** 数据边界与真实 Three.js 灯光适配检查；无需 GPU，编译/交互另由浏览器验收。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { parseVisualPreset } = await server.ssrLoadModule('/src/visual-preset.ts');
  const { bindStageVisual } = await server.ssrLoadModule('/src/stage-visual.ts');
  const { createGradePass } = await server.ssrLoadModule('/src/npr.ts');
  const lights = {
    hemi: new THREE.HemisphereLight(0x565a8a, 0x241d2e, 0.5),
    ambient: new THREE.AmbientLight(0x3a3355, 0.55),
    key: new THREE.DirectionalLight(0xffc890, 1.35),
    moon: new THREE.DirectionalLight(0xb8cce8, 0.55),
    fill: new THREE.PointLight(0xffd9a0, 6),
  };
  lights.key.position.set(-3.5, 5.5, 2.6);
  const scene = new THREE.Scene(); scene.environmentIntensity = 0.6;
  const renderer = { toneMappingExposure: 1.3 };
  const bloom = { strength: 0.62, radius: 0.55, threshold: 0.74 };
  const grade = createGradePass();
  let bloomEnabled = true, npr = true;
  const visual = bindStageVisual({
    ...lights, renderer, scene, bloom, grade,
    post: { isEnabled: () => bloomEnabled, setEnabled: (_, on) => { bloomEnabled = on; } },
    getNpr: () => npr,
    setNpr: on => { npr = on; scene.environmentIntensity = on ? 0.6 : 0; },
  });
  const defaults = visual.capture();
  const preset = structuredClone(defaults);
  preset.exposure = 2.15; preset.npr = false; preset.environmentIntensity = 0.23;
  preset.lights.key.color = '#aabbcc'; preset.lights.key.intensity = 2.3;
  preset.lights.key.position = [1, 2, 3]; preset.lights.key.target = [-1, 0.4, 0];
  preset.lights.hemi.groundColor = '#120034'; preset.lights.ambient.intensity = 0.17;
  preset.bloom = { enabled: false, strength: 0.8, radius: 0.2, threshold: 1.4 };
  preset.grade.contrast = 1.2; preset.grade.shadowTint = '#336699';
  const json = JSON.stringify(preset);
  visual.apply(JSON.parse(json));
  assert.deepEqual(visual.capture(), preset, 'every field survives the real light/uniform adapter');
  assert.equal(renderer.toneMappingExposure, 2.15);
  assert.equal(scene.environmentIntensity, 0.23, 'explicit IBL survives NPR toggle');
  assert.equal(grade.uniforms.uContrast.value, 1.2);
  assert.equal(lights.key.color.getHexString(), 'aabbcc', 'sRGB hex round-trip');
  preset.lights.key.position[0] = 88;
  assert.equal(lights.key.position.x, 1, 'input arrays are not retained');
  const captured = visual.capture(); captured.lights.key.position[0] = 99;
  assert.equal(visual.capture().lights.key.position[0], 1, 'capture is independent');
  const valid = JSON.parse(json);
  const invalid = [null, [], { ...valid, version: 2 }, { ...valid, exposure: NaN },
    { ...valid, exposure: -1 }, { ...valid, npr: 'false' }, { ...valid, surprise: true },
    { ...valid, lights: { ...valid.lights, key: { ...valid.lights.key, position: [1, Infinity, 3] } } },
    { ...valid, lights: { ...valid.lights, ambient: { ...valid.lights.ambient, color: 'red' } } },
    { ...valid, bloom: { ...valid.bloom, enabled: 0 } },
    { ...valid, grade: { ...valid.grade, vignette: 2 } },
    { ...valid, grade: { ...valid.grade, highlightTint: '#nope' } }];
  const missing = structuredClone(valid); delete missing.grade.contrast; invalid.push(missing);
  for (const bad of invalid) {
    const before = visual.capture();
    assert.throws(() => visual.apply(bad));
    assert.deepEqual(visual.capture(), before, 'invalid input must not partially change stage');
  }
  visual.reset(); assert.deepEqual(visual.capture(), defaults, 'reset restores startup defaults');
  visual.apply(valid); visual.reset(); assert.deepEqual(visual.capture(), defaults, 'defaults stay immutable');
  assert.equal(parseVisualPreset({ ...valid, lights: { ...valid.lights, ambient: { color: '#ABCDEF', intensity: 0 } } }).lights.ambient.color, '#abcdef');
  grade.dispose();
  console.log('视觉预设检查通过：真实灯光/调色往返、IBL 与 NPR、独立快照、非法数据原子拒绝、默认恢复。');
} finally { await server.close(); }
