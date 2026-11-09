/**
 * 场景编辑器：createStage(withCharacter:false) 的纯环境调试台。
 * 调灯光 / 后期 / NPR / 视窗；视觉配置通过预设导出，不改引擎默认值。
 */

import * as THREE from 'three';
import { createStage } from '../src/stage';
import { applyBackdrop } from './studio';
import { mountScenePresets } from './scene-presets';

const container = document.getElementById('viewport')!;
const s = createStage(container, { withCharacter: false, softParticles: { scale: 0.5 } });
// EffectComposer 会丢 alpha（透明处渲黑），浅色棚壁直接垫进 3D 场景
applyBackdrop(s.scene);
const D = s.debug;

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

bindSlider('key', 'keyVal', f2, (v) => { D.lights.key.intensity = v; });
bindSlider('hemi', 'hemiVal', f2, (v) => {
  // 与 scene.ts 同构：hemi 滑杆同时驱动 hemi + ambient（冷底整体浓度）
  D.lights.hemi.intensity = v * 0.5;
  s.scene.traverse((o) => {
    if ((o as THREE.AmbientLight).isAmbientLight) (o as THREE.AmbientLight).intensity = v * 0.55;
  });
});
bindSlider('moon', 'moonVal', f2, (v) => { D.lights.moon.intensity = v; });
bindSlider('fill', 'fillVal', (v) => v.toFixed(1), (v) => { D.lights.fill.intensity = v; });
bindSlider('bloom', 'bloomVal', f2, (v) => { D.bloomPass.strength = v; });
bindSlider('exposure', 'exposureVal', f2, (v) => { s.renderer.toneMappingExposure = v; });

const nprBtn = $('toggleNpr');
let nprOn = s.visual.capture().npr;
nprBtn.addEventListener('click', () => {
  nprOn = !nprOn;
  s.setNpr(nprOn);
  nprBtn.classList.toggle('on', nprOn);
  nprBtn.textContent = `NPR 手法：${nprOn ? '开' : '关'}`;
});

const bloomBtn = $('toggleBloom');
let bloomOn = s.visual.capture().bloom.enabled;
bloomBtn.addEventListener('click', () => {
  bloomOn = !bloomOn;
  s.setBloom(bloomOn);
  bloomBtn.classList.toggle('on', bloomOn);
  bloomBtn.textContent = `Bloom 通路：${bloomOn ? '开' : '关'}`;
});

function refreshVisualControls() {
  const p = s.visual.capture();
  const values: Record<string, number> = {
    key: p.lights.key.intensity, hemi: p.lights.hemi.intensity * 2,
    moon: p.lights.moon.intensity, fill: p.lights.fill.intensity,
    bloom: p.bloom.strength, exposure: p.exposure,
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $inp(id);
    input.min = String(Math.min(Number(input.min), value));
    input.max = String(Math.max(Number(input.max), value));
    input.value = String(value);
    $(id + 'Val').textContent = id === 'fill' ? value.toFixed(1) : value.toFixed(2);
  }
  nprOn = p.npr; bloomOn = p.bloom.enabled;
  nprBtn.classList.toggle('on', nprOn);
  nprBtn.textContent = `NPR 手法：${nprOn ? '开' : '关'}`;
  bloomBtn.classList.toggle('on', bloomOn);
  bloomBtn.textContent = `Bloom 通路：${bloomOn ? '开' : '关'}`;
}
mountScenePresets(s.visual, refreshVisualControls);
refreshVisualControls();

$('resetView').addEventListener('click', () => s.view.reset());

// 视窗交互：拖拽平移 / 滚轮缩放（与主工程 interact 同语义，直连 view rig）
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

// 渲染循环
let last = performance.now();
const t0 = last;
function loop(now: number) {
  requestAnimationFrame(loop);
  s.render((now - last) / 1000, (now - t0) / 1000);
  last = now;
}
requestAnimationFrame(loop);

// 调试钩子（与主工程/人物编辑器同约定）
Object.assign(window, {
  __labScene: { THREE, scene: s, lights: D.lights, bloomPass: D.bloomPass },
});
