# nijimi — Agent 约定

nijimi（滲み）是轻量级 WebGL diorama 渲染引擎。职责边界见 `docs/职责边界.md`：引擎只管怎么渲，不写游戏概念。

## 目录约定

| 路径 | 放什么 |
| --- | --- |
| `src/` | 引擎运行时。入口 `src/index.ts`。技术层 `charter` / `npr` / `materials` / `textures` / `particles` / `soft-particles` / `post` / `post-passes` / `output-passes` / `depth-prepass` / `stage`；扩展层 `shader/`（锚点 + 模块 + 参数总线 + 独立材质 `define`）、`effects`（演出时间线）、`frame` / `queue` / `notice`；角色层 `character` / `rig` / `anim` / `expression`；表情契约 `exp-contract`（FROZEN）/ `exp-protocol`；内容层 `kits/`、`scenes/` |
| `editors/` | 六台编辑器：人物 `character`、姿势 `pose`、场景 `scene`、集成 `integrated`、着色器 `shader`、演出 `effects`。`npm run dev` → http://localhost:5200 |
| `pipeline/` | **全部转模型与资产脚本**（Node `.mjs`）。仓库里没有 `tools/` |
| `assets/models/` | 模型本体与转换产物。整目录 gitignore，只有 `README.md` 入库。开发期经 `/models/**` serve |
| `assets/refs/` | 拆包参考：PMX 原文、官方贴图、`REPORT.md`。gitignore |
| `docs/` | 引擎技术文档。先读 `docs/README.md` 和 `docs/职责边界.md` |
| `screenshots/` | **所有截图**。gitignore，只留本机 |
| `public/` | 可进构建的静态文件。拆包模型禁止放这里 |
| `vite.mjs` | 给消费方用的 Vite 插件 `assetCorpus` |
| `dist/` | 构建产物，不手改 |

运行期 URL 只有两种：`/models/**`（本仓 `assets/models/`）和 `/assets/models/**`（消费方 `public/assets/models/` 里可分发的资产）。

旧文档里的 `tools/`、`design/concept/`、`docs/concept/` 已过期。脚本以 `pipeline/` 为准，截图以 `screenshots/` 为准。`assets/models/README.md` 仍写着 `tools/`，不要跟着它走。

## 加效果的唯一路径

内容侧**不改 `src/`**，也不要自己建 `EffectComposer`：

1. **作用在模型表面** → 写一个 `ShaderModule`（纯数据的 GLSL 片段 + 参数声明），
   通过 `createStage(..., { characterModules: [myModule] })` 挂上。参考 `src/shader/modules/rim-pulse.ts`、
   `dissolve.ts`、`ascii-flow.ts`（屏幕空间字形）。也可以写进契约（`material.extras.charter.shader.modules`），
   转换期会用 `npm run check:render-modules` 校验 id 是否存在。**选层与七步清单见
   `docs/渲染管线-着色器扩展与钩子系统.md` §5.5**。
2. **凭空出现的几何**（连线 / 光柱 / 法阵）→ `defineMaterial({ id, vert, frag, builtins, params })`，
   时间/相机 uniform 由引擎给，队列用语义带。参考 `src/kits/conduits.ts`。
3. **粒子贴到几何要淡出**（软粒子）→ `createStage(el, { softParticles: true })`，然后
   `applySoftParticles(material, stage.depth, { params: el.params })`。深度由 `src/depth-prepass.ts`
   在主渲染**之前**单独渲一遍（半分辨率、只写深度、排除透明件）；`stage.post.depthTexture`
   是场景渲完才有的，时序不同，别混用。
4. **整张画面** → `stage.post.insert({ id, anchor: 'afterTonemap', create: () => pass })`，
   成品 pass 见 `src/post-passes.ts`（冲击波 / 深度描边）。锚点语义：
   `beforeTonemap` 线性光 / `afterTonemap` 显示参考未编码 / `afterOutput` LDR。
   需要深度就声明 `reads: ['depth']` 并读 `post.depthTexture`；法线缓冲（MRT）不支持。
5. **一段演出** → `stage.effects.play({ id, duration, params(t), post, overlay })`，
   参考 `src/kits/shows.ts` 的 `chargeBurst()`。演出只驱动参数，不重编 shader。
6. **参数与时间** → `stage.params`（`uTime`/`uDelta`/`uResolution`/`uCamPos` 每帧由引擎写）、
   `stage.onFrame((ctx) => ...)`（真实时间，不是 1/30 动画步长）。
7. **能力缺失** → 读 `stage.notices`，别静默降级（`param-conflict` / `module-missing` / `anchor-missing`）。

手写 GLSL 先在 `/editors/shader.html` 里试（层 B 示范材质 + 源码热改 + 驱动编译日志面板），
试通了再落到 `defineMaterial`。工作台只改内存、不回写文件——GLSL 的真相只能在源码里有一份。

**契约里写模块要过三关**：`pipeline/charter-rules.mjs` 的 `SHADER_MODULES`（准入白名单）→
`MODELS.<id>.shader / roleShader / materialShader`（模型级 / 族级 / 单件）→
`npm run charter`（转换期校验 id）→ `npm run check:render-modules`（与引擎注册表逐项对齐）。
新增一个「随引擎发布」的模块，除了写模块文件，还要在 `src/shader/builtins.ts` 加一行 import——
注册表是 **import 副作用**，漏了的表现是「契约声明了、画面没效果、也不报错」。
**屏幕空间类模块（如 `ascii-flow`）不要进契约白名单**：它属于「这一段演出」，不属于「这个资产」。

**编时间线在 `/editors/effects.html`**（第六台）：关键帧轨道 → `EffectSpec`，播放走真实调度器、
拖动走手动定位。导出的是纯数据代码，贴回 `kits/shows.ts` 即可。说明见 `docs/演出编辑器.md`。
新效果先在编辑器的 ASCII / 参数面板里试常量，再回头编曲线。

`src/shader/anchors.ts` 是唯一允许出现 three chunk 名的地方；升级 three 只改那张表。
设计、契约与实测见 `docs/渲染管线-着色器扩展与钩子系统.md`。

## 截图

浏览器验证、诊断、前后对照，截图一律写到仓库根目录 `screenshots/`。

- 不要写到 `docs/`、`docs/concept/`、`design/concept/`，也不要留在对话临时目录。
- 文件名用小写连字符，带主题前缀，例如 `verify-pose.png`、`diag-si-stand.png`。
- 目录已在 `.gitignore`。文档里引用时写 `screenshots/<文件名>`。

## 转模型工具

位置：`pipeline/`。用 `node pipeline/<脚本>.mjs` 调用。

新模型入料：

```bash
node pipeline/ingest-model-zip.mjs assets/models/<zip> --id <名>
node pipeline/glb-audit.mjs assets/models/<id>.glb --fix
npm run charter && npm run rig
```

| 脚本 | 作用 | 产物 |
| --- | --- | --- |
| `pipeline/ingest-model-zip.mjs` | 解压 zip、测绘、转主 PMX | `assets/refs/<id>/`、`assets/models/<id>.glb`、`REPORT.md` |
| `pipeline/pmx2glb.mjs` | PMX → 原版 GLB。`--expr` 同时导出表情 morph（sparse POSITION delta） | `assets/models/<id>.glb`（原版永不改写） |
| `pipeline/glb-audit.mjs` | PMX→GLB 体检；`--fix` 就地修（先备份 `.bak`） | 同一个 GLB |
| `pipeline/charter-rules.mjs` | 材质契约约定。改规则改这里 | 被转换器读取 |
| `pipeline/charter-glb.mjs` | 原版 → 契约版。`npm run charter` 即 `--all` | `assets/models/<id>.charter.glb`、`charter-manifest.json` |
| `pipeline/expression-rules.mjs` | 表情槽位表 / 名字规则 / 模型档案。**改槽位改这里** | 被导出器与诊断脚本读取 |
| `pipeline/expression-glb.mjs` | 契约 GLB + PMX → 表情契约。`npm run expr` 即 `--all` | `assets/models/expression-manifest.json` |
| `pipeline/rig-rules.mjs` | 骨骼槽位约定。改槽位改这里 | 被生成器读取 |
| `pipeline/rig-glb.mjs` | 骨骼 manifest。`npm run rig` | `assets/models/rig-manifest.json` |
| `pipeline/anim-audit.mjs` | 动画 GLB 体检。`npm run anim-audit` | 终端报告 |
| `pipeline/bake-face-sdf.mjs` | 面部 SDF 烘焙 | 贴图进契约资产 |
| `pipeline/character-rendering-check.mjs` | 角色渲染无 GPU 检查（`npm run check:character-rendering`） | 终端断言 |
| `pipeline/render-modules-check.mjs` | 着色扩展检查：锚点 ↔ three chunk、变体键、ParamBus、层 B、契约声明与注册表对齐（`npm run check:render`） | 终端断言 |

只读或诊断：`pmx-stats.mjs`、`pmx-eye-diag.mjs`、`morph-survey.mjs`、`model-survey.mjs`、`rig-survey.mjs`、`uv-audit.mjs`、`uv-own.mjs`、`sdf-dbg.mjs`、`make-demo-anim.mjs`。

改材质规则改 `pipeline/charter-rules.mjs` 再跑 `npm run charter`；改骨骼槽位改 `pipeline/rig-rules.mjs` 再跑 `npm run rig`；改表情槽位改 `pipeline/expression-rules.mjs` 再跑 `npm run expr`。运行期读 `src/charter.ts`、`src/rig.ts`、`src/expression.ts`，不要在运行期用名字猜材质、骨骼或 morph。

## 表情层（三条命令一条链）

表情是**独立于材质契约**的第二条链（分开写、各自幂等；跑 charter 不会打回表情）：

```bash
# 1) 导出 morph（只有带 --expr 才导；先确认 expression-rules.mjs 里已登记该模型）
node pipeline/pmx2glb.mjs assets/refs/<id>/<x>.pmx assets/models/<id>.glb --name <id> --expr --model <id>
# 2) 契约版（morph 自动继承，不用额外开关）
npm run charter
# 3) 表情契约（槽位 → target 索引 + 残留项 + 左右校验）
npm run expr
```

只读体检：`node pipeline/morph-survey.mjs <pmx>`（覆盖率、空壳检测、槽位命中）。

**加一个能表情的模型要动三处**：`expression-rules.mjs` 的 `MODEL_EXPR`（picks 是本模型上「哪个 morph 才是这个情绪」的判断）→ 重跑上面三步 → 编辑器 `?noviewer=1` 里拉滑条确认。

### 指令面（对外契约，FROZEN）

消费方**只认两个文件**，不碰 manifest 原始结构：

| 文件 | 作用 |
| --- | --- |
| `src/exp-contract.ts` | 指令类型 / 能力表 / 回退语义 / 版本校验。**改动必须升 `EXPR_CONTRACT_VERSION`** |
| `src/exp-protocol.ts` | `witch.exp/1` 指令流：翻译 + 时序 + 缺能力时的回退与 `ExpNotice` |

```ts
c.exp.apply({ op: 'emote', slot: 'happy', motion: 'wave', hold: 2.0 });
c.exp.apply({ op: 'gaze.dir', x: 0.8, y: 0.2 });
```

**调用模型不存在的能力 = 回退 + 提示，不许静默**：同义槽位 → 组级中性 → 整模型丢弃，每级都发 notice
（`slot-alias` / `slot-neutral` / `no-expression` / `motion-unavailable` / `unknown-op`）。
回退语义的唯一实现是 `exp-contract.ts` 的 `resolveSlot()`；`ExpressionLayer` 不做回退判断。

规范文本：`docs/表情层-对外契约.md`（能力矩阵 / notice 表 / 变更流程）。
模型能力来自 manifest 的 `capabilities`（转换期算好，运行期零推导）。

**排错顺序**：编辑器「指令 / WITCH.EXP/1」面板点预置按钮 → 看日志里的 notice code →
`slot-neutral` 表示该模型没有这个槽位（查 `capabilities.missing`），`motion-unavailable` 表示动作系统里没这个动作。

视线两套实现：`gaze.mode = 'morph'`（akane，8 方向 morph 插值）/ `'bone'`（si，转**眼球骨** `左目`/`右目`）。
bone 模式下 `瞳左`/`瞳右` 是眼球骨的子节点（瞳孔卡片），转它们瞳孔不会动 —— 换模型时别按名字猜。
`look_L`/`look_R` 的左右指代因人而异，歧义由档案的 `gaze.mirrorX` 吃掉，契约里 `x>0` 恒等于「角色自己的右」。

拆包模型（原神 / 异环 / 终末地等）只留在 `assets/models/` 和 `assets/refs/`，禁止进 `public/`、`dist/` 和 git。
