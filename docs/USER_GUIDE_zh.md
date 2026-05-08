# ComfyUI-Drawer 用户指南

本文档比 README 更详细地介绍 ComfyUI-Drawer 的功能。它也适合作为 AI 介绍 ComfyUI-Drawer、回答问题或提供支持时的上下文。

## 核心理念

ComfyUI-Drawer 并不是把 ComfyUI 节点图替换成另一个独立应用。节点图仍然保持可编辑，而制作过程中经常触碰的操作界面会集中到底部 Drawer 中。

在桌面端，Drawer 像是画布上工作流的遥控层。在移动端和小屏幕上，Drawer 本身可以成为主要操作界面。它的目标是把参数调整、输出查看、模型选择、搜索、词典、蒙版编辑和 XYZ 测试集中到同一个地方。

Drawer 内运行的工具称为 gadget。内置 gadget 包括 Home、Deck、XYZ Plot、Gallery、Model Viewer 等。外部自定义节点也可以添加自己的 gadget。

## 从哪里开始

安装 ComfyUI-Drawer 后，ComfyUI 画面底部会出现 Drawer 标签栏。点击标签打开 Drawer，再次点击同一标签关闭 Drawer。

主要入口如下：

- Home：状态、存储概览、更新记录和系统信息
- Deck：工作流主要参数控制
- XYZ Plot：改变参数并批量生成
- Gallery：管理 output/input/temp 中的媒体
- Model Viewer：浏览并应用 models 路径下的模型
- Settings：主题、词典、搜索索引、缓存和维护操作

## Home

Home 是 Drawer 的仪表盘。它显示当前 Drawer 版本、ComfyUI/Python/PyTorch 系统信息、存储使用情况和更新记录。

存储概览可以查看 output、input、models 等位置的容量使用情况。在有大量生成图片或视频的环境中，进入 Gallery 或 Model Viewer 前先看整体情况会很方便。

Home 也可以接收外部 gadget 提供的 widget。第三方扩展可以把自己的状态面板或快捷入口放到 Home。

## Deck

Deck 会把工作流中的指定节点和分组显示为 Drawer 侧的控制面板。你可以保持节点图打开，同时只暴露常用参数。

### 显示标记

Deck 会读取节点和分组标题中的标记。

| 标记 | 目标 | 含义 |
|---|---|---|
| `📝` | 节点标题 | 在 Deck 主界面显示该节点的 widget |
| `⚡` | 节点或分组标题 | 显示 bypass ON/OFF 开关 |
| `[标签]` | 节点或分组标题 | 同一标签的项目互斥切换 |

节点按画布上的 Y 坐标排序，分组按 X 坐标排序。如果分组中包含可见节点，该分组也会作为 Deck 中的 section 显示。

### DrawerControls

DrawerControls 节点可以把多个工作流参数集中到 Deck。只有已连接的输出会显示。支持 `int`、`float`、`combo`、`bool`、`string` 等控制类型。

字符串输出可以指定标签和多行输入：

```text
string | Label
string | Label | multiline
```

Combo 候选项会从连接目标 widget 读取。如果想整理 Deck 布局，使用 DrawerControls 往往比在许多普通节点上直接添加标记更容易管理。

## XYZ Plot

XYZ Plot 是通过扫参数进行批量生成的 gadget，理念上接近 A1111 的 XYZ Plot。它不需要专用 XYZ 节点或额外连线。当前工作流中已有的 widget 和 bypass 状态都可以作为扫描目标。

### 基本流程

1. 为 X/Y/Z 轴选择目标节点和 widget。
2. 设置值列表或范围。
3. 运行预检查。
4. 开始生成，每个组合会依次入队。
5. 带轴标签的网格图保存到 output。

文本 widget 支持 Prompt S/R，也就是 Search & Replace 模式。种子以扫描开始时的状态为基准固定。每次迭代会先恢复快照，然后只应用轴值。

### Bypass 轴

XYZ Plot 不仅可以扫描数值和文本，也可以扫描节点和分组的 bypass 状态。

- 单个节点 ON/OFF
- Deck 分组开关
- 分组互斥开关
- 节点互斥开关

这可以用于比较 prompt 差异、采样器设置、LoRA 选择、ControlNet 分支以及其他工作流分支。

### 执行保护

扫描期间，普通队列提交会被暂时阻止，避免外部操作混入扫描。如果检测到服务器断开连接，扫描会中止。

## Gallery

Gallery 管理 output、input、temp 下的媒体和文件夹。它支持图片、视频、音频和文件夹。

### 基本操作

- 切换 output/input/temp
- 文件夹导航和面包屑
- 按名称/日期/大小排序
- 文件名搜索
- 重命名文件和文件夹
- 移动文件和文件夹
- 删除文件
- 新建文件夹
- 将图片发送到 LoadImage / LoadImageMask
- 在 Lightbox 中打开图片、视频和音频
- 从图片打开工作流

在可用环境中，删除会把文件发送到系统回收站，而不是永久删除。

### 搜索索引

文件名搜索不需要搜索索引。要搜索 prompt、workflow、节点类型、节点标题或自定义元数据，需要创建 SQLite 搜索索引。

索引只会在用户明确开始时创建，因此 Drawer 不会在大型媒体库中静默启动重扫描。创建前会进行快速估算，并根据文件数量和预计时间显示确认对话框。

索引创建后，文件新增、移动、重命名和删除会以低优先级同步。已有文件的元数据被视为搜索快照，普通同步不会重新解释它们。如果 provider 或 contributor 被添加或修改，同步会切换到元数据 refresh 路径。

### 搜索语法

空格分隔的词会作为 AND 条件：

```text
white hair blue eyes
```

引号中的文本会作为短语：

```text
"white dress"
```

使用 `-word` 或 `-"quoted phrase"` 表示 NOT 条件：

```text
white hair -night
"flower field" -"low quality"
```

使用 `type:...[]` 只搜索指定节点类型中的值。`[]` 部分相当于虚拟搜索框。

```text
type:CLIPTextEncode[white hair -night]
```

使用 `title:...[]` 按节点标题过滤。

```text
title:positive[blue sky]
title:"Prompt A"[school uniform]
```

如果注册了第三方自定义元数据 contributor，可以这样搜索：

```text
myPlugin[black hair]
myPlugin:tags[black hair]
myPlugin:project[archive A]
```

`namespace[value]` 搜索该 namespace 内的所有自定义字段。`namespace:key[value]` 只搜索指定 key。

### 搜索范围过滤

Gallery 的搜索范围菜单可以切换以下目标：

- 文件名
- prompt title
- prompt 值
- workflow title
- workflow 值
- 自定义元数据

只有注册了 index contributor 时，自定义元数据选项才会显示。没有 contributor 时它会隐藏，也不会被包含在搜索目标中。

### 元数据面板

从 Gallery 可以打开元数据面板，查看文件概要、workflow 节点概要、prompt 值和 Raw JSON。

如果注册了第三方 metadata panel contributor，也可以在这里显示自定义元数据。Drawer 不强制第三方使用特定存储格式；contributor 决定如何把自己的数据展示给 Drawer。

## Model Viewer

Model Viewer 浏览 ComfyUI 的 `models` 文件夹，以及通过 `extra_model_paths.yaml` 添加的模型路径。

### 支持的模型类型

它可以覆盖常见的 ComfyUI 模型文件夹，例如 checkpoints、loras、vae、embeddings、controlnet、upscale_models 等。

### 缩略图和预览

模型可以拥有 sidecar 预览图。你可以把 output 图片设置为模型预览，也可以删除已有预览。也支持 `.mp4` 和 `.webm` 等视频预览。

### CivitAI 同步

可以使用 SHA256 哈希从 CivitAI 获取模型信息。Drawer 支持 `.red` 和 `.com` fallback，并可以显示模型信息、预览图和 LoRA trainedWords。

### 节点匹配

可以从 Model Viewer 信息卡把模型应用到当前工作流中的兼容 loader 节点。扫描范围包括普通节点、子图、Combo Clone widget 和已连接的 DrawerControls。

## 用户词典、通配符和注释

Drawer 包含用于 prompt 自动补全的词典服务。词典在 Settings 中管理。

### 词典类型

- Danbooru 标签词典：带使用频率的标签 CSV
- 用户词典：将 `tag` 映射到 `insert_text` 的 CSV
- 通配符：用于 `__名称__` 随机展开的 TXT
- 自定义元数据键：第三方 dictionary provider 注册的搜索补全候选

用户词典和 Danbooru 词典可以用于 prompt 输入和 Gallery 搜索。只有注册了 dictionary provider 时，自定义元数据键才会出现在 Settings 中。

### 通配符

通配符使用 `__名称__` 语法。如果启用的通配符词典中有同名词典，就会选择其中一行候选。无需节点或连线。入队时 prompt payload 中的字符串输入会被处理。

```text
masterpiece, __style__, 1girl
```

展开基于工作流中的 `seed`、`noise_seed` 或 `seed_value`。找到种子时，相同种子会得到相同展开。找不到种子时使用普通随机选择。

不进行递归通配符展开。如果候选项包含另一个 `__名称__`，该文本会保持不变。

### 注释

Drawer 可以在入队时从 prompt 文本中移除注释。和通配符一样，它不需要节点或连线，会处理 prompt payload 中的字符串输入。

```text
masterpiece, best quality
// this line is ignored
# this line is also ignored at line start
/* block comment */
```

注释会从实际执行的 prompt 中移除，但会保留在输出中嵌入的 workflow metadata 中。注释内的通配符不会展开。

## Mask Editor

Mask Editor 是从图片上下文菜单打开的简易蒙版编辑 UI。生成的蒙版会保存到 `input/drawer_masks`，并可直接应用到 LoadImageMask 节点。

当你想从 Gallery 或 Lightbox 打开图片，并在 ComfyUI 内快速遮罩其中一部分时，它很有用。它不是完整图片编辑器的替代品，但适合快速的 ComfyUI 内部修改。

## 通用 UI

Drawer gadget 使用通用 UI 服务来保持一致的操作体验。

### Context Menu

右键或长按会打开上下文菜单。通用操作包括在新标签页打开图片、发送到 LoadImage、打开工作流、下载以及创建蒙版。

Gadget 和第三方扩展可以向同一个上下文菜单添加自己的操作。

### Lightbox

Lightbox 是图片、视频和音频的全屏查看器。Gallery、Deck、XYZ Plot 和通用媒体卡片都可以使用它。

它支持键盘导航、滑动、上一项/下一项按钮，以及 Lightbox 内的上下文菜单。

### Dialog

Drawer 提供通用 `showAlert`、`showConfirm`、`showPrompt`、`showDialog` API。设置、搜索索引流程、确认操作和第三方 gadget 表单都会使用这些 API。

### Image Picker

Image Picker 是选择媒体文件的模态选择器。例如，把 output 图片选为模型预览时会用到它。

## Settings

Settings 管理 Drawer 全局配置和维护操作。

主要项目包括：

- 主题和强调色
- 词典启用/禁用开关
- 用户词典、通配符和 Danbooru 词典管理
- 搜索索引创建、同步和自动同步
- 缓存清理

## 第三方扩展

ComfyUI-Drawer 不只是内置 UI 工具集合。它被设计成一个可被外部自定义节点扩展的小型平台。

### JavaScript Gadget

外部自定义节点可以把 JavaScript 放在 `custom_nodes/*/web/js/` 下以注册 Drawer gadget。公开 API 可通过 `window.ComfyDrawer` 使用，包括 `GadgetBase`、`bus`、`bridge`、`settings`、`dict`、`showDialog` 和 `contextMenu`。

简单 gadget 可以单文件完成。详情请参阅 `GADGET_API.md`。

### Python 元数据扩展

Gallery 元数据处理可以通过 Python 注册 API 扩展。

- metadata provider：返回嵌入元数据以外的 raw metadata
- index contributor：把 raw metadata 中的自定义元数据转换为 Drawer 搜索索引字段
- metadata panel contributor：向元数据面板添加自定义元数据展示内容
- dictionary provider：为搜索或 prompt 提供自动补全候选

重点是 Drawer 不规定第三方存储格式。自定义元数据可以存在 `workflow.extra`、sidecar 文件或数据库中。Drawer 接收 raw metadata，并只使用 contributor/provider 返回的 Drawer 标准化值。

搜索 contributor 和 dictionary provider 是分开的。搜索 contributor 把值写入索引。dictionary provider 提供自动补全候选。很多情况下插件会同时注册两者，但也可以只注册其中一个。

## 移动端使用

Drawer 重视移动端和小屏幕体验。通过把操作集中到底部 Drawer，可以减少对整个节点图的频繁操作。

移动端尤其有用的功能：

- 用 Deck 只操作需要的参数
- 用 Gallery 查看、搜索、删除生成结果并打开工作流
- 用 Model Viewer 查找模型和 LoRA
- 用 Lightbox 全屏查看图片和视频
- 长按打开 Context Menu
- 用 Settings 管理词典和搜索索引

由于移动浏览器 UI 和屏幕尺寸差异很大，弹出层会尽量适配视口。

## FAQ

### Drawer 是 APP mode 的替代品吗？

不完全是。APP mode 更偏向把工作流变成应用。Drawer 保留节点图，并提供用于编辑、测试和迭代的操作界面。

### 需要专用节点吗？

许多功能不需要专用节点。Gallery、Model Viewer、Lightbox、Context Menu 和搜索无需向工作流添加节点即可使用。

为了整理 Deck，节点标题标记和 DrawerControls 会很有用。XYZ Plot 也不需要专用 XYZ 节点。它使用当前工作流中已有的 widget，互斥开关还能扩展可测试范围。

### 搜索索引是必须的吗？

文件名搜索不需要。搜索 prompt、workflow、节点和自定义元数据时需要搜索索引。

### 搜索索引会自动创建吗？

不会。Drawer 不会在大型媒体库中静默启动重操作。用户需要明确开始索引，开始前会显示快速估算和确认。

### 可以搜索第三方自定义元数据吗？

可以，只要有 index contributor 知道如何把该元数据转换为搜索索引字段。元数据不需要迁移到 Drawer 专用存储格式。

### 可以打开嵌入 workflow 的图片吗？

可以。Gallery 和 Context Menu 可以把带 workflow metadata 的图片作为工作流打开。如果存在 metadata provider，也可以 provider-first 地使用非嵌入 raw metadata。

### 注释和通配符展开会保留在输出元数据中吗？

注释会从实际执行的 prompt 中移除，但会保留在 workflow metadata 中。通配符展开结果也会反映出来，方便从元数据中检查。

## 更多文档

- `README_zh.md`：概览、安装和主要功能
- `GADGET_API.md`：JavaScript/Python 扩展 API
- `ARCHITECTURE.md`：设计原则、边界和内部结构
- `CONVENTIONS.md`：代码规范、UI/CSS 规则和开发说明
- `CHANGELOG.md`：发布记录
