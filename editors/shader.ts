/**
 * GLSL 工作台 —— 层 B（`defineMaterial`）的实时着色器编辑台。
 *
 * 它验的是 P3 剩下的两件能力：
 *   ① `patchMaterialSource()` 热改源码 → `needsUpdate` → 重编译（不重建材质、不丢 uniform）；
 *   ② `renderer.debug.onShaderError` 把编译/链接错误接住，显示在面板里而不是只刷控制台。
 *
 * 为什么值得一个单独的编辑器：GLSL **没有编译期**。模块 id 写错、锚点被 three 改名、
 * 少写一个分号——这些在浏览器里表现为「画面黑了」或「看起来还行」，没有堆栈。
 * 这个台子把「改一行 → 立刻看到 / 立刻知道哪行错」的循环缩到一次按键。
 *
 * 三个刻意的设计：
 *   - **参数表即滑杆**：滑杆不是手写的，是从 `definedMaterialMeta(mat).declared` 生成的。
 *     加一个参数只改 spec，面板自己长出来（`integrated` 的着色面板同理）。
 *   - **自动声明可见**：`uniform` 行是引擎按参数表生成的，面板把它摊开给作者看，
 *     省掉「我明明写了 uSpin 为什么是 undeclared」这类来回（层 B 最容易踩的一脚）。
 *   - **回退上一版**：编译失败时画面就没了，所以保留最近一次编译成功的源码。
 */

import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { createPostChain } from '../src/post';
import { createEncodePass, createToneMapPass } from '../src/output-passes';
import { createNoticeSink } from '../src/notice';
import { createFrameClock } from '../src/frame';
import { createParamBus, isBuiltinParam } from '../src/shader/params';
import { GLSL_TYPE, type ParamType } from '../src/shader/module';
import {
  defineMesh,
  definedMaterialMeta,
  patchMaterialSource,
  type MaterialSpec,
} from '../src/shader/define';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $('viewport');

/* ------------------------------------------------------------------ *
 * 渲染基础：和舞台同一套（链 + 输出段），只是没有内容包与人物
 * ------------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// 清屏色用**纯黑**：`setClearColor` 不做 sRGB → 线性的换算，而画面其余部分
// 要过 tonemap + encode 两段，两者对不上就会在「地平线」处裂出一条亮带。
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
camera.position.set(0.2, 2.3, 4.4);
camera.lookAt(0.12, 0.82, 0);

const notices = createNoticeSink();
const params = createParamBus({ notices });
const clock = createFrameClock(renderer, camera);

const post = createPostChain(renderer, {
  width: Math.max(1, container.clientWidth),
  height: Math.max(1, container.clientHeight),
  samples: 4,
  type: THREE.HalfFloatType,
  params,
  notices,
});
post.add(new RenderPass(scene, camera), { id: 'scene', anchor: 'scene', priority: 0, locked: true });
post.add(createToneMapPass(), { id: 'tonemap', anchor: 'tonemap', priority: 0, locked: true, internal: true });
post.add(createEncodePass(), { id: 'encode', anchor: 'encode', priority: 0, locked: true, internal: true });

// 地面：让加色几何有东西可「压」在下面（纯黑底看不出光落在地上）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshBasicMaterial({ color: 0x121019 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
scene.add(ground);

/* ------------------------------------------------------------------ *
 * 两个层 B 样例
 * ------------------------------------------------------------------ */

const RUNE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const RUNE_FRAG = /* glsl */ `
// ShaderMaterial 不会替我们声明 varying —— 顶点里写了什么，这里要再写一遍。
// （漏了的表现是「vUv 未声明」，而且报错行号会飘到文件末尾，很难猜。）
varying vec2 vUv;

float ring( float radius, float at, float w ) {
  return smoothstep( w, 0.0, abs( radius - at ) );
}

void main() {
  // 法阵：极坐标环 + 旋转刻度 + 内侧三角。uTime 由 ParamBus 供（真实 dt，不是动画步长）。
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  float ang = atan( p.y, p.x );

  vec3 col = vec3( 0.0 );
  // 外环（粗）与内环（细）
  col += uRuneColor * ring( r, 0.91, 0.014 ) * 2.2;
  col += uRuneColor * ring( r, 0.63, 0.008 ) * 1.3;
  // 24 根刻度：只活在两环之间
  float ticks = abs( fract( ( ang + uTime * uSpin ) / 6.2831853 * 24.0 ) - 0.5 );
  col += uRuneColor * smoothstep( 0.44, 0.5, ticks ) * step( 0.63, r ) * step( r, 0.91 ) * 1.6;
  // 内侧逆时针三角
  float a2 = ang - uTime * uSpin * 0.55;
  float tri = abs( mod( a2, 2.0943951 ) - 1.0471976 );
  col += uRuneColor * smoothstep( 0.62, 0.0, r ) * smoothstep( 0.6, 0.44, tri ) * 0.7;
  // 中心光斑 + 呼吸
  col += uRuneColor * smoothstep( 0.16, 0.0, r ) * 0.5;

  gl_FragColor = vec4( col * uPulse, 1.0 );
}
`;

const ORB_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vUv = uv;
  // 世界空间法线：normalMatrix 是「模型 → 视图」的，跟世界空间的 cameraPosition
  // 相减再点乘会得到无意义的数（第一版就是这么写的，整根柱子糊成一块橙）。
  vNormal = normalize( mat3( modelMatrix ) * normal );
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const ORB_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorld;

// 能量体：菲涅尔边缘（越到轮廓越亮）+ 沿世界 Y 缓慢流动的能量带 + 一点底光。
// cameraPosition 是 three 给 ShaderMaterial 的内建 uniform，不用自己声明。
void main() {
  vec3 viewDir = normalize( cameraPosition - vWorld );
  float fres = 1.0 - abs( dot( normalize( vNormal ), viewDir ) );
  float rim = pow( fres, uFresPower );
  float band = 0.5 + 0.5 * sin( ( vWorld.y * uBands - uTime * uSpeed ) * 6.2831853 );
  vec3 col = uTint * ( rim * 2.1 + 0.03 ) * ( 0.62 + 0.38 * band ) * uStrength;
  gl_FragColor = vec4( col, 1.0 );
}
`;

interface Sample {
  key: string;
  label: string;
  spec: MaterialSpec;
  /** 滑杆范围（没写的参数用 [0, 2, 0.01] 兜底） */
  ranges: Record<string, [number, number, number]>;
}

const SAMPLES: Sample[] = [
  {
    key: 'rune',
    label: '法阵',
    spec: {
      id: 'demo/rune',
      name: '法阵',
      queue: 'effect',
      blending: 'additive',
      depth: { test: true, write: false },
      builtins: ['time'],
      params: [
        { id: 'uRuneColor', type: 'color', label: '法阵颜色' },
        { id: 'uSpin', type: 'float', label: '旋转速度' },
        { id: 'uPulse', type: 'float', label: '亮度' },
      ],
      values: { uRuneColor: new THREE.Color(0x53d9ff), uSpin: 0.14, uPulse: 1 },
      vert: RUNE_VERT,
      frag: RUNE_FRAG,
    },
    ranges: { uSpin: [-1.2, 1.2, 0.01], uPulse: [0, 3, 0.01] },
  },
  {
    key: 'orb',
    label: '能量体',
    spec: {
      id: 'demo/orb',
      name: '能量体',
      queue: 'effect',
      blending: 'additive',
      depth: { test: true, write: false },
      // 加色 + 双面 = 正反两层都加一遍，体积会糊成一块实心色。
      // 能量体只需要看外侧（FrontSide 是默认值，写出来当注释，别手滑改成 DoubleSide）。
      side: THREE.FrontSide,
      builtins: ['time'],
      params: [
        { id: 'uTint', type: 'color', label: '能量颜色' },
        { id: 'uStrength', type: 'float', label: '强度' },
        { id: 'uSpeed', type: 'float', label: '流动速度' },
        { id: 'uBands', type: 'float', label: '条纹数' },
        { id: 'uFresPower', type: 'float', label: '边缘锐度' },
      ],
      values: {
        uTint: new THREE.Color(0xffb463), uStrength: 0.62, uSpeed: 0.22, uBands: 3, uFresPower: 2.4,
      },
      vert: ORB_VERT,
      frag: ORB_FRAG,
    },
    ranges: {
      uStrength: [0, 2, 0.01], uSpeed: [-1, 1, 0.01], uBands: [0.5, 12, 0.1], uFresPower: [0.4, 6, 0.05],
    },
  },
];

interface Slot {
  sample: Sample;
  mesh: THREE.Mesh;
  material: THREE.Material;
  /** 工作副本（切 tab 不丢未应用的改动） */
  current: { frag: string; vert: string };
  /** 最近一次编译成功的源码（失败时回退用） */
  lastGood: { frag: string; vert: string };
}

const slots: Slot[] = SAMPLES.map((sample) => {
  const geometry = sample.key === 'rune'
    ? new THREE.PlaneGeometry(3.0, 3.0)
    : new THREE.IcosahedronGeometry(0.52, 4);
  // defineMesh 会按 spec.queue 设语义队列（不裸写 renderOrder）
  const mesh = defineMesh(geometry, sample.spec, { params, notices });
  if (sample.key === 'rune') {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0.42, 0.004, 0.05);
  } else {
    mesh.position.set(0.95, 1.32, -0.75);
  }
  scene.add(mesh);
  const material = mesh.material as THREE.Material;
  const src = { frag: sample.spec.frag, vert: sample.spec.vert };
  return { sample, mesh, material, current: { ...src }, lastGood: { ...src } };
});

/**
 * 编译失败时的占位材质。
 * 不为「显示错误」而为「别再每帧拿坏 program 去 useProgram」——那会让控制台
 * 刷满 INVALID_OPERATION，把真正有用的日志顶掉。换上它，坏 program 就彻底闲置；
 * 下次应用成功后把原材质换回来（源码变了 → 变体键变了 → three 会重新编译）。
 */
const brokenMaterial = new THREE.MeshBasicMaterial({ color: 0x2a0d14 });

let active = 0;
let tab: 'frag' | 'vert' = 'frag';

/* ------------------------------------------------------------------ *
 * 编译错误接住（否则只会刷控制台）
 * ------------------------------------------------------------------ */

const errors: string[] = [];
let pendingCompile: Slot | null = null;

renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
  // 三个日志分开收：程序链接失败时，真正的出错行在 shader 的 infoLog 里
  const lines = [
    gl.getProgramInfoLog(program),
    gl.getShaderInfoLog(fragmentShader),
    gl.getShaderInfoLog(vertexShader),
  ]
    .map((s) => (s ?? '').trim())
    .filter(Boolean);
  errors.push(...(lines.length > 0 ? lines : ['（链接失败，但驱动没有给出日志）']));
};

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

const matChips = $('matChips');
const paramsHost = $('params');
const code = $<HTMLTextAreaElement>('code');
const errorsBox = $('errors');
const hudCompile = $('hudCompile');

function compileStatus(text: string, kind: '' | 'ok' | 'bad') {
  hudCompile.textContent = text;
  hudCompile.className = kind;
}

function showErrors() {
  if (errors.length === 0) {
    errorsBox.hidden = true;
    errorsBox.textContent = '';
    return;
  }
  errorsBox.hidden = false;
  errorsBox.textContent = `编译失败（画面暂时黑掉，改完再应用）\n${errors.join('\n')}`;
}

function buildChips() {
  matChips.textContent = '';
  slots.forEach((slot, i) => {
    const b = document.createElement('button');
    b.textContent = slot.sample.label;
    b.className = i === active ? 'on' : '';
    b.onclick = () => select(i);
    matChips.appendChild(b);
  });
}

function buildParams() {
  paramsHost.textContent = '';
  const slot = slots[active];
  const meta = definedMaterialMeta(slot.material)!;
  const rows = meta.declared.filter((p) => !isBuiltinParam(p.id));
  if (rows.length === 0) {
    paramsHost.innerHTML = '<div style="color:#6a6272;font-size:10.5px">（这个材质没有可调参数）</div>';
    return;
  }
  for (const p of rows) {
    const uniform = (slot.material as THREE.ShaderMaterial).uniforms[p.id];
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = p.label ?? p.id;
    label.title = `${p.id} : ${p.type}`;
    row.appendChild(label);

    if ((p.type as ParamType) === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      const color = uniform.value as THREE.Color;
      input.value = `#${color.getHexString()}`;
      input.oninput = () => {
        params.set(p.id, new THREE.Color(input.value), 'ui');
      };
      row.appendChild(input);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = input.value.slice(1, 7).toUpperCase();
      input.oninput = () => {
        params.set(p.id, new THREE.Color(input.value), 'ui');
        val.textContent = input.value.slice(1, 7).toUpperCase();
      };
      row.appendChild(val);
    } else {
      const [min, max, step] = slot.sample.ranges[p.id] ?? [0, 2, 0.01];
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(uniform.value as number);
      const val = document.createElement('span');
      val.className = 'val';
      const fmt = (v: number) => (typeof uniform.value === 'number' ? v.toFixed(2) : String(v));
      val.textContent = fmt(uniform.value as number);
      input.oninput = () => {
        const v = parseFloat(input.value);
        params.set(p.id, v, 'ui');
        val.textContent = fmt(v);
      };
      row.appendChild(input);
      row.appendChild(val);
    }
    paramsHost.appendChild(row);
  }
}

/** 自动生成的 uniform 声明：把它摊开给作者看，省掉「为什么 undeclared」的来回 */
function buildDecls() {
  const meta = definedMaterialMeta(slots[active].material)!;
  const lines = meta.declared.map((p) => `uniform ${GLSL_TYPE[p.type]} ${p.id};`);
  $('decls').textContent = lines.join('\n') || '（无）';
  $('declCount').textContent = String(lines.length);
}

function syncEditor() {
  const slot = slots[active];
  code.value = slot.current[tab];
  $('editorHint').textContent = tab === 'frag' ? 'fragmentShader' : 'vertexShader';
  document.querySelectorAll<HTMLButtonElement>('#editor .tabs button').forEach((b) => {
    b.className = b.dataset.tab === tab ? 'on' : '';
  });
  $('hudMat').textContent = definedMaterialMeta(slot.material)!.id;
  $('hudQueue').textContent = definedMaterialMeta(slot.material)!.queue;
}

function select(i: number) {
  active = i;
  errors.length = 0;
  showErrors();
  buildChips();
  buildParams();
  buildDecls();
  syncEditor();
  compileStatus('就绪', 'ok');
}

/* ------------------------------------------------------------------ *
 * 应用 / 回退
 * ------------------------------------------------------------------ */

function applyCode() {
  const slot = slots[active];
  const next = code.value;
  if (next === slot.current[tab]) {
    errors.length = 0;
    showErrors();
    compileStatus('无变化', 'ok');
    return;
  }
  slot.current[tab] = next;
  errors.length = 0;
  showErrors();
  const changed = patchMaterialSource(slot.material, { [tab]: next });
  if (!changed) {
    compileStatus('无变化', 'ok');
    return;
  }
  compileStatus('编译中…', '');
  pendingCompile = slot;
}

$<HTMLButtonElement>('apply').onclick = applyCode;

$<HTMLButtonElement>('revert').onclick = () => {
  const slot = slots[active];
  slot.current[tab] = tab === 'frag' ? slot.sample.spec.frag : slot.sample.spec.vert;
  code.value = slot.current[tab];
  applyCode();
};

$<HTMLButtonElement>('undo').onclick = () => {
  // 只改编辑框：current 交给 applyCode 去更新，否则它会判成「无变化」而不重编译
  code.value = slots[active].lastGood[tab];
  applyCode();
};

document.querySelectorAll<HTMLButtonElement>('#editor .tabs button').forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab === 'vert' ? 'vert' : 'frag';
    syncEditor();
  };
});

// ⌘/Ctrl + Enter 应用；Tab 缩进两格（textarea 里 Tab 默认跳焦，写代码时很烦）
code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    applyCode();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = code.selectionStart;
    code.value = `${code.value.slice(0, start)}  ${code.value.slice(code.selectionEnd)}`;
    code.selectionStart = code.selectionEnd = start + 2;
  }
});

/* ------------------------------------------------------------------ *
 * notice 面板
 * ------------------------------------------------------------------ */

const noticesHost = $('notices');
function renderNotices() {
  const items = notices.log.slice(-6);
  if (items.length === 0) {
    noticesHost.innerHTML = '<div>（无）</div>';
    return;
  }
  noticesHost.textContent = '';
  for (const n of items) {
    const div = document.createElement('div');
    div.className = n.level;
    div.textContent = `${n.level === 'warn' ? '⚠' : '·'} ${n.message}`;
    noticesHost.appendChild(div);
  }
}
notices.on(() => renderNotices());

/* ------------------------------------------------------------------ *
 * 尺寸 / 循环
 * ------------------------------------------------------------------ */

function resize() {
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.setSize(w, h);
}
new ResizeObserver(resize).observe(container);
resize();

let frames = 0;
let fpsAt = performance.now();
let fps = 0;

function animate(now: number) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, Math.max(0, (now - prev) / 1000));
  prev = now;

  // 极慢的机位摆动：菲涅尔边缘只有动起来才看得出是「体积」不是「贴图」
  const t = clock.context.time;
  camera.position.set(Math.sin(t * 0.16) * 0.9, 2.25 + Math.sin(t * 0.23) * 0.1, 4.2 + Math.cos(t * 0.16) * 0.4);
  camera.lookAt(0.12, 0.82, 0);

  slots[1].mesh.rotation.y = t * 0.22;
  slots[1].mesh.rotation.x = Math.sin(t * 0.3) * 0.12;

  const ctx = clock.tick(dt, { width: container.clientWidth, height: container.clientHeight });
  params.tick(ctx);
  post.render(dt);

  // 编译是同步发生在上一行的：这一行是「这一帧有没有报错」的判定点
  if (pendingCompile) {
    const slot = pendingCompile;
    pendingCompile = null;
    if (errors.length === 0) {
      slot.lastGood[tab] = slot.current[tab];
      if (slot.mesh.material !== slot.material) slot.mesh.material = slot.material;
      compileStatus('编译通过', 'ok');
    } else {
      // 换掉坏材质：坏 program 不再被使用，控制台留给真正的错误
      slot.mesh.material = brokenMaterial;
      compileStatus('编译失败', 'bad');
    }
    showErrors();
  }

  frames++;
  if (now - fpsAt >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    $('hudFps').textContent = String(fps);
    $('hudPrograms').textContent = String(renderer.info.programs?.length ?? 0);
    $('hudTime').textContent = clock.context.time.toFixed(2);
  }
}

let prev = performance.now();
select(0);
renderNotices();
requestAnimationFrame(animate);
