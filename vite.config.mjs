// vite.config.mjs — 引擎自身的开发服务器 + 多页构建。
//
// 资产语料中间件（/models/** → assets/models/**）已抽成可复用插件 nijimi/vite，
// 消费方一行接入；本仓直接用它指向自己的语料目录。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { assetCorpus } from './vite.mjs';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  server: { port: 5200 },
  plugins: [assetCorpus()],
  build: {
    rollupOptions: {
      input: {
        // 编辑器总览（六台编辑器的入口页）
        main: r('index.html'),
        characterLab: r('editors/character.html'),
        poseLab: r('editors/pose.html'),
        sceneLab: r('editors/scene.html'),
        integratedLab: r('editors/integrated.html'),
        shaderLab: r('editors/shader.html'),
        effectsLab: r('editors/effects.html'),
      },
    },
  },
});
