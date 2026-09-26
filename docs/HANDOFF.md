# 交接文档 / 上下文压缩

截至 `aaf4b34`。这份文档的作用是替代之前几轮对话：里面是结论、常量和没做完的事，不是过程。

## 运行与检查

```bash
node server.js --open      # http://127.0.0.1:10240（默认端口，-p 改，PORT 环境变量也行）
node test/verify.js        # 188 项端到端验证；--only=port|http|render|presets|playlist|resample|standalone 可只跑一段
node build-standalone.js   # 改完 public/ 后重新生成单文件版
node test/bench.js         # 性能基准
```

`test/verify.js` 的渲染段跑三遍：默认（WebGL）、`?renderer=2d`、以及 `--disable-webgl` 的强制回退。改渲染相关代码后至少跑 `--only=render`。测试自己抢空闲端口，所以不需要（也不应该）去杀别的 `node server.js`。

推送：`GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p') git push origin main`。

## 硬性要求

1. **没有回扫线。** 不 `closePath`，不跨帧连path，跨帧/回扫用显式阈值丢掉（比平均束速快 `blankRatio` 倍的线段直接不画，默认 3×，范围 1–15× 半档）。
2. **默认没有辉光。** 不用 `shadowBlur`、不用 `lighter`、光束路径上不做模糊。测试对这三个 API 装了 setter 探针，跑完整轮播放后断言全为 0。
3. **光晕是显式开关，默认关。** 开的是 halation（散射），不是模糊滤镜，见下。

## 代码结构

```
public/js/core.js      工具、设置对象 S、DOM 引用、toast、共享 flags（叶子）
public/js/audio.js     音频图、分析器、演示信号、采样率策略
public/js/shaders.js   GLSL 源码
public/js/gl.js        能量渲染器：浮点累积、色调映射、halation pass
public/js/perf.js      帧间隔环、工作耗时环、掉音看门狗、长任务/生命周期
public/js/trace.js     采样→像素、1/束速剂量、两条累积路径
public/js/render.js    几何、刻度、帧循环、画质调节、对外接口
public/js/apply.js     设置对象 ↔ 控件/引擎/画面
public/js/presets.js   预设、按曲记忆、导入导出
public/js/playlist.js  曲目列表、文件选择、播放控制
public/js/ui.js        控件、键盘、面板、拖放
public/js/main.js      接线、window.__scope、init
server.js              零依赖服务器：静态、/api/tracks、/media Range、启动
probe.js               音频头解析（WAV/FLAC/AIFF/CAF/MP4/Ogg/MP3），只读头部不解码
build-standalone.js    把同一批模块内联成单文件
test/verify.js         测试入口：分配端口、起服务器、按 key 顺序跑各段
test/harness.js        断言与计数、HTTP 客户端、起服务器、找 Playwright/Chromium
test/sections/*.js     188 项按失败方式分段：port、http、render-synth、render（会话驱动）、
                       render-blanking/halo/model/axes/profile/audio/surface/theme/webgl-absent、
                       presets、resample、standalone；test/bench.js 性能基准
```

依赖单向无环：`core → {audio, shaders} → {gl, perf, trace} → render → apply → presets → playlist → ui → main`。模块之间只用命名空间调用（`audio.isLive()`）或顶部解构出的别名，禁止跨模块裸变量。拆分的依据是失败方式：GLSL 写错是驱动编译错，perf 写错是日志数字不对，trace 写错是画面不对。

内联器（`build-standalone.js`）只认一种方言：`import * as ns from './x.js'` + `export function/const/{...}`。其他写法一律报错退出：`export default`、`export let`、具名 import、动态 `import()`、import 环、指向不存在导出的别名。它还会 `new Function` 自检产物能不能解析。改模块结构后先跑它，静态错误一秒就报。

## 渲染模型

每个像素当作荧光粉，WebGL2 路径（`gl.js` + `shaders.js`）每帧三次绘制加一次 blit：

```
E += 曝光 · Σ (1/束速) · 光斑      blendFunc(ONE,ONE)，RGBA16F 累积
E *= exp(-dt/τ)                     dt 取 performance.now() 真实差值，上限 0.1
显示 = 颜色 · (1 - exp(-E/E₀))      RGBA8 显示目标，再 blitFramebuffer 到画布
```

关键常量与取值：

| 名字 | 值 | 位置 |
|---|---|---|
| 曝光 | `intensity · 0.19` | `trace.js exposureFor` |
| 光斑 σ | `lineWidth · DPR · 0.5`，恒定，不随剂量变 | `trace.js sigmaFor` |
| 光斑轮廓 | 高斯减去 3σ 处的值，即 3σ 外严格为 0 | `shaders.js FRAG_BEAM` |
| 剂量 | `ref / (s + plot·2e-5)`，`ref` 为平滑后的平均步长（下限 `plot·0.0004`） | `trace.js drawTrace` |
| 剂量平滑 | 沿路径 ±3 采样点取平均（磷酸粉在光斑宽度上积分） | 同上 |
| τ | `-1/60/ln(1-a)`，`a = (1-p/100)²·0.97+0.03` | `trace.js tauFor` |
| 段上限 | 32768 段，每段 5 个 float | `gl.js` |

**halation 云**（`S.halo`，默认 0，只在 WebGL 路径）：加在色调映射之后，输入是有界的已发光亮度。四个尺度取样：mip1（权重 0.34）、mip4（0.24）、mip6（0.22）、mip8（0.20），后三级各先做一次 13 点 tent 模糊，mip6/mip8 再取 `pow(x, 0.75)`（它们取的是格子内平均，会低估 1/r 长尾；不开这一下云只有 2–3/255，滑块拖到头也看不出）。幅度 `2.2·(halo/100)^1.4`，硬上限由 `min(1, L + mix·h)` 保证（`gl.js setHalo` 的上限相应从 1 提到 3）。`halo = 0` 时整个 pass 一次都不跑，画面与旧版逐像素一致。

**8 位回退路径**（Canvas 2D，`trace.js`）：十级 alpha 阶梯，剂量过一条饱和曲线落到阶梯上，阶梯整体乘 `BUCKET_ALPHA = 0.8` 保持原工作点。没有累加缓冲，所以有量化地板：`destination-out` 的 `n ← n×(1-a)` 在 8 位下 `n ≤ 1/(2a)` 是死点，靠每 180 帧一次的全量擦除（`SCRUB_EVERY`）处理，力度由 `残留` 滑块控制。这一路上 `光晕` 置灰，WebGL 路径上 `残留` 置灰。

**渲染器选择是一次性的**：`render.js` 模块加载时 `probeGL()` 先在临时画布上画一段、读回像素、确认真的有光，通过才把真画布交给 WebGL（画布一生只发一种上下文）。`?renderer=2d` 强制回退。顶栏徽章会写当前是 `能量模型` 还是 `8 位路径`。

## 测量出来的工作点

| | 采样窗口 | 余辉 | 线宽 | 亮度 | 备注 |
|---|---|---|---|---|---|
| 默认 | 2048 | 24% | 1.75 | 0.9 | 两者中点 |
| 描边（oscillofun） | 1024 | 16% | 1.15 | 3.5 | Canvas 回退用 0.9 |
| 填充（primer） | 4096 | 32% | 2.3 | 0.1 | Canvas 回退用 0.9 |
| 虚线（参考照片那种） | 512 | 0% | 1.75 | 0.45 | 覆盖率 2.3%，亮暗比 p90/p50 = 3.1 |

- 默认值不是随手挑的：2048/24% 覆盖率 7.9%、过曝 0.66%；2048/62% 是 16.4% 和 5.25%；4096 在任何余辉下过曝都 ≥1.5%。
- 当前默认在 GL 路径上过曝 0.01%（旧的 4096/62% 默认值是 12.8%）。
- 剂量范围：匀速 ×1.00 到静止束流 ×20；这是"一段亮一段不亮"的来源，且必须是笔画尺度而不是采样点尺度。
- 残影（alpha 9–64 占比）：8 位路径 13.98% vs 能量路径 0.02%。
- 光晕径向剖面（合成细线，光晕 100）：`10/18/28/40/55/75/100/130 px → 31/25/18/13/10/8/7/5`，单调、最陡一跳 7、无断崖；光晕 0 时 10 px 与 28 px 处严格为 0。
- 光晕可见性（冻结窗口，oscillofun @20s 密集段）：旧幅度 0.9 时 100% 只把笔画以外抬 +2.58/255（等于看不见），现在 +11.85/255、亮 16 级以上的有 81558 像素、最大 +150；画面四角只抬 +3/255，所以是云不是整屏发灰。稀疏段（@72s）只有 +4.27/255，这是卷积的应有性质。
- 消隐阈值（冻结同一窗口，15× 作参照 = 几乎不消隐）：10× 少画 4.0 / 5.3 / 0.4% 的亮像素（oscillofun @20s 方块 / @72s 穿梭 / primer @2:43 棋盘格），默认的 3× 少画 9.7 / 15.2 / 9.4%；多删的是 3–10× 束速那一段（快，但不明显是回扫），代价落在素材最快的真实扫掠上，穿梭段最敏感。
- 采样率不重采样：与 ffmpeg 解码逐点比对最大差值 0；强制 48 kHz 后残差 −42 dB。

## 设置与预设

`core.js DEFAULTS` 是唯一真源；`PRESET_KEYS` 排除 `rateMode` 与 `renderScale`（描述机器，不描述画面）。预设存在 `localStorage` 的 `scope.presets.v1`，导出格式 `{kind:'oscilloscope-presets', v:1, presets:[...]}`，导入会按控件的 min/max/step 夹取，名字撞车自动让步。两种模式：自动按曲记忆（默认）与手动，两种模式都记录每首歌的参数。

只在一条路径上有效的两个滑块会置灰并把原因写进 `title`（`apply.js rendererOnlyRow`）：`残留` 只在 8 位路径，`光晕` 只在 WebGL。`X 反向` / `Y 反向` 是内容属性（素材手性），跟着每首歌记录，翻转时增益读数带负号。

播放列表另有 `localStorage` 的 `scope.playlist.v1`：`{mode, sortKey, sortAsc, last:{name, size, at}}`。`last` 只写服务器能再给一次的文件（拖进来的 `blob:` 文件刷新就没了），按名字加大小匹配，页面加载时恢复成暂停状态，`?track=` / `?demo=` 优先于它。过滤和排序都不写盘，只有排序方式与升降序记。

## 调试工具

- **帧日志**：`⇧L` 或 `__scope.perf()` / `__scope.perf(60)`。环形 8192 帧（约 2.3 分钟）、200 条事件。给出中位/p90/p99/p99.9/最差、1% 与 0.1% low、超 20/33/50 ms 计数，以及最差几帧的年龄、线段数、光晕开关、是否刚 resize。被浏览器拉长到整秒的帧（隐藏标签页把 rAF 节流到 ~1 Hz）单独计数，并从"去掉被拉长的帧后"的分布里排除。
- **掉音看门狗**：跑在独立的 250 ms 定时器上（不能挂在 rAF 上，隐藏标签页会把 rAF 节流到 1 Hz，那正好是掉音会藏起来的状态）。它记 `音频时钟落后 X ms`（墙上时间减去 `AudioContext.currentTime`，只在整个音频图真的在渲染时前进，所以掉音不触发任何 DOM 事件也能被抓到）、`信号静默`（在播放但分析器全 0）、`音频上下文` 状态变化、`长任务`（Firefox 的 longtask 条目）、`页面 freeze` / `可见性`。时钟归零会单独报成"音频上下文重建（换采样率）"，不是掉音。
- **`window.__scope`**：`state`、`perf(n)`、`readTrace(x,y,w,h)`、`readAnalyser()`、`setRateMode()`。
- **URL**：`?renderer=2d`、`?demo=1`、`?track=N`、`?play=1`。
- 键盘：空格、方向键、`,` `.`、`D`、`F`、`S`、`L`、`M`、`P`、`⇧L`、`B`、`T`、`G`、`O`、`R`、`Esc`。这些曾经全是死的（`onKey` 拆模块时没被绑定），现在有测试盯着。

## 这轮修掉的 bug（症状 → 原因 → 处理）

| 症状 | 原因 | 处理 |
|---|---|---|
| 画面空白、控制台 `tex is already deleted` | `resize()` 先删旧累积纹理再拷贝，采到死纹理 | 先分配、拷贝、最后释放（`gl.js adopt`） |
| 空白但无报错 | 驱动宣称支持浮点渲染目标却丢弃每次绘制 | `probeGL()` 真画真读；`checkFramebufferStatus`；`allocTexture` 清一次避免 lazy init |
| 全屏 pass 画出垃圾 | `vertexAttribDivisor` 是按 attribute location 存的，会从实例化 pass 泄漏过来 | 每个全屏 pass 显式 `divisor 0` |
| 虚线看不见，画面是一张均匀亮网 | 剂量分母里有 `plot×0.0015` 的"防除零地板"，比很多段落实际步长还大，把 1/v 压平到 ~2× | 改成纯数值地板 `plot×2e-5`；剂量沿路径 ±3 平滑 |
| 笔画变成"一串小点" | 光斑宽度写成剂量的函数，相邻采样点剂量不同 → 每段一个小圆盘 | 光斑宽度恢复恒定（物理上也应由束流与聚焦决定） |
| 光晕是一块硬边圆饼 | 光晕加在能量缓冲里，停留处沉积是饱和所需能量的一万倍 → 光晕项自己饱和到截断半径 | halation 移到色调映射之后，作用在有界亮度上 |
| halation 云变成"一串小点" | 对粗 mip 层级做单次双线性取样，放大了纹素格子 | 粗层级先做 13 点 tent 模糊；帧日志显示"最差的帧是 0 段"时说明不是渲染的问题 |
| 光晕开到 100 看不出变化 | 宽尺度的 tap 是格子内平均，1/r 的长尾被平均掉，笔画以外只抬 2.6/255 | mip8 进采样链、64/256 两级过 0.75 次幂、幅度 0.9 → 2.2；测试补了绝对亮度下限与"必须衰减"两条 |
| 所有快捷键都没反应 | `onKey` 拆模块时没被绑定 | 在 `bindControls()` 里绑定，并加断言 |
| `L` 既是播放列表又是帧日志（代码里有两个 `case 'l'`） | 文档与代码不一致 | 以文档为准：`L` 播放列表，`⇧L` 帧日志 |
| 拆模块后启动即报 `rafId is not defined` | 循环状态被当成 trace 状态一起搬走 | 搬回去 |
| 2D 路径残留擦除失效 | 暂停路径调了 `fadeStep()` 却丢掉返回的 alpha | 拆成 `requestWipe()` 与 `fadeStep()` |
| 播放位置记不住（刷新后回到 0） | 节流的哨兵值写成 0："距上次写入" 在页面打开不足 5 秒时永远小于阈值，连 pause 的强制写入都被吞掉 | 哨兵改成 `-Infinity`，`flushPlayhead()` 才真的绕过节流；测试里就是刷新后立即暂停这个场景抓到它的 |
| 音量拖到 0 画面全黑，标签页静音也全黑而播放条说在播 | `HTMLMediaElement.volume` / `.muted` 作用在 `MediaElementAudioSourceNode` **之前**，用它控制听感等于把分析器一起静音（实测 85% 时 RMS 0.098 / 亮 10110 像素 → 0 / 0） | 可听路径改走接在分析器之后的 `volGain`，元素永远音量 1、不静音；标签页静音应用解不开，所以静默 1.2 s 时弹话说明原因（`perf.js watchAudio`） |

## 参考素材教了什么

用户给的照片（真实模拟示波器 + bilibili 上的 Oscillofun 视频）确立了这几件事：

1. 慢的地方亮成一段、快的地方几乎看不见，1/v 的动态范围必须够大。
2. 亮球出现在笔画端点，那是亮点被散射糊成球，不是光斑变宽。
3. 光晕的形状是包住整个图形的一团宽雾，不是点上的光晕；密集图形周围明显、单根细线周围几乎看不见。
4. 同一台机器上不同段落的光晕大小不同，所以它必须由剂量驱动。
5. 手性：参考机器可能把 Y 反接，需要 X/Y 反向开关。

## 未完成

- `docs/preview.png`、`docs/preview-primer.png`、`docs/preview-warp.png` 还是"光斑随剂量变宽、1/v 被压平"时期截的，观感偏旧；`docs/energy-vs-canvas.png` 与 `docs/ui.png` 是当前的。
- `playlist.js`（469 行）里的客户端 `probeNativeRate` 还没拆，它和服务端的 `probe.js` 解析的是同一批容器，两边都改的时候容易只改一边。`test/sections/presets.js`（311）稍微超过 300 行，但整段就是一个功能，暂时不动。`presets.js`（415）与 `audio.js`（387）内聚，不建议动。
- 一次"卡且没声音"没能稳定复现。已有日志抓到过两种情况：一是隐藏标签页的 rAF 被节流到 1 Hz（那不是卡顿），二是换采样率导致 AudioContext 重建（那不是掉音）。真正待抓的是 `音频时钟落后` 或 `音频上下文 → interrupted` 或 `页面 freeze`。复现时按 `⇧L` 把日志贴出来。
- 裸 `.aac`（ADTS）与 `.webm/.weba`（EBML）没有解析，会退回设备采样率，也就是会被重采样。已知缺口。
- 根目录有个未跟踪的 `package-lock.json`（本项目零依赖）。提交与否由用户决定，之前误提交过一次已回滚。

## 协作约定

- 每条结论都要有测量支撑；做不到的事直接写在文档里，不含糊。
- 界面文案简短；文档不要"AI 味"：不加粗强调、不用引用块、不拿破折号当标点、不写"不是 X 而是 Y"。
- 控件不许撒谎：拖得动就必须有用；只在一条路径上有效的会置灰并写明原因；读数要显示真正在用的值。
- 长命令放后台跑（前台超时被 SIGTERM 会连带把同一会话里的进程一起带走，曾经把用户正在跑的服务器杀过）。不要 `pkill -f "node server.js"`，测试自己抢空闲端口。
- 别留半成品；改完随手跑对应测试段，提交前跑全量（188 项）。
- 大于 300 行的文件考虑拆，拆分依据是失败方式而不是行数。

## 环境

- 开发机 Apple M5 / 10 核，macOS 26.6，Firefox 36（用户日常浏览器）、Chromium（Playwright 驱动测试）。
- 测试音轨在项目根目录但不进版本库（约 300 MB）：`oscillofun.flac`（44.1 kHz/16-bit）、`primer-final.flac`（192 kHz/24-bit）。
- `ffmpeg`/`ffprobe` 可用（测试用它生成 m4a/aiff/aifc/caf/mp3/ogg 夹具，也用来左右拼接对比图）。Playwright 全局安装，`test/verify.js` 会自己找。
- 仓库 https://github.com/CHT-1192/web-oscilloscope-music-player-visualizer ，许可 Apache-2.0。
