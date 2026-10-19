/**
 * 着色扩展层的无 GPU 检查（转换期 / CI 用）。
 *
 * 为什么要有这个脚本：GLSL **没有编译期**。模块 id 打错、锚点被 three 换名、
 * 变体键里混进随机量——这三类问题在浏览器里表现为「画面看起来还行」或
 * 「偶发编译失败」，不会在构建时拦住任何人。
 *
 * 检查项：
 *   ① 锚点表 vs three 当前版本的真实 chunk（升级 three 时第一时间报警）
 *   ② 注入守卫：缺 chunk 必须抛错，不静默
 *   ③ 变体键：同模块集稳定、加模块必变、顺序敏感（写在文档里的约定）
 *   ④ ParamBus：重复 declare 返回同一对象；同帧换写入者被拒
 *   ⑤ 契约里的 shader.modules：每个 id 都必须在注册表里（扫描真实 GLB）
 *   ⑥ 层 B：defineMaterial 自动声明 uniform、本地参数不共享
 *
 * 跑法：`npm run check:render-modules`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

/** GLB：magic(4) version(4) length(4) + chunk(length, type, data) */
function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file} 不是 GLB`);
  const chunkLength = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  assert.equal(chunkType, 0x4e4f534a, `${file} 的第一个 chunk 不是 JSON`);
  return JSON.parse(buf.subarray(20, 20 + chunkLength).toString('utf8'));
}

/** 从一份 glTF JSON 里收出所有 charter.shader.modules（模型级 + 材质级） */
function collectShaderDeclarations(json) {
  const found = [];
  for (const scene of json.scenes ?? []) {
    const ids = scene?.extras?.charter?.shader?.modules;
    if (Array.isArray(ids)) found.push({ where: `scene:${scene.name ?? '?'}`, ids });
  }
  for (const mat of json.materials ?? []) {
    const ids = mat?.extras?.charter?.shader?.modules;
    if (Array.isArray(ids)) found.push({ where: `material:${mat.name ?? '?'}`, ids });
  }
  return found;
}

try {
  const THREE = await import('three');
  const anchors = await server.ssrLoadModule('/src/shader/anchors.ts');
  const shaderModule = await server.ssrLoadModule('/src/shader/module.ts');
  const paramsMod = await server.ssrLoadModule('/src/shader/params.ts');
  const defineMod = await server.ssrLoadModule('/src/shader/define.ts');
  // 导入扩展层出口 = 触发内建 NPR 模块注册（模块文件在 import 时 registerModule）
  await server.ssrLoadModule('/src/shader/index.ts');

  // ---- ① 锚点 vs three 真实 chunk ----
  const physical = THREE.ShaderLib.physical;
  assert.ok(physical, 'three 里没有 ShaderLib.physical');
  for (const [anchor, spec] of Object.entries(anchors.FRAG_ANCHORS)) {
    assert.ok(
      physical.fragmentShader.includes(spec.chunk),
      `锚点「${anchor}」在 three ${THREE.REVISION} 的 physical.fragmentShader 里找不到：${spec.chunk}`,
    );
  }
  for (const [anchor, spec] of Object.entries(anchors.VERT_ANCHORS)) {
    assert.ok(
      physical.vertexShader.includes(spec.chunk),
      `顶点锚点「${anchor}」在 three ${THREE.REVISION} 的 physical.vertexShader 里找不到：${spec.chunk}`,
    );
  }

  // ---- ② 注入守卫：缺 chunk 抛错 ----
  assert.throws(
    () => anchors.injectAt('void main() {}\n', { chunk: '#include <opaque_fragment>', at: 'before' }, 'x', {
      moduleId: 'demo', anchor: 'beforeOutput', revision: THREE.REVISION,
    }),
    /锚点「beforeOutput」缺失/,
  );

  // ---- ③ 变体键 ----
  const { getModule, listModules, orderModules, variantKey } = shaderModule;
  const basis = getModule('npr-basis');
  const ramp = getModule('npr-ramp');
  assert.ok(basis && ramp, '内建 NPR 模块没有注册');
  const keyA = variantKey('standard', orderModules([basis, ramp]));
  const keyB = variantKey('standard', orderModules([basis, ramp]));
  assert.equal(keyA, keyB, '同模块集必须得到同一个变体键');
  assert.notEqual(keyA, variantKey('standard', orderModules([ramp, basis])), '顺序敏感：拼接顺序不同 = 不同变体');
  assert.notEqual(keyA, variantKey('standard', orderModules([basis, ramp, getModule('dissolve')])));

  // 拓扑排序：rim-pulse 必须落在 commit 之前
  const ordered = orderModules([getModule('npr-commit'), getModule('rim-pulse'), basis, ramp]);
  assert.ok(
    ordered.indexOf(getModule('rim-pulse')) < ordered.indexOf(getModule('npr-commit')),
    'before/after 约束没生效',
  );

  // ---- ④ ParamBus ----
  const notices = [];
  const bus = paramsMod.createParamBus({
    notices: {
      emit: (n) => notices.push(n),
      warn: (code, message, extra) => notices.push({ code, level: 'warn', message, ...extra }),
      error: (code, message, extra) => notices.push({ code, level: 'error', message, ...extra }),
      on: () => () => {},
      log: [],
      clear: () => {},
    },
  });
  const u1 = bus.declare('uTest', 1);
  const u2 = bus.declare('uTest', 99);
  assert.equal(u1, u2, '重复 declare 必须返回同一个 IUniform（共享引用是整套体系的前提）');
  assert.equal(u1.value, 1, '重复 declare 不能覆盖已有值');

  bus.tick({ time: 1, delta: 0.016, frame: 1, animTime: 1, width: 100, height: 100, dpr: 1, camera: { getWorldPosition: (v) => v, getWorldDirection: (v) => v }, renderer: null });
  assert.ok(bus.set('uTest', 2, 'a'));
  assert.equal(bus.set('uTest', 3, 'b'), false, '同帧换写入者必须被拒绝');
  assert.ok(notices.some((n) => n.code === 'param-conflict'));

  // ---- ⑤ 契约里的模块 id ----
  const registered = new Set(listModules().map((m) => m.id));
  assert.ok(registered.has('dissolve') && registered.has('rim-pulse'), '内容侧示例模块没有注册');
  // 校验器自测：用一份 fixture 证明「声明能收出来、未知 id 会抛」。
  // 真实 GLB 的声明在下面的 ⑤c 与 charter-rules 逐条对齐，不靠这份 fixture。
  const fixture = {
    scenes: [{ name: 'fixture', extras: { charter: { shader: { modules: ['dissolve', 'rim-pulse@1'] } } } }],
    materials: [{ name: 'hair', extras: { charter: { shader: { modules: ['npr-rim'] } } } }],
  };
  const fixtureDecls = collectShaderDeclarations(fixture);
  assert.equal(fixtureDecls.length, 2, '模型级与材质级声明都要收出来');
  const unknown = fixtureDecls.flatMap((d) => d.ids).filter((id) => !registered.has(id.split('@')[0]));
  assert.deepEqual(unknown, [], 'fixture 的模块 id 应该全在注册表里');
  assert.throws(() => {
    const bad = { scenes: [{ extras: { charter: { shader: { modules: ['no-such-module'] } } } }] };
    for (const { ids } of collectShaderDeclarations(bad)) {
      for (const id of ids) {
        if (!registered.has(id.split('@')[0])) throw new Error(`未注册的着色模块「${id}」`);
      }
    }
  }, /未注册的着色模块/);

  const modelsDir = path.join(process.cwd(), 'assets', 'models');
  const glbs = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.glb') && !f.includes('.bak'));
  let declared = 0;
  for (const file of glbs) {
    const json = readGlbJson(path.join(modelsDir, file));
    for (const { where, ids } of collectShaderDeclarations(json)) {
      declared += ids.length;
      for (const id of ids) {
        const [name] = id.split('@');
        assert.ok(registered.has(name), `${file} 的 ${where} 声明了未注册的着色模块「${id}」`);
      }
    }
  }

  // ---- ⑤b 生产端表（charter-rules）vs 引擎注册表 ----
  // 这两张表天然会漂移（一张在 pipeline/ 的纯 JS，一张在 src/ 的 TS 模块），
  // 而漂移的表现是「资产声明了一个引擎没有的模块」→ 运行期静默跳过。
  // 所以这里做三向对齐：id 集合、version、参数表。
  const rules = await import('./charter-rules.mjs');
  const engineIds = new Set([...registered]);
  for (const [id, spec] of Object.entries(rules.SHADER_MODULES)) {
    const mod = getModule(id);
    assert.ok(mod, `charter-rules 的 SHADER_MODULES 有「${id}」，但引擎没注册（转换期会放行一个死引用）`);
    assert.equal(spec.version, mod.version, `「${id}」版本不一致：契约 v${spec.version} / 引擎 v${mod.version}`);
    const engineParams = (mod.params ?? []).map((p) => p.id).sort();
    assert.deepEqual(
      [...spec.params].sort(),
      engineParams,
      `「${id}」的参数表不一致：契约 [${spec.params}] / 引擎 [${engineParams}]`,
    );
    // 纯数据：转换期与 CI 都在 Node 里直接 import 它，出现 three 依赖就整条链崩
    for (const anchor of ['frag', 'vert']) {
      for (const [k, v] of Object.entries(mod[anchor] ?? {})) {
        assert.equal(typeof v, 'string', `「${id}」的 ${anchor}.${k} 不是字符串`);
      }
    }
    const file = path.join(process.cwd(), 'src', 'shader', 'modules', `${id}.ts`);
    if (fs.existsSync(file)) {
      const srcText = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"]three['"]/.test(srcText),
        `模块文件 ${path.relative(process.cwd(), file)} 引入了 three——转换期 import 会失败`,
      );
    }
  }
  // 合并语义：模型级 → 族级 → 材质级，去重且保序
  const yelanHair = rules.resolveShader('yelan', 'hair', '髮');
  assert.deepEqual(
    yelanHair.ids.map((x) => x.split('@')[0]),
    ['dissolve', 'rim-pulse'],
    '契约合并顺序必须是 模型级 → 族级',
  );
  assert.deepEqual(rules.resolveShader('yelan', 'cloth', '体').ids, ['dissolve@1'], '族级模块不该漏到别的族');
  assert.deepEqual(rules.resolveShader('nobody', 'hair', '髮').ids, [], '未登记的模型不该有声明');

  // ---- ⑤c 真实 GLB 的声明必须与 charter-rules 的裁定逐条一致 ----
  let crossChecked = 0;
  for (const file of glbs) {
    if (!file.endsWith('.charter.glb')) continue;
    const modelId = path.basename(file, '.charter.glb');
    const json = readGlbJson(path.join(modelsDir, file));
    const sceneIds = (json.scenes?.[0]?.extras?.charter?.shader?.modules ?? []).map((x) => String(x).split('@')[0]);
    const modelIds = (rules.MODELS[modelId]?.shader?.modules ?? []).map((x) => String(x).split('@')[0]);
    assert.deepEqual(sceneIds, modelIds, `${file} 的模型级 shader 与 charter-rules 不一致`);
    for (const mat of json.materials ?? []) {
      const charter = mat?.extras?.charter;
      if (!charter?.role) continue;
      const got = (charter.shader?.modules ?? []).map((x) => String(x).split('@')[0]);
      const want = rules.resolveShader(modelId, charter.role, charter.srcName ?? mat.name ?? '').ids
        .map((x) => String(x).split('@')[0]);
      assert.deepEqual(got, want, `${file} 的材质「${mat.name}」shader 与裁定不一致`);
      crossChecked++;
    }
  }

  // ---- ⑥ 层 B ----
  const mat = defineMod.defineMaterial({
    id: 'check/mat',
    builtins: ['time'],
    params: [
      { id: 'uLocalA', type: 'float' },
      { id: 'uLocalB', type: 'color' },
    ],
    local: ['uLocalA', 'uLocalB'],
    values: { uLocalA: 0.5, uLocalB: new THREE.Color(0x112233) },
    vert: 'void main() { gl_Position = vec4(position, 1.0); }',
    frag: 'void main() { gl_FragColor = vec4(uLocalB, uLocalA); }',
  }, { params: bus });
  assert.match(mat.fragmentShader, /uniform float uLocalA;/);
  assert.match(mat.fragmentShader, /uniform vec3 uLocalB;/);
  assert.equal(mat.uniforms.uTime, bus.get('uTime'), '内建 uTime 必须与总线是同一个对象');
  assert.notEqual(mat.uniforms.uLocalA, bus.get('uLocalA'), 'local 参数不能进总线');
  const mat2 = defineMod.defineMaterial({
    id: 'check/mat2',
    params: [{ id: 'uLocalA', type: 'float' }],
    local: ['uLocalA'],
    vert: mat.vertexShader,
    frag: 'void main() { gl_FragColor = vec4(uLocalA); }',
  }, { params: bus });
  assert.notEqual(mat2.uniforms.uLocalA, mat.uniforms.uLocalA, '两个实例的 local 参数必须各自独立');
  const versionBefore = mat.version;
  assert.equal(defineMod.patchMaterialSource(mat, { frag: 'void main() { gl_FragColor = vec4(1.0); }' }), true);
  assert.ok(mat.version > versionBefore, '换源码后必须触发重编译（needsUpdate）');
  assert.equal(defineMod.definedMaterialMeta(mat)?.id, 'check/mat');

  const shapes = Object.fromEntries([...registered].map((id) => {
    const m = getModule(id);
    return [id, {
      frag: Object.keys(m.frag ?? {}),
      vert: Object.keys(m.vert ?? {}),
      params: (m.params ?? []).map((p) => `${p.id}:${p.type}`),
    }];
  }));

  console.log('着色扩展检查通过：');
  console.log(`  three ${THREE.REVISION} 锚点 ${Object.keys(anchors.FRAG_ANCHORS).length} 个全部命中`);
  console.log(`  注入守卫 / 变体键 / 拓扑排序 / ParamBus 审计 / 层 B 全程 OK`);
  console.log(`  扫描 ${glbs.length} 个 GLB，契约声明 ${declared} 个模块引用（0 个未知；校验器已用 fixture 自测）`);
  console.log(`  生产端 ${Object.keys(rules.SHADER_MODULES).length} 个模块与引擎注册表逐项对齐`
    + `（id / 版本 / 参数表 / 纯数据），${crossChecked} 条材质声明与裁定一致`);
  console.log(`  注册表 ${registered.size} 个模块：${[...registered].join(', ')}`);
  void shapes;
} finally {
  await server.close();
}
