/** 舞台自有灯光与后期的可序列化契约；不包含场景内容、相机或 GPU 对象。 */
export interface PresetLight {
  color: string;
  intensity: number;
  position: [number, number, number];
}
export interface VisualPreset {
  version: 1;
  exposure: number;
  npr: boolean;
  environmentIntensity: number;
  lights: {
    hemi: { color: string; groundColor: string; intensity: number };
    ambient: { color: string; intensity: number };
    key: PresetLight & { target: [number, number, number] };
    moon: PresetLight;
    fill: PresetLight;
  };
  bloom: { enabled: boolean; strength: number; radius: number; threshold: number };
  grade: {
    vignette: number; vignettePower: number; strength: number;
    saturation: number; contrast: number; shadowTint: string; highlightTint: string;
  };
}

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  const result = value as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(result, key)) throw new Error(`${path}.${key} 缺失`);
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${path}.${key} 不受支持`);
  return result;
}
function number(value: unknown, path: string, min = 0, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} 必须是 ${min} 到 ${max} 范围内的有限数值`);
  }
  return value;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} 必须是布尔值`);
  return value;
}
function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${path} 必须是 #RRGGBB 颜色`);
  return value.toLowerCase();
}
function vector(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path} 必须是三维坐标`);
  return value.map((v, i) => number(v, `${path}[${i}]`, -Infinity)) as [number, number, number];
}
function light(value: unknown, path: string, target = false): PresetLight & { target?: [number, number, number] } {
  const p = object(value, path, ['color', 'intensity', 'position', ...(target ? ['target'] : [])]);
  return {
    color: color(p.color, `${path}.color`), intensity: number(p.intensity, `${path}.intensity`),
    position: vector(p.position, `${path}.position`),
    ...(target ? { target: vector(p.target, `${path}.target`) } : {}),
  };
}
/** 完整校验并重建独立数据。拒绝未知版本/字段，不静默修正错误。 */
export function parseVisualPreset(value: unknown): VisualPreset {
  const p = object(value, 'preset', ['version', 'exposure', 'npr', 'environmentIntensity', 'lights', 'bloom', 'grade']);
  if (p.version !== 1) throw new Error('不支持的视觉预设版本（需要 version: 1）');
  const l = object(p.lights, 'lights', ['hemi', 'ambient', 'key', 'moon', 'fill']);
  const h = object(l.hemi, 'lights.hemi', ['color', 'groundColor', 'intensity']);
  const a = object(l.ambient, 'lights.ambient', ['color', 'intensity']);
  const b = object(p.bloom, 'bloom', ['enabled', 'strength', 'radius', 'threshold']);
  const g = object(p.grade, 'grade', ['vignette', 'vignettePower', 'strength', 'saturation', 'contrast', 'shadowTint', 'highlightTint']);
  return {
    version: 1, exposure: number(p.exposure, 'exposure'), npr: boolean(p.npr, 'npr'),
    environmentIntensity: number(p.environmentIntensity, 'environmentIntensity'),
    lights: {
      hemi: { color: color(h.color, 'lights.hemi.color'), groundColor: color(h.groundColor, 'lights.hemi.groundColor'), intensity: number(h.intensity, 'lights.hemi.intensity') },
      ambient: { color: color(a.color, 'lights.ambient.color'), intensity: number(a.intensity, 'lights.ambient.intensity') },
      key: light(l.key, 'lights.key', true) as PresetLight & { target: [number, number, number] },
      moon: light(l.moon, 'lights.moon'), fill: light(l.fill, 'lights.fill'),
    },
    bloom: { enabled: boolean(b.enabled, 'bloom.enabled'), strength: number(b.strength, 'bloom.strength'), radius: number(b.radius, 'bloom.radius', 0, 1), threshold: number(b.threshold, 'bloom.threshold') },
    grade: {
      vignette: number(g.vignette, 'grade.vignette', 0, 1), vignettePower: number(g.vignettePower, 'grade.vignettePower', 0.01),
      strength: number(g.strength, 'grade.strength', 0, 1), saturation: number(g.saturation, 'grade.saturation'), contrast: number(g.contrast, 'grade.contrast'),
      shadowTint: color(g.shadowTint, 'grade.shadowTint'), highlightTint: color(g.highlightTint, 'grade.highlightTint'),
    },
  };
}
export interface VisualPresetController {
  capture(): VisualPreset;
  apply(value: unknown): void;
  reset(): void;
}
/** 先校验再提交；默认值、调用方与舞台之间不共享可变对象。 */
export function createVisualPresetController(read: () => VisualPreset, write: (preset: VisualPreset) => void): VisualPresetController {
  const defaults = parseVisualPreset(read());
  return {
    capture: () => parseVisualPreset(read()),
    apply: (value) => write(parseVisualPreset(value)),
    reset: () => write(parseVisualPreset(defaults)),
  };
}
