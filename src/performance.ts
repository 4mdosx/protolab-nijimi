/**
 * 表演运行时（Performer）—— **唯一写骨者**。
 *
 * 为什么要有这一层（`docs/现状评估-放置游戏展示层.md` P0-1）：
 *   之前引擎里有三套零件，各写各的：`PosePlayer`（姿势 clip / 静态姿势 / 叠加呼吸）、
 *   `CharacterAnim`（外部 GLB clip，AnimationMixer）、`ExpressionLayer`（morph）。
 *   前两套的注释里写着「互斥，同时写骨会打架」，但**没有仲裁者**；舞台更是一行都没接。
 *   于是「角色在工位上干活」这件事在引擎里根本不存在，游戏侧只能自己拼。
 *
 * 这里定的规则：
 *   ① 骨骼只有这一个写入者。poses 与 GLB clip 走同一个 `play()`，内部切模式，
 *      不存在两边同时 update 的可能。
 *   ② 切换一律**从画面当前姿势淡过去**（`PosePlayer.beginFade`），
 *      所以 clip → 姿势、姿势 → clip、clip → clip 三种组合表现一致。
 *   ③ 默认 `idle` 且**不写骨**：没调用过 `play*` 之前，Performer 一帧都不动骨架。
 *      这条是为了不改变既有编辑器里「舞台只是把角色摆在那儿」的行为——接线不等于
 *      强行给所有人套一个 idle。
 *   ④ 表情不归它管：`ExpressionLayer` 写 morphTargetInfluences，骨骼写 bone.quaternion，
 *      两者正交，舞台分别推。要「说话时嘴动、身体不动」时这条正交性就是免费的。
 *
 * 与 `CharacterAnim` 的关系：GLB clip 模式下 Performer 把 mixer 的时间源收进
 * `update(dt)`，dt 由舞台的 1/30 动画步长给。`CharacterAnim` 自己不再被外部 update。
 */

import * as THREE from 'three';
import { CharacterAnim } from './anim';
import {
  PosePlayer,
  buildRig,
  rigModelOf,
  type PoseClip,
  type PoseDeg,
  type Rig,
  type RigManifest,
} from './rig';
import type { CharacterHandles } from './character';

export type PerformanceMode = 'idle' | 'pose' | 'clip';
export type PerformanceEvent = 'end' | 'change';

export interface PerformOptions {
  /** 交叉淡化秒数（默认 0.25） */
  fade?: number;
  /** 覆盖 clip 自带的 loop */
  loop?: boolean;
  /** 播放速率（默认 1） */
  speed?: number;
}

export interface PerformerOptions {
  character: CharacterHandles;
  /** 缺省则用 `character.rig`（游戏侧自己建过就直接给） */
  rig?: Rig | null;
  player?: PosePlayer | null;
  anim?: CharacterAnim | null;
  manifest?: RigManifest | null;
}

export class Performer {
  readonly character: CharacterHandles;
  readonly rig: Rig | null;
  readonly player: PosePlayer | null;
  readonly anim: CharacterAnim | null;

  mode: PerformanceMode = 'idle';
  /** 当前正在播的 pose clip（clip 模式下为 null） */
  poseClip: PoseClip | null = null;
  /** 当前正在播的 GLB clip（pose 模式下为 null） */
  animClip: THREE.AnimationClip | null = null;

  private readonly poseClips = new Map<string, PoseClip>();
  private readonly animClips = new Map<string, THREE.AnimationClip>();
  private readonly listeners = new Map<PerformanceEvent, Set<() => void>>();
  /** 没被 play 过之前不写骨（见文件头 ③） */
  private armed = false;
  private endFired = false;
  private speed = 1;

  constructor(opts: PerformerOptions) {
    this.character = opts.character;
    const manifest = opts.manifest ?? null;
    const model = manifest ? rigModelOf(manifest, opts.character.charter?.id ?? '') : null;

    this.rig = opts.rig ?? (model ? buildRig(opts.character.group, model) : null);
    this.player = opts.player ?? (this.rig
      ? new PosePlayer(this.rig, manifest?.additives ?? {})
      : null);
    this.anim = opts.anim ?? new CharacterAnim(opts.character.group);
    this.anim.onStop = () => this.emit('end');
  }

  /** 有没有骨架可驱动（没有 manifest 的模型也能建 Performer，只是没有槽位） */
  get ready() {
    return this.player !== null;
  }

  /** 是否已经开始表演（idle 且未 arm 时舞台不会每帧写骨） */
  get active() {
    return this.armed;
  }

  /* ---------- 语料 ---------- */

  /** 登记一段姿势动作（`witch.clip/1`），返回 this 便于链式 */
  addPoseClip(...clips: PoseClip[]): this {
    for (const c of clips) this.poseClips.set(c.id, c);
    return this;
  }

  /** 登记一段外部动画（Blender 导出的 AnimationClip） */
  addAnimClip(...clips: THREE.AnimationClip[]): this {
    for (const c of clips) this.animClips.set(c.name, c);
    return this;
  }

  has(name: string): boolean {
    return this.poseClips.has(name) || this.animClips.has(name);
  }

  list(): { pose: string[]; anim: string[] } {
    return { pose: [...this.poseClips.keys()], anim: [...this.animClips.keys()] };
  }

  /* ---------- 播放 ---------- */

  /**
   * 按名字播。**姿势动作优先**（同名的 `witch.clip/1` 胜过 GLB clip）——
   * 姿势动作是引擎原生格式，能吃到叠加层与语义欧拉，GLB 只是兜底。
   * 找不到名字返回 false 并保持现状（不静默切到 idle）。
   */
  play(name: string, opts: PerformOptions = {}): boolean {
    const pose = this.poseClips.get(name);
    if (pose) return this.playPoseClip(pose, opts);
    const clip = this.animClips.get(name);
    if (clip) return this.playAnimClip(clip, opts);
    return false;
  }

  /** 播一段姿势动作（`witch.clip/1`） */
  playPoseClip(clip: PoseClip, opts: PerformOptions = {}): boolean {
    if (!this.player) return false;
    this.arm();
    this.anim?.stop();
    const fade = opts.fade ?? 0.25;
    if (opts.speed !== undefined) this.setSpeed(opts.speed);
    this.player.play(clip, 0, fade);
    this.poseClip = clip;
    this.animClip = null;
    this.endFired = false;
    this.setMode('pose');
    return true;
  }

  /** 摆一个静态姿势（不循环、不前进） */
  playStatic(pose: PoseDeg, opts: PerformOptions = {}): boolean {
    if (!this.player) return false;
    this.arm();
    this.anim?.stop();
    this.player.setStatic(pose, opts.fade ?? 0.25);
    this.poseClip = null;
    this.animClip = null;
    this.endFired = false;
    this.setMode('pose');
    return true;
  }

  /** 播一段外部 GLB 动画 */
  playAnimClip(clip: THREE.AnimationClip, opts: PerformOptions = {}): boolean {
    if (!this.anim) return false;
    this.arm();
    // 姿势层停写：GLB clip 自己会写它覆盖到的骨
    this.player?.stop();
    if (opts.speed !== undefined) this.setSpeed(opts.speed);
    this.anim.play(clip, {
      loop: opts.loop ?? true,
      fade: opts.fade ?? 0.25,
      returnToRest: false,
    });
    this.animClip = clip;
    this.poseClip = null;
    this.endFired = false;
    this.setMode('clip');
    return true;
  }

  /** 收工：淡回 rest（空姿势 = 全部槽位回到 rest） */
  stop(opts: { fade?: number } = {}) {
    const fade = opts.fade ?? 0.25;
    this.anim?.stop();
    this.player?.setStatic({}, fade);
    this.poseClip = null;
    this.animClip = null;
    this.endFired = false;
    this.setMode('idle');
  }

  /** 播放速率（姿势层与 GLB 层同一个值） */
  setSpeed(scale: number) {
    this.speed = scale;
    if (this.player) this.player.opts.timeScale = scale;
    if (this.anim) this.anim.mixer.timeScale = scale;
  }

  get playbackSpeed() {
    return this.speed;
  }

  /* ---------- 每帧 ---------- */

  /** 舞台的 1/30 动画步长调用它；未 arm 时一帧都不写 */
  update(dt: number) {
    if (!this.armed) return;
    if (this.mode === 'clip') {
      this.anim?.update(dt);
      return;
    }
    if (!this.player) return;

    this.player.update(dt);

    // 非循环姿势动作播完：停在末帧 + 出一次 end（与 CharacterAnim 的语义对齐）
    const clip = this.poseClip;
    if (clip && !clip.loop && this.player.playing && this.player.time >= clip.duration) {
      this.player.playing = false;
      if (!this.endFired) {
        this.endFired = true;
        this.emit('end');
      }
    }
  }

  /* ---------- 事件 ---------- */

  on(event: PerformanceEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(event: PerformanceEvent) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn();
      } catch (e) {
        console.warn('[performer] 监听器抛错', e);
      }
    }
  }

  private setMode(mode: PerformanceMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('change');
  }

  private arm() {
    this.armed = true;
  }
}

/**
 * 建一个 Performer：`manifest` 里没有这个模型时也返回对象，只是 `rig` 为 null
 * （GLB clip 仍然能播）。要「找不到骨架」出声，检查 `performer.ready`。
 */
export function createPerformer(
  character: CharacterHandles,
  manifest: RigManifest | null,
  opts: Omit<PerformerOptions, 'character' | 'manifest'> = {},
): Performer {
  return new Performer({ character, manifest, ...opts });
}
