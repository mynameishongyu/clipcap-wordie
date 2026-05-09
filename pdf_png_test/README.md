# PDF to PNG Test

这个目录是独立测试页面，只用于验证浏览器端 PDF.js 渲染 PDF 到 canvas，再从 canvas 导出图片的效果。

## 使用

用任意静态服务器打开：

```bash
npx serve pdf_png_test
```

然后在浏览器打开提示的地址，上传 PDF 后点击“上传并渲染 PDF”。

## 配置

可以在浏览器控制台设置这些变量后刷新/重新渲染：

```js
window.NEXT_PUBLIC_PDF_RENDER_SCALE = 4;
window.NEXT_PUBLIC_PDF_RENDER_IMAGE_FORMAT = 'image/png';
window.NEXT_PUBLIC_PDF_RENDER_JPEG_QUALITY = 0.92;
```
