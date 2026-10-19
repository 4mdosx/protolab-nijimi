/** 无 GPU 的角色着色契约检查；实际着色器编译另由浏览器验证。 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { prepareCharacterRendering, discardPreparedCharacter } = await server.ssrLoadModule('/src/character-rendering.ts');
  const { createNprUniforms, toNprMaterial } = await server.ssrLoadModule('/src/npr.ts');
  const face = new THREE.MeshStandardMaterial();
  face.userData.charter = { role: 'face', track: 'npr', srcName: 'face', faceGlow: 0.55 };
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), face);
  root.add(mesh);
  let loads = 0;
  const missing = await prepareCharacterRendering({ group: root, charter: null }, createNprUniforms(), {
    loadTexture: async () => { loads++; throw new Error('must not load'); },
  });
  assert.equal(missing.faceSdf.status, 'absent');
  assert.equal(loads, 0);
  const converted = missing.createMaterial(face);
  assert.deepEqual(converted.userData.charter, face.userData.charter);
  assert.equal(converted.defines.NPR_HAS_FACE_SDF, undefined);
  assert.equal(mesh.receiveShadow, false);
  assert.equal(face.defines?.NPR_IS_FACE, undefined, 'original stays unmodified');
  missing.apply();
  const applied = mesh.material;
  missing.apply();
  assert.equal(mesh.material, applied, 'apply is idempotent');

  const texture = new THREE.Texture();
  let releases = 0;
  texture.addEventListener('dispose', () => releases++);
  const ready = await prepareCharacterRendering({ group: root, charter: { id: 'test', faceSdf: 'test.png' } }, createNprUniforms(), {
    loadTexture: async (url) => { assert.equal(url, '/models/test.png'); return texture; },
  });
  assert.equal(ready.faceSdf.status, 'ready');
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  const sdfMaterial = ready.createMaterial(face);
  assert.equal(sdfMaterial.defines.NPR_HAS_FACE_SDF, '');
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <worldpos_vertex>', fragmentShader: '#include <common>\n#include <opaque_fragment>' };
  sdfMaterial.onBeforeCompile(shader, null);
  assert.equal(shader.uniforms.uNprSdfMap.value, texture, 'SDF variant binds its sampler');
  ready.dispose();
  ready.dispose();
  assert.equal(releases, 1);
  assert.throws(() => ready.apply(), /已释放/);

  const failure = new Error('404');
  const warn = console.warn;
  let warned = false;
  let failed;
  try {
    console.warn = () => { warned = true; };
    failed = await prepareCharacterRendering({ group: root, charter: { id: 'test', faceSdf: 'missing.png' } }, createNprUniforms(), {
      loadTexture: async () => { throw failure; },
    });
  } finally { console.warn = warn; }
  assert.ok(warned);
  assert.equal(failed.faceSdf.status, 'failed');
  assert.equal(failed.faceSdf.error, failure);
  assert.equal(failed.createMaterial(face).defines.NPR_HAS_FACE_SDF, undefined);

  for (const [role, track] of [['eye', 'unlit'], ['outline', 'outline'], ['skin', 'pbr'], ['hair', 'npr']]) {
    const source = new THREE.MeshStandardMaterial();
    source.userData.charter = { role, track, srcName: role };
    const result = toNprMaterial(source, createNprUniforms());
    assert.deepEqual(result.userData.charter, source.userData.charter, `${role} preserves charter`);
  }
  discardPreparedCharacter({ group: root }, failed);
  missing.dispose();
  console.log('角色着色检查通过：SDF 缺省/成功/失败、采样器绑定、契约保留、原材质对照、重复应用及释放。');
} finally {
  await server.close();
}
