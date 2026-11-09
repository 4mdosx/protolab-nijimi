import type { VisualPresetController } from '../src/visual-preset';

const STORAGE_KEY = 'nijimi.scene.visual-preset.v1';
const MAX_BYTES = 64 * 1024;
/** 持久化留在编辑器；运行时不依赖 localStorage 或下载 API。 */
export function mountScenePresets(visual: VisualPresetController, refresh: () => void): void {
  const status = document.getElementById('presetStatus')!;
  const file = document.getElementById('presetFile') as HTMLInputElement;
  const report = (message: string, error = false) => {
    status.textContent = message;
    status.style.color = error ? '#ffb4a2' : '#9ed9cd';
  };
  const run = (action: () => void, success: string) => {
    try { action(); report(success); }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); }
  };
  const applyText = (text: string) => {
    if (new Blob([text]).size > MAX_BYTES) throw new Error('预设文件不能超过 64 KB');
    visual.apply(JSON.parse(text));
    refresh();
  };
  document.getElementById('savePreset')!.addEventListener('click', () => run(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visual.capture()));
  }, '已保存到此浏览器；可导出 JSON 备份。'));
  document.getElementById('loadPreset')!.addEventListener('click', () => run(() => {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text === null) throw new Error('还没有保存的预设');
    applyText(text);
  }, '已恢复保存的视觉预设。'));
  document.getElementById('resetPreset')!.addEventListener('click', () => run(() => {
    visual.reset(); refresh();
  }, '已恢复启动默认值；未覆盖保存的预设。'));
  document.getElementById('exportPreset')!.addEventListener('click', () => run(() => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(visual.capture(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nijimi-visual-preset.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, '已发起 JSON 下载。'));
  document.getElementById('importPreset')!.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected) return;
    if (selected.size > MAX_BYTES) { report('预设文件不能超过 64 KB', true); return; }
    try { applyText(await selected.text()); report('已导入预设；点击保存可留在此浏览器。'); }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); }
  });
  report('保存灯光与后期；不包含相机、资产和场景内容。');
}
