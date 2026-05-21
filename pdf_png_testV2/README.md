# PDF to JPEG V2 Test

这个目录是 `pdf_png_test` 的 JPEG 优化实验版，不会修改旧测试页里的 PDF 转 JPEG 流程。

V2 固定导出 `image/jpeg`，并复刻正式槽位抽取核查页的 PDF 证据展示方式：

- 基准展示宽度 `1020px`
- 缩小 / 放大 / 适宽控制
- `devicePixelRatio` 最多取 `2`
- `imageSmoothingQuality=high`
- 预览 canvas 轻微锐化
- 深色页面容器、页码 badge、白底页面 canvas

## 已实现的 JPEG 体积优化点

- 使用 `NEXT_PUBLIC_PDF_RENDER_SCALE` 控制 PDF.js 渲染倍率
- 使用 `NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY` 控制 JPEG 导出质量
- 自动裁剪白边
- 自动旋转横置/侧置页面
- 最长边上限，默认 `3200px`
- 可选灰度化
- 可选背景白化和轻微对比度增强

## 启动

从项目根目录运行：

```powershell
node pdf_png_testV2/server.mjs
```

然后打开：

```text
http://127.0.0.1:8031
```

页面会读取项目根目录的 `.env.local`。不要直接双击 `index.html`，否则读取不到本地配置。

## 可选 V2 配置

除了正式项目已有的配置，也可以在 `.env.local` 临时增加这些 V2 测试参数：

```env
NEXT_PUBLIC_PDF_RENDER_JPEG_MAX_LONG_EDGE=3200
NEXT_PUBLIC_PDF_RENDER_JPEG_GRAYSCALE=false
NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_CLEANUP=false
NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_WHITE_THRESHOLD=246
NEXT_PUBLIC_PDF_RENDER_JPEG_BACKGROUND_INK_THRESHOLD=190
NEXT_PUBLIC_PDF_RENDER_JPEG_CONTRAST=1.04
```
