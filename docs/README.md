# nijimi/docs/ — 引擎技术文档

**nijimi（滲み）**：轻量级 WebGL diorama 渲染引擎。

三层结构
- 技术层 charter/npr/materials/textures/particles/soft-particles/post/depth-prepass/stage
- 角色层 character/rig/anim 
- 内容层 kits/scenes），入口 `src/index.ts`

编辑器在 `editors/`，资产管线在 `pipeline/`。

## 目录速查

```
src/index.ts        引擎入口（技术层 / 角色层 / 内容层三层 barrel）
src/stage.ts        舞台总装（createStage：渲染器/后期/相机 rig/帧循环）
src/scenes/         ScenePack 契约 + 自带示例内容包（workshop）
editors/            六台编辑器（人物 / 姿势动画 / 场景 / 集成 / 着色器 / 演出），npm run dev → :5200
pipeline/           资产管线（pmx2glb → glb-audit → charter-glb → rig-glb → anim-audit）
assets/models/      契约资产语料（gitignore，dev 期经 /models/** serve）
assets/refs/        拆包参考（PMX 原文 / 官方贴图 / REPORT）
vite.mjs            消费方用的 Vite 插件（assetCorpus）
```

**新模型入料一条龙**：

```bash
node pipeline/ingest-model-zip.mjs assets/models/<zip> --id <名>
node pipeline/glb-audit.mjs assets/models/<id>.glb --fix   # 三条铁律体检
npm run charter && npm run rig                              # 契约版 + 骨骼 manifest
```

要表情（morph）就多两步：

```bash
node pipeline/pmx2glb.mjs <pmx> assets/models/<id>.glb --name <id> --expr --model <id>
npm run charter && npm run expr      # 契约版（继承 morph）+ 表情契约
```

## 设计文档

| 文档 | 说什么 |
| --- | --- |
| [角色渲染流程](角色渲染流程.md) | 各入口共用的 SDF 准备、状态、NPR 材质契约与释放流程 |
| [渲染管线-着色器扩展与钩子系统](渲染管线-着色器扩展与钩子系统.md) | 现状测绘 / 管线评审（20 条）/ 三层扩展与五族钩子 / 商业引擎对照 / **P0–P3 落地记录（§5.1–§5.4）** / **新增效果的决策树与清单（§5.5，以 ascii-flow 为例）** |
| [演出编辑器](演出编辑器.md) | 第六台编辑器：关键帧轨道怎么变成 `EffectSpec`、播放 / scrub 两条路径、ASCII 演示、导出与实测 |
| `职责边界.md` | 引擎与内容的分界。**消费方只看这里** |
| `表情层-对外契约.md` | **FROZEN**：`witch.exp/1` 指令集、三模型能力矩阵、回退与提示语义。消费方只读这份 |
| `表情层-系统设计与指令协议.md` | 为什么这么设计：表情通道（语义槽位 → morph/材质/眼骨）、参考项目对照、实施阶段。落地记录见其 §10 |

相关脚本：`pipeline/morph-survey.mjs`（PMX 表情资产体检，只读，对 35 个语义槽位报覆盖率）、
`pipeline/expression-rules.mjs`（槽位表 / 模型档案 / 回退规则的唯一源）、`pipeline/expression-glb.mjs`（产出
`assets/models/expression-manifest.json`）。运行期 `src/expression.ts` 只读那份 manifest；
`src/exp-contract.ts` 是冻结接口，`src/exp-protocol.ts` 是指令流（回退 + 提示的唯一实现）。
