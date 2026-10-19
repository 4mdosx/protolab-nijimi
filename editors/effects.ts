/**
 * 演出编辑器（第六台）——把「一段 EFFECTS」当**数据**来编，而不是改函数。
 *
 * 为什么需要它：`kits/shows.ts` 里的演出是代码，调一次强度要改源码、等 HMR、
 * 再看画面；而调演出本来就是「拖一个点、看一帧」的活。这里把同一段演出换成
 * 关键帧轨道（`src/kits/timeline.ts`），于是可以画曲线、拖点、scrub、A/B。
 *
 * 两条播放路径，刻意分开：
 *   - **播放** → `stage.effects.play(specFrom(t))`：真实的调度器，末帧补写、
 *     临时 pass 的拆装、写入者审计都按引擎来。要验「运行时行为」用这条。
 *   - **拖动 / 暂停** → 停止 effects，改由 `s.onFrame` 手动写参数（writer `preview`）。
 *     effects 的相位只能前进、不能 seek，所以定位必须绕开它；参数写入口径不变。
 *
 * 参数写入前先查 `params.has()`：未声明（模块没装 / id 拼错）就**不写**，
 * 只在右栏标红。否则 `ParamBus` 会自动建一个同名参数并每帧发 notice，
 * 看起来「有效果」其实是写进了一个没人读的槽——这类假成功比报错更难查。
 *
 * 导出的是纯数据代码（`serializeTimeline`），没有运行时依赖；贴回内容仓即可。
 */

import * as THREE from 'three';
import { createStage } from '../src/stage';
import { createShockwavePass } from '../src/post-passes';
import { SHOW_MODULES } from '../src/kits/shows';
import { asciiFlow } from '../src/shader/modules/ascii-flow';
import { listModules } from '../src/shader/module';
import { isBuiltinParam } from '../src/shader/params';
import {
  buildColors, evalTimeline, sampleTrack, serializeTimeline,
  type TimelineShow, type TimelineTrack,
} from '../src/kits/timeline';
import type { EffectHandle, EffectSpec } from '../src/effects';

const container = document.getElementById('viewport')!;
// 材质侧模块必须在建舞台时装好：演出只驱动参数，播放期间不编译 shader。
// ASCII 是「按需装」的模块，不塞进 SHOW_MODULES：它只在演示开关打开时写 uAscii，
// 关着的时候逐像素等价于不装（模块里 uAscii = 0 直接跳过整段）。
const s = createStage(container, { characterModules: [...SHOW_MODULES, asciiFlow] });
// 深色底：边缘光与溶解的「发光边」在浅棚壁上几乎看不见
s.scene.background = new THREE.Color(0x0b0910);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * 数据：一打开就是一段「chargeBurst 的手动近似」
 * ------------------------------------------------------------------ */

const TRACK_COLORS = ['#7ec8c0', '#e8a34c', '#b48ce0', '#8fc46a', '#e07a7a', '#6aa8e0', '#d0c070'];

const show: TimelineShow = {
  id: 'my-show',
  duration: 1.9,
  loop: false,
  onEnd: 'restore',
  colors: {
    uRimPulseColor: '#9fd8ff',
    uDissolveColor: '#9fd8ff',
    uAsciiColor: '#9fd8ff',
  },
  shock: { from: 0.3, to: 0.85, strength: 1.15, width: 0.055, color: '#9fd8ff' },
  tracks: [
    // 边缘光：充能到 0.32 拉满，随后缓慢回落（一直亮着会盖住溶解边）
    { id: 'uRimPulseStrength', keys: [{ t: 0, v: 0 }, { t: 0.32, v: 1.7 }, { t: 0.54, v: 0.77 }] },
    { id: 'uRimPulsePower', keys: [{ t: 0, v: 2.6 }, { t: 0.32, v: 1.8 }] },
    // 溶解：0.55 才开始化，0.94 到 0.995（不推满，全消会像崩了）
    { id: 'uDissolve', keys: [{ t: 0, v: 0 }, { t: 0.55, v: 0 }, { t: 0.94, v: 0.995 }] },
    { id: 'uDissolveEdge', keys: [{ t: 0, v: 0.07 }] },
    { id: 'uDissolveScale', keys: [{ t: 0, v: 5.5 }] },
    { id: 'uDissolveGlow', keys: [{ t: 0, v: 0 }, { t: 0.55, v: 1.5 }, { t: 0.78, v: 1.5 }, { t: 1, v: 0.52 }] },
  ],
};

let colors = buildColors(show);

/* ------------------------------------------------------------------ *
 * 取景：正对角色近景（不接视窗 rig —— 那是看房间的，这里是看一张脸）
 * ------------------------------------------------------------------ */

const CHAR = new THREE.Vector3(2.35, 0.98, 1.15);
const CAM_POS = CHAR.clone().addScaledVector(new THREE.Vector3(0.62, 0.30, 1).normalize(), 15);
const CAM_QUAT = new THREE.Quaternion();
// 正交相机的位置不改变大小，`zoom` 才是唯一放大手段。
// 演出要在**脸和胸口**这个尺度上看：ASCII 的字符格、溶解的发光边，
// 在全身景里都只有几个像素，等于没法调。
const CAM_ZOOM = 7.2;

/**
 * 取景必须**每帧**锁一次：stage.resize() 会调它内部的 applyCamera()，
 * 而 ResizeObserver 在首帧之后还会再触发一回——只在初始化时设一次的话，
 * 相机会在几百毫秒后被「房间全景」顶掉（第一版就是这样，角色只有指甲盖大）。
 */
function lockCamera() {
  const cam = s.camera;
  cam.position.copy(CAM_POS);
  cam.quaternion.copy(CAM_QUAT);
  if (cam.zoom !== CAM_ZOOM) {
    cam.zoom = CAM_ZOOM;
    cam.updateProjectionMatrix();
  }
}

function frameCharacter() {
  const m = new THREE.Matrix4().lookAt(CAM_POS, CHAR, new THREE.Vector3(0, 1, 0));
  CAM_QUAT.setFromRotationMatrix(m);
  lockCamera();
}
frameCharacter();
// 角色是异步加载的：加载完再对一次（身高已知，不必等包围盒）
const waitChar = setInterval(() => {
  if (s.character()) { frameCharacter(); clearInterval(waitChar); refreshTable(); }
}, 300);
setTimeout(() => clearInterval(waitChar), 20000);

/* ------------------------------------------------------------------ *
 * 播放 / 定位
 * ------------------------------------------------------------------ */

type Mode = 'idle' | 'play' | 'scrub';
let mode: Mode = 'idle';
let handle: EffectHandle | null = null;
let playingT = 0;
let scrubT = 0;
let idleT = 0;
let speed = 1;

const playBtn = $<HTMLButtonElement>('play');

function shockValues(t: number) {
  const sh = show.shock!;
  const span = Math.max(1e-4, sh.to - sh.from);
  const p = clamp01((t - sh.from) / span);
  return {
    uProgress: p,
    // 到端点就归零：环停在半径外还会留一圈边，看着像漏光
    uStrength: p > 0 && p < 1 ? (sh.strength ?? 1.15) : 0,
    uWidth: sh.width ?? 0.055,
  };
}

/**
 * 只把**已声明**的参数交出去（见文件头）。返回新对象，代价是每帧一次小分配，
 * 换来的是「未声明 = 画面没反应 + 右栏标红」这条可诊断的行为。
 */
function declared(values: Record<string, number | THREE.Color>) {
  const out: Record<string, number | THREE.Color> = {};
  for (const [id, v] of Object.entries(values)) if (s.params.has(id)) out[id] = v;
  return out;
}

function specFrom(fromT: number): EffectSpec {
  const a = clamp01(fromT);
  const span = Math.max(1e-3, 1 - a);
  return {
    id: 'preview',
    duration: Math.max(0.05, show.duration * span),
    loop: a === 0 ? show.loop : false,
    onEnd: show.onEnd ?? 'restore',
    params: (t) => declared(evalTimeline(show, a + t * span, colors)),
    post: shockOn
      ? {
          // id 显式给：scrub 时我们自己也用这个名字，两套不能各插一个
          id: 'shock',
          anchor: 'afterTonemap',
          priority: 10,
          reads: ['color'],
          params: { uStrength: 0 },
          create: () => createShockwavePass({ color: show.shock?.color ?? '#9fd8ff' }),
        }
      : undefined,
    onFrame: shockOn
      ? (t, _ctx, api) => { api.setPassParams(shockValues(a + t * span)); }
      : undefined,
  };
}

function setPlayButton(on: boolean) {
  playBtn.classList.toggle('on', on);
  playBtn.textContent = on ? '⏸ 暂停' : '▶ 播放';
}

function stopEffects() {
  s.effects.stopAll();
  handle = null;
  if (s.post.has('shock')) s.post.remove('shock');
}

function play(fromT = 0) {
  stopEffects();
  handle = s.effects.play(specFrom(fromT));
  playingT = clamp01(fromT);
  mode = 'play';
  setPlayButton(true);
}

function pauseAt(t: number) {
  stopEffects();
  scrubT = clamp01(t);
  mode = 'scrub';
  setPlayButton(false);
}

function scrubTo(t: number) {
  // 用户开始拖时间轴 = 想回到「演出」语境，ASCII 演示自动让位
  if (asciiDemo) setAsciiDemo(false);
  if (mode === 'play') stopEffects();
  scrubT = clamp01(t);
  mode = 'scrub';
  setPlayButton(false);
}

function stopAndReset() {
  stopEffects();
  mode = 'scrub';
  scrubT = 0;
  setPlayButton(false);
}

/** 结构变了（时长 / 循环 / 冲击波）→ 从当前位置重播，别让 spec 停在旧设置上 */
function restart() {
  // scrub 模式不用管：参数每帧由 onFrame 重新求值，改了设置下一帧就是新的
  if (mode === 'play') play(playingT);
}

/** 数字输入的统一解析：空串/NaN 回退到默认值，0 是合法值 */
function num(value: string, fallback: number): number {
  const v = parseFloat(value);
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------------------------------------------ *
 * ASCII 流动（层 A 模块）：常量参数 + 单独演示
 * ------------------------------------------------------------------ */

/**
 * 为什么常量要单独写一遍：模块的 float 参数默认值统一是 0，
 * 而 `uAsciiContrast = 0` 意味着**所有格子的亮度都是 0**——只把 uAscii 拉到 1
 * 会得到一片纯黑。这里给一组「装上就能看」的默认值，加载时直接写进总线。
 */
let asciiDemo = false;
const asciiBtn = $<HTMLButtonElement>('asciiDemo');

function bindAscii(id: string, inputId: string, outId: string | null, dp: number) {
  const input = $inp(inputId);
  const out = outId ? $(outId) : null;
  const apply = () => {
    const v = num(input.value, 0);
    if (out) out.textContent = v.toFixed(dp);
    // 未声明就跳过（模块没装 / id 拼错），别让 ParamBus 自动建一个没人读的槽
    if (s.params.has(id)) s.params.set(id, v, 'ascii-panel');
  };
  input.addEventListener('input', apply);
  apply();
}

bindAscii('uAsciiRows', 'aRows', 'aRowsV', 0);
bindAscii('uAsciiSpeed', 'aSpeed', 'aSpeedV', 2);
bindAscii('uAsciiScatter', 'aScatter', 'aScatterV', 2);
bindAscii('uAsciiContrast', 'aContrast', 'aContrastV', 2);
bindAscii('uAsciiThreshold', 'aThreshold', 'aThresholdV', 2);
bindAscii('uAsciiFill', 'aFill', 'aFillV', 2);
bindAscii('uAsciiTint', 'aTint', 'aTintV', 2);
bindAscii('uAsciiBand', 'aBand', 'aBandV', 2);

// 颜色走 show.colors：scrub 时轨道会写同一个 id，两边必须是同一个值，否则
// 「拖一下时间轴颜色就跳回去」——那是最容易被当成 bug 的体验。
const asciiColor = $inp('aColor');
asciiColor.addEventListener('input', () => {
  show.colors = { ...show.colors, uAsciiColor: asciiColor.value };
  colors = buildColors(show);
  if (s.params.has('uAsciiColor')) s.params.set('uAsciiColor', colors.uAsciiColor, 'ascii-panel');
});
if (s.params.has('uAsciiColor')) s.params.set('uAsciiColor', colors.uAsciiColor ?? new THREE.Color('#9fd8ff'), 'ascii-panel');

/**
 * 演示开关的语义：**停掉演出、把时间轴归零**，于是其它参数全回到「无效果」，
 * 画面上只剩角色本身的 ASCII 化。不自建第二条播放通道——参数还是走同一条总线。
 */
function setAsciiDemo(on: boolean) {
  asciiDemo = on;
  asciiBtn.classList.toggle('on', on);
  asciiBtn.textContent = on ? '■ 退出 ASCII 演示' : 'ASCII 演示（停演出 · 只看字符流）';
  if (on) {
    stopEffects();
    mode = 'scrub';
    scrubT = 0;
    setPlayButton(false);
  } else if (s.params.has('uAscii')) {
    s.params.set('uAscii', 0, 'ascii-panel');
  }
}
asciiBtn.addEventListener('click', () => setAsciiDemo(!asciiDemo));

/* ------------------------------------------------------------------ *
 * 手动定位：写在 params.tick 之后、effects.update 之前（这就是 onFrame）
 * ------------------------------------------------------------------ */

s.onFrame(() => {
  // 演示开关：每帧写一次。tick 会清掉写入者审计，所以「写一次就一直是 0.95」
  // 只在没有别的写入者时成立——而演出正是那个别的写入者。
  if (asciiDemo && s.params.has('uAscii')) s.params.set('uAscii', 0.95, 'ascii-demo');
  if (mode !== 'scrub') return;
  for (const [id, v] of Object.entries(evalTimeline(show, scrubT, colors))) {
    if (s.params.has(id)) s.params.set(id, v, 'preview');
  }
  // 临时 pass 在 scrub 时由我们持有：effects 被 stop 掉了，没人替它建链
  if (shockOn) {
    if (!s.post.has('shock')) {
      s.post.insert({
        id: 'shock',
        anchor: 'afterTonemap',
        priority: 10,
        params: { uStrength: 0 },
        create: () => createShockwavePass({ color: show.shock?.color ?? '#9fd8ff' }),
      });
    }
    s.post.setParams('shock', shockValues(scrubT));
  } else if (s.post.has('shock')) {
    s.post.remove('shock');
  }
});

/* ------------------------------------------------------------------ *
 * 时间线 DOM
 * ------------------------------------------------------------------ */

const heads = $('heads');
const lanesInner = $('lanesInner');
const lanes = $('lanes');
const cursor = $('cursor');
const ruler = $('ruler');
const rulerCanvas = ruler.querySelector('canvas') as HTMLCanvasElement;

interface LaneEls {
  head: HTMLElement;
  lane: HTMLElement;
  canvas: HTMLCanvasElement;
  dots: HTMLElement[];
  idEl: HTMLElement;
  valueEl: HTMLElement;
  swatchEl: HTMLElement;
}
let laneEls: LaneEls[] = [];
let selected = 0;

const colorOf = (i: number) => TRACK_COLORS[i % TRACK_COLORS.length];

function rangeOf(tr: TimelineTrack): { lo: number; hi: number } {
  const vs = tr.keys.map((k) => k.v);
  if (vs.length === 0) return { lo: 0, hi: 1 };
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  // 单点轨道（常量）也要占一段可见高度，否则线贴着边框
  const pad = hi - lo < 1e-6 ? Math.max(Math.abs(lo) * 0.5, 0.05) : (hi - lo) * 0.15;
  return niceRange(lo - pad, hi + pad);
}

/** 范围吸附到 1/2/5 的数量级：拖点时不会因为「值变了一点」整条曲线跳一下 */
function niceRange(lo: number, hi: number): { lo: number; hi: number } {
  if (!(hi > lo)) hi = lo + 1;
  const raw = hi - lo;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = mag <= 0 ? mag : mag / 2;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  return { lo: a, hi: b === a ? a + step : b };
}

function buildTimeline() {
  for (const el of [...heads.children]) if (!el.classList.contains('pad')) el.remove();
  lanesInner.innerHTML = '';
  laneEls = [];

  show.tracks.forEach((tr, i) => {
    const head = document.createElement('div');
    head.className = 'head' + (i === selected ? ' sel' : '');
    const idEl = document.createElement('div');
    idEl.className = 'id';
    idEl.textContent = tr.id || '(未命名)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const swatchEl = document.createElement('span');
    swatchEl.className = 'swatch';
    swatchEl.style.background = colorOf(i);
    const valueEl = document.createElement('span');
    valueEl.className = 'v';
    valueEl.textContent = '—';
    meta.append(swatchEl, valueEl);
    head.append(idEl, meta);
    head.addEventListener('pointerdown', () => select(i));
    heads.appendChild(head);

    const lane = document.createElement('div');
    lane.className = 'lane' + (i === selected ? ' sel' : '');
    const canvas = document.createElement('canvas');
    lane.appendChild(canvas);

    const dots = tr.keys.map((_, ki) => makeDot(i, ki, lane));
    lane.addEventListener('pointerdown', (e) => {
      // 点在点上：交给 dot 的处理器（它会 stopPropagation）
      if ((e.target as HTMLElement).classList.contains('dot')) return;
      select(i);
      scrubTo(phaseAt(e));
    });
    lane.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).classList.contains('dot')) return;
      addKeyAt(i, phaseAt(e), valueAt(i, e));
    });
    lane.addEventListener('contextmenu', (e) => e.preventDefault());

    lanesInner.appendChild(lane);

    laneEls.push({ head, lane, canvas, dots, idEl, valueEl, swatchEl });
  });

  paintAll();
  refreshTable();
}

function phaseAt(e: PointerEvent | MouseEvent): number {
  const r = lanesInner.getBoundingClientRect();
  return clamp01((e.clientX - r.left) / Math.max(1, r.width));
}

function valueAt(i: number, e: PointerEvent | MouseEvent): number {
  const { lane } = laneEls[i];
  const r = lane.getBoundingClientRect();
  const { lo, hi } = rangeOf(show.tracks[i]);
  const norm = clamp01(1 - (e.clientY - r.top - 6) / Math.max(1, r.height - 12));
  return lo + norm * (hi - lo);
}

function makeDot(i: number, ki: number, lane: HTMLElement): HTMLElement {
  const dot = document.createElement('div');
  dot.className = 'dot';
  dot.style.color = colorOf(i);
  dot.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    select(i);
    const tr = show.tracks[i];
    const rg = rangeOf(tr);
    drag = { i, ki, lo: rg.lo, hi: rg.hi, rect: lane.getBoundingClientRect() };
    dot.classList.add('dragging');
    paintLane(i, { lo: rg.lo, hi: rg.hi });
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  });
  dot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const tr = show.tracks[i];
    if (tr.keys.length <= 1) return; // 至少留一个点，否则轨道消失得莫名其妙
    tr.keys.splice(ki, 1);
    buildTimeline();
  });
  lane.appendChild(dot);
  return dot;
}

let drag: { i: number; ki: number; lo: number; hi: number; rect: DOMRect } | null = null;

function onDragMove(e: PointerEvent) {
  if (!drag) return;
  const tr = show.tracks[drag.i];
  const k = tr.keys[drag.ki];
  if (!k) return;
  const prev = tr.keys[drag.ki - 1];
  const next = tr.keys[drag.ki + 1];
  // 夹在邻居之间：保持 keys 有序，sampleTrack 才能线性扫
  const lo = prev ? prev.t + 1e-4 : 0;
  const hi = next ? next.t - 1e-4 : 1;
  const t = lo <= hi ? clamp(lo, hi, (e.clientX - drag.rect.left) / Math.max(1, drag.rect.width)) : k.t;
  const norm = clamp01(1 - (e.clientY - drag.rect.top - 6) / Math.max(1, drag.rect.height - 12));
  k.t = clamp01(t);
  k.v = drag.lo + norm * (drag.hi - drag.lo);
  paintLane(drag.i, { lo: drag.lo, hi: drag.hi });
}

function onDragEnd() {
  if (!drag) return;
  const i = drag.i;
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  paintLane(i);
  refreshTable();
}

function addKeyAt(i: number, t: number, v: number) {
  const tr = show.tracks[i];
  tr.keys.push({ t, v });
  tr.keys.sort((a, b) => a.t - b.t);
  buildTimeline();
}

function select(i: number) {
  if (i === selected) return;
  selected = Math.min(show.tracks.length - 1, Math.max(0, i));
  laneEls.forEach((el, k) => {
    el.head.classList.toggle('sel', k === selected);
    el.lane.classList.toggle('sel', k === selected);
  });
  syncTrackFields();
  refreshTable();
}

function syncTrackFields() {
  const tr = show.tracks[selected];
  if (!tr) return;
  $inp('trackId').value = tr.id;
  $<HTMLSelectElement>('trackEase').value = tr.ease ?? 'smooth';
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

function paintLane(i: number, frozen?: { lo: number; hi: number }) {
  const tr = show.tracks[i];
  const el = laneEls[i];
  if (!tr || !el) return;
  const w = el.lane.clientWidth;
  const h = el.lane.clientHeight;
  if (w <= 0 || h <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
  }
  const ctx = el.canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { lo, hi } = frozen ?? rangeOf(tr);
  const yOf = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 12);

  // 竖向四分网格 + 横向零线（有 0 才画）
  ctx.strokeStyle = '#221c2c';
  ctx.lineWidth = 1;
  for (let q = 1; q < 4; q++) {
    const x = Math.round((w * q) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  if (lo < 0 && hi > 0) {
    const y = Math.round(yOf(0)) + 0.5;
    ctx.strokeStyle = '#2e2639';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = colorOf(i);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const N = Math.max(2, Math.ceil(w / 2));
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const x = t * w;
    const y = yOf(sampleTrack(tr, t));
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  tr.keys.forEach((key, ki) => {
    const d = el.dots[ki];
    if (!d) return;
    d.style.left = `${key.t * 100}%`;
    d.style.top = `${yOf(key.v)}px`;
  });
}

function paintRuler() {
  const w = ruler.clientWidth;
  const h = 22;
  if (w <= 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (rulerCanvas.width !== Math.round(w * dpr)) {
    rulerCanvas.width = Math.round(w * dpr);
    rulerCanvas.height = Math.round(h * dpr);
  }
  const ctx = rulerCanvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '9px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';

  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const x = Math.round(t * w) + 0.5;
    const major = i % 4 === 0;
    ctx.strokeStyle = major ? '#4a4356' : '#2a2435';
    ctx.beginPath();
    ctx.moveTo(x, major ? 8 : 14);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = '#6f6879';
      const label = t.toFixed(2);
      // 端点的标签往里收，别被裁掉
      const tx = i === 0 ? 2 : i === 16 ? w - 22 : x + 3;
      ctx.fillText(label, tx, 1);
    }
  }
}

function paintAll() {
  paintRuler();
  show.tracks.forEach((_, i) => paintLane(i));
}

function cursorPhase(): number {
  if (mode === 'play') return playingT;
  if (mode === 'scrub') return scrubT;
  return idleT;
}

function updateCursor() {
  const t = cursorPhase();
  cursor.style.left = `${t * 100}%`;
  const sec = t * show.duration;
  $('timeText').innerHTML = `${sec.toFixed(3)} <i>/ ${show.duration.toFixed(3)} s</i>`;
}

/* ------------------------------------------------------------------ *
 * 右栏：参数状态
 * ------------------------------------------------------------------ */

interface TableRow { tr: TimelineTrack; row: HTMLTableRowElement; idCell: HTMLTableCellElement; vCell: HTMLTableCellElement }
let tableRows: TableRow[] = [];
/** 上次建表时的 id 序列。**不能只看条数**：改名 / 同数量换轨道都会让行标签停在旧值。 */
let tableSig = '';

function refreshTable() {
  const host = $('paramTable');
  const sig = show.tracks.map((tr) => tr.id).join('\u0000');
  if (sig !== tableSig) {
    tableSig = sig;
    host.innerHTML = '';
    tableRows = show.tracks.map((tr) => {
      const row = document.createElement('tr');
      const idCell = document.createElement('td');
      idCell.className = 'id';
      idCell.textContent = tr.id || '(未命名)';
      const vCell = document.createElement('td');
      vCell.className = 'v';
      row.append(idCell, vCell);
      host.appendChild(row);
      return { tr, row, idCell, vCell };
    });
  }
  const t = cursorPhase();
  const ready = !!s.character();
  // 轨道行头也显示当前相位的值：看曲线时眼睛不用在「图表 / 右栏」之间来回跳
  laneEls.forEach((el, i) => {
    const tr = show.tracks[i];
    if (!tr) return;
    const ok = s.params.has(tr.id);
    el.valueEl.textContent = ok ? sampleTrack(tr, t).toFixed(3) : '未声明';
    el.valueEl.style.color = ok ? '#7ec8c0' : '#a4644f';
  });
  for (const r of tableRows) {
    const ok = s.params.has(r.tr.id);
    const v = sampleTrack(r.tr, t);
    r.vCell.textContent = ok ? v.toFixed(3) : '—';
    r.row.classList.toggle('miss', !ok);
    r.vCell.title = ok ? '' : '参数不在总线上：模块没装或 id 拼错';
  }
  const missing = show.tracks.filter((tr) => !s.params.has(tr.id)).length;
  const hint = $('busHint');
  hint.classList.toggle('warn', ready && missing > 0);
  hint.textContent = !ready
    ? '角色加载中…（参数由材质侧提供）'
    : missing === 0
      ? '全部参数已连到总线'
      : `${missing} 个参数未声明 · 模块没装或 id 拼错`;
}

/* ------------------------------------------------------------------ *
 * 右栏：演出设置
 * ------------------------------------------------------------------ */

function readShowFields() {
  show.id = $inp('showId').value.trim() || 'my-show';
  show.duration = Math.max(0.1, num($inp('dur').value, 1.9));
  show.loop = $inp('loop').checked;
  show.onEnd = $<HTMLSelectElement>('onEnd').value as 'restore' | 'keep';
  show.shock!.from = clamp01(num($inp('shockFrom').value, 0.3));
  show.shock!.to = Math.max(show.shock!.from + 0.01, clamp01(num($inp('shockTo').value, 0.85)));
  show.shock!.strength = num($inp('shockStrength').value, 1.15);
}

$inp('showId').addEventListener('input', readShowFields);
$inp('dur').addEventListener('input', () => {
  readShowFields();
  $('durVal').textContent = show.duration.toFixed(2);
  updateCursor();
  restart();
});
$inp('loop').addEventListener('change', () => { readShowFields(); restart(); });
$<HTMLSelectElement>('onEnd').addEventListener('change', () => { readShowFields(); restart(); });

let shockOn = true;
$inp('shockOn').addEventListener('change', () => {
  shockOn = $inp('shockOn').checked;
  restart();
});
$inp('shockFrom').addEventListener('input', () => { readShowFields(); restart(); });
$inp('shockTo').addEventListener('input', () => { readShowFields(); restart(); });
$inp('shockStrength').addEventListener('input', () => {
  readShowFields();
  $('shockStrengthVal').textContent = show.shock!.strength!.toFixed(2);
});

function bindColor(colorId: string, hexId: string, param: string) {
  const colorEl = $inp(colorId);
  const hexEl = $inp(hexId);
  const apply = (hex: string) => {
    const v = /^#?[0-9a-f]{6}$/i.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : '#9fd8ff';
    colorEl.value = v;
    hexEl.value = v;
    show.colors![param] = v;
    colors = buildColors(show);
    if (show.shock) show.shock.color = show.colors!.uDissolveColor;
    refreshTable();
  };
  colorEl.addEventListener('input', () => apply(colorEl.value));
  hexEl.addEventListener('change', () => apply(hexEl.value.trim()));
  apply(hexEl.value.trim());
}
bindColor('rimColor', 'rimColorHex', 'uRimPulseColor');
bindColor('dissColor', 'dissColorHex', 'uDissolveColor');

/* ---- 轨道属性 ---- */
$inp('trackId').addEventListener('change', () => {
  const tr = show.tracks[selected];
  if (!tr) return;
  const next = $inp('trackId').value.trim();
  if (!next) { $inp('trackId').value = tr.id; return; }
  const dup = show.tracks.some((t, i) => i !== selected && t.id === next);
  if (dup) { $inp('trackId').value = tr.id; return; }
  tr.id = next;
  buildTimeline();
});
$<HTMLSelectElement>('trackEase').addEventListener('change', () => {
  const tr = show.tracks[selected];
  if (!tr) return;
  tr.ease = $<HTMLSelectElement>('trackEase').value as 'smooth' | 'linear';
  paintAll();
});

function nextTrackId(): string {
  const used = new Set(show.tracks.map((t) => t.id));
  // 从已声明的 float 参数里挑第一个没被占用的，省得新建轨道还要手打
  const cand = [
    ...s.params.ids.filter((id) => !isBuiltinParam(id) && s.params.typeOf(id) === 'float'),
    ...listModules().flatMap((m) => (m.params ?? []).filter((p) => p.type === 'float').map((p) => p.id)),
    'uCustom',
  ];
  for (const id of cand) if (!used.has(id)) return id;
  let n = 2;
  while (used.has(`uCustom${n}`)) n++;
  return `uCustom${n}`;
}

$('addTrack').addEventListener('click', () => {
  const id = nextTrackId();
  // 新轨道默认是一条「0 → 1」的斜坡，至少能看见它
  show.tracks.push({ id, keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] });
  selected = show.tracks.length - 1;
  buildTimeline();
  syncTrackFields();
});

$('trackDup').addEventListener('click', () => {
  const tr = show.tracks[selected];
  if (!tr) return;
  const id = nextTrackId();
  show.tracks.splice(selected + 1, 0, { ...tr, id, keys: tr.keys.map((k) => ({ ...k })) });
  selected += 1;
  buildTimeline();
  syncTrackFields();
});

$('trackDel').addEventListener('click', () => {
  if (show.tracks.length <= 1) return; // 至少留一条，空时间线没法操作
  show.tracks.splice(selected, 1);
  selected = Math.min(selected, show.tracks.length - 1);
  buildTimeline();
  syncTrackFields();
});

/* ------------------------------------------------------------------ *
 * 刻度尺 / 游标拖动
 * ------------------------------------------------------------------ */

let scrubDrag = false;
ruler.addEventListener('pointerdown', (e) => {
  scrubDrag = true;
  scrubTo(phaseAt(e));
  window.addEventListener('pointermove', onScrubMove);
  window.addEventListener('pointerup', () => {
    scrubDrag = false;
    window.removeEventListener('pointermove', onScrubMove);
  }, { once: true });
});
function onScrubMove(e: PointerEvent) {
  if (scrubDrag) scrubTo(phaseAt(e));
}

/* ------------------------------------------------------------------ *
 * 播放条
 * ------------------------------------------------------------------ */

playBtn.addEventListener('click', () => {
  if (mode === 'play') pauseAt(playingT);
  else play(mode === 'scrub' ? scrubT : 0);
});
$('stop').addEventListener('click', stopAndReset);
$('prevFrame').addEventListener('click', () => {
  const step = 1 / 30 / show.duration;
  scrubTo(cursorPhase() - step);
});
$('nextFrame').addEventListener('click', () => {
  const step = 1 / 30 / show.duration;
  scrubTo(cursorPhase() + step);
});
$<HTMLSelectElement>('speed').addEventListener('change', () => {
  speed = num($<HTMLSelectElement>('speed').value, 1);
});
$('autoFrame').addEventListener('click', frameCharacter);

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

function openExport() {
  readShowFields();
  $<HTMLTextAreaElement>('exportCode').value = serializeTimeline(show, { shock: shockOn });
  $('exportPanel').classList.add('open');
}
$('exportBtn').addEventListener('click', openExport);
$('closeExport').addEventListener('click', () => $('exportPanel').classList.remove('open'));
$('copyCode').addEventListener('click', async () => {
  const ta = $<HTMLTextAreaElement>('exportCode');
  try {
    await navigator.clipboard.writeText(ta.value);
    $<HTMLButtonElement>('copyCode').textContent = '已复制';
    setTimeout(() => ($<HTMLButtonElement>('copyCode').textContent = '复制'), 1200);
  } catch {
    ta.select();
    document.execCommand('copy');
  }
});

/* ------------------------------------------------------------------ *
 * 参数候选（datalist）：总线 + 模块声明 + 演出常用名
 * ------------------------------------------------------------------ */

function fillParamList() {
  const host = $('paramList');
  host.innerHTML = '';
  const seen = new Set<string>();
  const push = (id: string, label: string) => {
    if (seen.has(id) || isBuiltinParam(id)) return;
    seen.add(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.label = label;
    host.appendChild(opt);
  };
  for (const m of listModules()) {
    for (const p of m.params ?? []) if (p.type === 'float') push(p.id, p.label ?? m.id);
  }
  for (const id of s.params.ids) if (s.params.typeOf(id) === 'float') push(id, '已在总线');
  for (const tr of show.tracks) push(tr.id, '当前轨道');
}
fillParamList();
setTimeout(fillParamList, 3000);

/* ------------------------------------------------------------------ *
 * 渲染循环
 * ------------------------------------------------------------------ */

let last = performance.now();
const t0 = last;
let tableClock = 0;

function loop(now: number) {
  requestAnimationFrame(loop);

  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  // 慢放靠缩放 dt：effects 用 ctx.delta 推进，同一条时钟也带着角色 idle 变慢。
  // 调试时这是想要的（看清一帧），但别把它当成「只慢演出」。
  lockCamera();
  s.render(dt * speed, (now - t0) / 1000);

  if (mode === 'play') {
    if (handle && handle.playing) {
      playingT = handle.t;
    } else {
      // effects 播完会自己拆 pass；把游标停在末帧，参数留在最后一次写入
      idleT = 1;
      handle = null;
      mode = 'idle';
      setPlayButton(false);
    }
  }

  updateCursor();
  if (now - tableClock > 150) {
    tableClock = now;
    refreshTable();
  }
}
requestAnimationFrame(loop);

/* ------------------------------------------------------------------ *
 * 布局 / 尺寸
 * ------------------------------------------------------------------ */

new ResizeObserver(() => paintAll()).observe(lanes);
window.addEventListener('resize', () => paintAll());

buildTimeline();
syncTrackFields();
paintAll();
updateCursor();
refreshTable();

// 验收钩子（playwright 用；业务侧不碰）。**唯一的调试出口**——之前一度在 loop()
// 里另挂了一个 `__fxLab`，两份对象读到的 `asciiDemo` 各自闭包，验收结果对不上。
Object.assign(window, {
  __fxLab: {
    stage: s,
    show,
    play,
    scrubTo,
    pauseAt,
    mode: () => mode,
    t: () => cursorPhase(),
    asciiDemo: () => asciiDemo,
    buildTimeline,
    paintAll,
    serialize: () => serializeTimeline(show, { shock: shockOn }),
    addKeyAt,
    rebuild: () => { buildTimeline(); refreshTable(); },
  },
});
