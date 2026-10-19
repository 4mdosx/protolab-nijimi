/**
 * 集成编辑器：完整场景（房间+陈设+粒子+工业簇）+ 夜兰，调「人物 × 环境」的融合观感。
 * 与主工程 index 的唯一差别 = 多了这块调试面板；标定完的参数回写
 * src/stage.ts / src/character.ts 的默认值。
 */

import * as THREE from 'three';
import { createStage } from '../src/stage';
import { isBuiltinParam } from '../src/shader/params';
import { listModules } from '../src/shader/module';
import { SHOW_MODULES, chargeBurst, reform } from '../src/kits/shows';
import { createDepthEdgePass } from '../src/post-passes';
import { applyBackdrop } from './studio';

const container = document.getElementById('viewport')!;
// characterModules 是「能力在加载期定死」的落点：装好 dissolve / rim-pulse 之后，
// 演出只驱动参数，不会在播放时重编 shader。
// softParticles：主渲染前多渲一遍半分辨率场景深度，粒子/微尘贴着几何时淡出
// （不加这一行也能跑，粒子会「糊」在家具上——那种脏点很难归因，所以默认开着）
const s = createStage(container, { characterModules: SHOW_MODULES, softParticles: { scale: 0.5 } });
// EffectComposer 会丢 alpha（透明处渲黑），浅色棚壁直接垫进 3D 场景
applyBackdrop(s.scene);
const D = s.debug;

// 人物基准值（loadYelan 固化）：站位 (2.35, 1.15)、朝向 -2.36、局部微调用滑杆叠加
const BASE = { x: 2.35, z: 1.15, rotY: -2.36 };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $inp = (id: string) => document.getElementById(id) as HTMLInputElement;

function bindSlider(id: string, valId: string, fmt: (v: number) => string, apply: (v: number) => void) {
  const inp = $inp(id);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    apply(v);
    $(valId).textContent = fmt(v);
  });
}
const f2 = (v: number) => v.toFixed(2);

// ---- 人物（加载完成后生效）----
let dx = 0, dz = 0;
function applyChar() {
  const w = s.character();
  if (!w) return;
  w.group.position.set(BASE.x + dx, 0, BASE.z + dz);
  w.group.rotation.y = (parseFloat($inp('rotY').value) * Math.PI) / 180; // 滑杆值即绝对朝向
}
bindSlider('rotY', 'rotYVal', (v) => `${v.toFixed(0)}°`, () => applyChar());
bindSlider('posX', 'posXVal', (v) => (v >= 0 ? '+' : '') + v.toFixed(2), (v) => { dx = v; applyChar(); });
bindSlider('posZ', 'posZVal', (v) => (v >= 0 ? '+' : '') + v.toFixed(2), (v) => { dz = v; applyChar(); });
// 人物异步加载，轮询对齐一次初始滑杆值
const alignTimer = setInterval(() => {
  if (s.character()) { applyChar(); clearInterval(alignTimer); }
}, 300);
setTimeout(() => clearInterval(alignTimer), 15000);

// ---- 灯光 ----
bindSlider('key', 'keyVal', f2, (v) => { D.lights.key.intensity = v; });
bindSlider('hemi', 'hemiVal', f2, (v) => {
  D.lights.hemi.intensity = v * 0.5;
  s.scene.traverse((o) => {
    if ((o as THREE.AmbientLight).isAmbientLight) (o as THREE.AmbientLight).intensity = v * 0.55;
  });
});
bindSlider('moon', 'moonVal', f2, (v) => { D.lights.moon.intensity = v; });
bindSlider('fill', 'fillVal', (v) => v.toFixed(1), (v) => { D.lights.fill.intensity = v; });

// ---- 后期 ----
bindSlider('bloom', 'bloomVal', f2, (v) => { D.bloomPass.strength = v; });
bindSlider('exposure', 'exposureVal', f2, (v) => { s.renderer.toneMappingExposure = v; });

const nprBtn = $('toggleNpr');
let nprOn = true;
nprBtn.addEventListener('click', () => {
  nprOn = !nprOn;
  s.setNpr(nprOn);
  nprBtn.classList.toggle('on', nprOn);
  nprBtn.textContent = `NPR 手法：${nprOn ? '开' : '关'}`;
});

const bloomBtn = $('toggleBloom');
let bloomOn = true;
bloomBtn.addEventListener('click', () => {
  bloomOn = !bloomOn;
  s.setBloom(bloomOn);
  bloomBtn.classList.toggle('on', bloomOn);
  bloomBtn.textContent = `Bloom 通路：${bloomOn ? '开' : '关'}`;
});

$('resetView').addEventListener('click', () => s.view.reset());

// ---- 着色参数面板：从 ParamBus 自动生成滑杆 ----
// 参数名与中文标签来自模块声明（ShaderModule.params.label）——这就是 P1 把每个
// 参数声明「放进模块里」的回报：编辑器不需要再维护第二份名单。
const LABELS = new Map<string, string>();
function refreshLabels() {
  for (const m of listModules()) {
    for (const p of m.params ?? []) if (p.label) LABELS.set(p.id, p.label);
  }
}

const slidersHost = $('paramSliders');
const slidersEmpty = $('paramEmpty');
const builtSliders = new Set<string>();

function buildSliders() {
  refreshLabels();
  const ids = s.params.ids.filter(
    (id) => !isBuiltinParam(id) && s.params.typeOf(id) === 'float' && !builtSliders.has(id),
  );
  if (ids.length === 0) return;
  slidersEmpty.style.display = 'none';
  for (const id of ids) {
    const current = Number(s.params.get(id)?.value ?? 0);
    const max = Math.max(1, Math.ceil(Math.abs(current) * 2));
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = LABELS.get(id)?.slice(0, 7) ?? id.replace(/^u/, '');
    label.title = `${id} · ${LABELS.get(id) ?? ''}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(max);
    input.step = String(Math.max(0.001, max / 200));
    input.value = String(Math.min(max, Math.max(0, current)));
    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = current.toFixed(2);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      // 写入者标成 editor：与演出的 `fx:<id>` 抢同一个参数时，notice 会说是谁被拒了
      s.params.set(id, v, 'editor');
      value.textContent = v.toFixed(2);
    });
    row.append(label, input, value);
    slidersHost.appendChild(row);
    builtSliders.add(id);
  }
}
const sliderTimer = setInterval(buildSliders, 500);
setTimeout(() => { clearInterval(sliderTimer); buildSliders(); }, 20000);

// ---- 演出 ----
$('playCharge').addEventListener('click', () => s.effects.play(chargeBurst()));
$('playReform').addEventListener('click', () => s.effects.play(reform()));

// ---- 深度描边（读 post.depthTexture，插在 afterTonemap）----
let depthEdgeOn = false;
$('toggleDepthEdge').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLElement;
  depthEdgeOn = !depthEdgeOn;
  if (depthEdgeOn) {
    if (!s.post.has('depth-edge')) {
      s.post.insert({
        id: 'depth-edge',
        anchor: 'afterTonemap',
        reads: ['depth'],
        create: () => createDepthEdgePass({
          camera: s.camera,
          depthTexture: s.post.depthTexture,
          strength: 0.85,
          threshold: 0.015,
        }),
      });
    }
    s.post.setEnabled('depth-edge', true);
  } else if (s.post.has('depth-edge')) {
    s.post.setEnabled('depth-edge', false);
  }
  btn.classList.toggle('on', depthEdgeOn);
  btn.textContent = `深度描边：${depthEdgeOn ? '开' : '关'}`;
});

// ---- notice：降级与冲突都摆到脸上，别只在 console 里活一帧 ----
const noticeLog = $('noticeLog');
s.onNotice(() => {
  const last = s.notices.log.slice(-2).map((n) => n.message).join(' / ');
  noticeLog.textContent = last || '—';
  noticeLog.classList.toggle('warn', s.notices.log.some((n) => n.level === 'error'));
});

// ---- 视窗交互（拖拽平移 / 滚轮缩放，与主工程同 rig）----
const canvas = s.renderer.domElement;
let dragging = false;
let px = 0, py = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  s.view.panByPx(e.clientX - px, e.clientY - py);
  px = e.clientX; py = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  s.view.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, {
    x: ((e.clientX - r.left) / r.width) * 2 - 1,
    y: -(((e.clientY - r.top) / r.height) * 2 - 1),
  });
}, { passive: false });

// ---- 渲染循环 ----
let last = performance.now();
const t0 = last;
function loop(now: number) {
  requestAnimationFrame(loop);
  s.render((now - last) / 1000, (now - t0) / 1000);
  last = now;
}
requestAnimationFrame(loop);

// 调试钩子
Object.assign(window, {
  __labIntegrated: { THREE, scene: s, lights: D.lights, bloomPass: D.bloomPass, character: () => s.character() },
});
