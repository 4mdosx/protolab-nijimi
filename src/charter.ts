/**
 * 角色资产契约 — 消费端（终末地核心）
 *
 * 契约的生产方在 `tools/`：`charter-rules.mjs`（约定的数据面：材质族表 / 终末地通道表 /
 * 名字规则 / 模型档案）与 `charter-glb.mjs`（把约定写进 GLB 的 extras）。
 * 这里只做三件事：**读契约**、**读族→轨道的表**、把契约里 glTF 表达不了的项
 * （自发光强度、深度写、渲染层、描边策略）施加到 three 对象上。
 *
 * ⚠️ 纪律：本文件**不得**出现任何基于材质名的判定。名字判定属于转换期，
 * 运行期只认 `material.userData.charter`。新增模型时改 `tools/charter-rules.mjs`，
 * 不要在这里加 if。
 *
 * 材质契约字段（写在 glTF material.extras.charter）：
 *   version   契约版本（消费端可据此拒绝旧资产）
 *   role      材质族（= 终末地的部位族）：face skin hair cloth metal glow eye mouth decal outline misc
 *   track     渲染轨道：npr pbr unlit outline（由 role 推导，冗余存一份便于阅读）
 *   layer     渲染层（同批透明件的绘制顺序；默认沿用 PMX 材质序）
 *   pmxOrder  原 PMX 材质序（溯源）
 *   srcName   原材质名（拆包模型的中文名，便于对照）
 *   hit       判定来源 rule / override（区分通用规则命中与人工覆盖）
 *   channels  该材质用到的终末地通道集合（D/N/P/RD/RS/M/ST/E/SDF/HN/MRO/LUT/MatCap）
 *   faceGlow  面部自发光强度（仅 face）
 *   metalGlow 金属微自发光强度（仅 metal，缺省 0.1）
 *   outline   描边壳策略 enable / hide（仅 outline）
 *   shader    表面着色模块（可选；id 指向 src/shader 的注册表，转换期校验）
 *
 * 契约 v2 起允许 **新增可选字段**。`shader` 是 P2 加的：把「这个部位要不要元素化 /
 * 要不要细节层」从运行期猜测搬到资产声明里，转换期就能查出「模块名打错」。
 */

import * as THREE from 'three';
import { setQueue } from './queue';

export const CHARTER_VERSION = 2;

/** 材质族（终末地的部位族）——枚举、依据与通道见 tools/charter-rules.mjs 的 FAMILIES */
export type CharterRole =
  | 'face' | 'skin' | 'hair' | 'cloth' | 'metal' | 'glow'
  | 'eye' | 'mouth' | 'decal'
  | 'outline' | 'misc';

/** 渲染轨道。只有四条——多一条就多一条要维护的分支。 */
export type CharterTrack = 'npr' | 'pbr' | 'unlit' | 'outline';

/**
 * 族 → 轨道（与 tools/charter-rules.mjs 的 FAMILIES[].track 必须一致）。
 * 终末地 Hybrid NPR 的落点：面部/发/布 NPR，身体与装甲 PBR，脸部叠加件 unlit。
 * 消费端（npr.ts）与编辑器都查这张表，不再各自维护一份。
 */
export const TRACK_OF_ROLE: Record<CharterRole, CharterTrack> = {
  face: 'npr',
  skin: 'pbr',    // [公开拆解] 终末地「身体 PBR」——与面部的 NPR 形成分区
  hair: 'npr',
  cloth: 'npr',
  metal: 'pbr',
  glow: 'npr',    // 自发光不是独立轨道：是 npr + 转换期烘好的 emissiveMap
  eye: 'unlit',
  mouth: 'unlit',
  decal: 'unlit',
  outline: 'outline',
  misc: 'npr',
};

/**
 * 表面着色声明。两种层级，可叠加：
 *   模型级（scene.extras.charter.shader）  → 全身生效，例如「这个角色有元素化能力」
 *   材质级（material.extras.charter.shader）→ 只作用于该部位，例如「只有发梢会溶解」
 *
 * 只写 **id**（可带 `@版本`），不写 GLSL——GLSL 归引擎/内容仓的代码，资产只声明意图。
 */
export interface CharterShader {
  /** 模块 id 列表（`src/shader/modules` 注册表里的 key，可带 `@version`） */
  modules?: string[];
}

export interface CharterMaterial {
  version: number;
  role: CharterRole;
  track: CharterTrack;
  layer: number;
  pmxOrder: number | null;
  srcName: string;
  hit: 'rule' | 'override';
  /** 该材质用到的终末地通道（转换期由贴图溯源得出） */
  channels?: string[];
  faceGlow?: number;
  metalGlow?: number;
  outline?: 'enable' | 'hide';
  /** morph 驱动件（口腔系）：模型无 morph targets 时渲染端整件隐藏 */
  morphOnly?: boolean;
  /** 该部位的着色模块（可选）；与模型级声明叠加 */
  shader?: CharterShader;
  [k: string]: unknown;
}

export interface CharterModel {
  version: number;
  id: string;
  name: string;
  source: string;
  license: string;
  /** 编辑器摆正角（弧度）。该角与编辑器固定机位绑定，不是模型的固有属性。 */
  defaultRotY: number;
  /** 归一化身高（米） */
  targetHeight: number;
  /** 房间站位（主场景用；null = 待标定） */
  standPosition: [number, number, number] | null;
  standRotY: number | null;
  /**
   * 面部 SDF 阴影贴图文件名（相对于 /models/）。契约 v3 起 face 族全量启用
   * SDF 明暗（终末地脸部专项），无景别门控。缺省 = 无 SDF，face 走普通 NPR 明暗。
   */
  faceSdf?: string | null;
  /** 全身着色模块（可选）；与材质级声明叠加 */
  shader?: CharterShader;
}

/** 读材质契约。未标注返回 null（调用方应退回名字兜底，并记入报告）。 */
export function materialCharter(mat: THREE.Material | null | undefined): CharterMaterial | null {
  const c = (mat?.userData as { charter?: CharterMaterial } | undefined)?.charter;
  if (!c || typeof c.role !== 'string') return null;
  return c;
}

/** 读模型契约（写在 glTF scene.extras.charter）。 */
export function readModelCharter(root: THREE.Object3D): CharterModel | null {
  const c = (root.userData as { charter?: CharterModel } | undefined)?.charter;
  return c && typeof c.id === 'string' ? c : null;
}

/**
 * 从贴图名读终末地通道。契约版把贴图重命名为 `tex<PMX贴图序>_<通道>`
 * （见 tools/charter-glb.mjs），所以通道名**就在名字里**——查看器据此显示，
 * 不必再拉一份 manifest。未走契约的资产返回 null。
 */
export function channelOfTexture(tex: THREE.Texture | null | undefined): string | null {
  const n = tex?.name ?? '';
  const m = /^tex\d+_([A-Za-z]+)$/.exec(n);
  return m ? m[1] : null;
}

export interface CharterReport {
  /** 命中契约的材质数 */
  bound: number;
  /** 未标注契约的材质名（应回退名字兜底——出现在这里说明资产没走契约转换） */
  unbound: string[];
  /** 族分布 */
  roles: Partial<Record<CharterRole, number>>;
  /** 模型档案 id（null = 资产未标注） */
  modelId: string | null;
  /** 因「模型无 morph targets」被整件隐藏的 morph 驱动件（口腔系） */
  morphOnlyHidden: string[];
}

export interface ApplyCharterOptions {
  /** 是否设 castShadow/receiveShadow（默认 true） */
  shadows?: boolean;
  /** 贴图各向异性（默认 8） */
  anisotropy?: number;
}

/**
 * 施加契约。这是**替代**原先散落在 character.ts 里的 PMX 修正的地方：
 * 面部自发光（原 FACE_MAT_RE）、透明件深度写与渲染层（原 extras.pmxOrder 直读）、
 * 隐藏描边壳（原「发轮廓线」特判）——全部改为读契约字段。
 */
export function applyCharter(
  root: THREE.Object3D,
  opts: ApplyCharterOptions = {},
): CharterReport {
  const { shadows = true, anisotropy = 8 } = opts;
  const report: CharterReport = {
    bound: 0,
    unbound: [],
    roles: {},
    modelId: readModelCharter(root)?.id ?? null,
    morphOnlyHidden: [],
  };
  const seen = new Set<THREE.Material>();

  // morph 驱动件（口腔系）的前提是模型有 morph targets 可驱动；
  // pmx2glb 目前不导出 morph（morph=0），口内贴片悬在闭着的嘴唇前 → 嘴永远「张开」。
  // 等 Blender 流程 / pmx2glb 把 morph 带进 GLB，这里自动放行，不用改代码。
  let hasMorphs = false;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry.morphAttributes && Object.keys(mesh.geometry.morphAttributes).length > 0) {
      hasMorphs = true;
    }
  });

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (shadows) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    // 蒙皮网格的包围盒不含骨骼位移，转身会被整块裁掉
    mesh.frustumCulled = false;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);

      const c = materialCharter(mat);
      if (!c) {
        report.unbound.push(mat.name || '(未命名)');
        continue;
      }
      report.bound++;
      report.roles[c.role] = (report.roles[c.role] ?? 0) + 1;

      const std = mat as THREE.MeshStandardMaterial;
      if (std.map) std.map.anisotropy = anisotropy;

      // ① 面部自发光修正：MMD 脸部≈无光照渲染，冷底光会把青绿虹膜压成灰块。
      //    强度由契约字段给（原先是 character.ts 里的 0.55 魔数）。
      const glow = c.faceGlow ?? 0;
      if (c.role === 'face' && glow > 0 && std.map) {
        std.emissive.setScalar(1);
        std.emissiveMap = std.map;
        std.emissiveIntensity = glow;
      }

      // ② 透明叠加件：MMD「材质顺序即叠加顺序」glTF 无此语义 ——
      //    契约的 layer 就是那张序表（默认 = PMX 材质序，人工覆盖可修正）。
      //    队列走语义带 decal（不透明主体之后），带内用 layer 保序。
      if (mat.transparent) {
        mat.depthWrite = false;
        setQueue(mesh, 'decal', c.layer);
      }

      // ③ 描边壳：PMX 里靠 alpha=0 隐藏。曾试过「转反向 hull」
      //    （toNprMaterial outline 分支），实测 akane 的壳是全身复制
      //    （17199 顶点、bbox=全身），BackSide 壳在蒙皮网格上产生
      //    全身轮廓紫黑噪点镶边（2026-10-16 动作编辑器实测对照：
      //    隐藏壳后噪点消失）——在 hull 稳定前一律恢复原语义隐藏。
      if (c.role === 'outline') {
        mesh.visible = false;
      }

      // ③b morph 驱动件：无 morph targets 就没有「张嘴」这件事，整件隐藏
      if (c.morphOnly && !hasMorphs) {
        mesh.visible = false;
        report.morphOnlyHidden.push(mat.name || '(未命名)');
      }

      // ④ 金属微自发光：金属件在暗部/逆光下容易死黑成一块剪影，
      //    给一点 albedo 驱动的自发光保住形体与「上过油」的高光感。
      //    强度契约字段 metalGlow 可覆盖（缺省 0.1，很小，只是兜底不是打光）。
      //    消费端要重标定时读 materialCharter(mat)?.metalGlow，不另设 userData 字段。
      if (c.role === 'metal') {
        std.emissive.setScalar(1);
        if (std.map) std.emissiveMap = std.map;
        std.emissiveIntensity = c.metalGlow ?? 0.1;
      }
    }
  });

  return report;
}
