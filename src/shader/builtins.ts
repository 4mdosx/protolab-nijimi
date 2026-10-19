/**
 * 随引擎发布的内建模块 —— **一个副作用导入，登记全部**。
 *
 * 为什么需要这个文件：注册表是「谁被 import，谁就存在」。在此之前只有
 * `modules/npr` 被静态导入（npr.ts 要它的 NPR_MODULES），于是出现过一个
 * 很难查的现象：契约里写了 `dissolve@1`，`resolveModules` 返回空数组，
 * 材质照常编译、照常渲染，只是**效果不存在**——没有报错，画面「看起来对」。
 *
 * 结论：凡是要解析契约模块 id 的入口（角色渲染、舞台、库使用方），都必须先
 * import 这里，让「引擎声称支持的模块」与「运行期真能解析的模块」是同一个集合。
 * 新增随引擎发布的模块时，在下面加一行即可；只给内容仓自用的模块不要放进来
 * （它们由内容侧自己 import 自己登记）。
 *
 * 注意别把这个文件 import 进 `module.ts`：模块文件本身要 import `module.ts` 的
 * `registerModule`，反向依赖会在 `registry` 的 TDZ 里炸掉。
 */

import './modules/npr';
import './modules/dissolve';
import './modules/rim-pulse';
import './modules/soft-particles';
import './modules/ascii-flow';

/** 供调用方「显式引用」用：`ensureBuiltinModules()` 读起来比裸 import 更像意图。 */
export const BUILTIN_MODULES = true;
