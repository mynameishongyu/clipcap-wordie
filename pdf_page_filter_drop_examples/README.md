# PDF 页面过滤样例图

把“需要过滤掉”的页面截图放在这个目录中，正式槽位回填的页面预过滤会自动读取。

支持格式：
- `.png`
- `.jpg`
- `.jpeg`
- `.webp`

规则：
- 最多读取按文件名排序后的前 4 张图片。
- 只放过滤样例图，例如密集条款页、空白表格页、无关清单页。
- 不需要放保留样例图。
- 当前目录内容可以提交到 GitHub，Vercel 从 GitHub 部署时也能读取这些文件。

默认目录是 `pdf_page_filter_drop_examples/`。如需改目录，可以在 `.env.local` 中设置：

```env
PDF_FILL_PAGE_FILTER_DROP_EXAMPLES_DIR=pdf_page_filter_drop_examples
```
