# 项目上下文（供 AI 编程助手阅读）

## 产品定位

【电商竞品爆款全维拆解与重构助手】——面向电商运营人员**直接使用**的生产级 SaaS 工具。
用户上传竞品 Excel 表格（评论 + 买家晒图），AI 自动完成全量分析并产出：痛点雷达、晒图视觉洞察、合规爆款文案、新商品主图。

## 技术栈

- 后端：Node.js + Express + multer（上传）+ xlsx（表格解析）+ axios，单文件 `server.js`
- 前端：Vue 3（CDN 引入）单文件 `public/index.html`，Dark Glassmorphism 风格
- AI 服务：大模型分析调用 `qwen3.8-max`（compatible-mode/v1/chat/completions），生图调用通义万相 `wanx-v1`（异步任务 + 轮询）
- 启动：`npm start`（端口 3000）；API Key 通过环境变量 `DASHSCOPE_API_KEY` 或前端设置界面传入

## 关键架构决策（会话中已确认）

1. **统一单模型**：`qwen3.8-max` 为原生多模态旗舰（图像/文本/视频输入），评论文本与晒图一次调用完成分析，不做文本/视觉双模型分工。调用参数含 `enable_thinking: false`。
2. **晒图 URL 直传**：图片以 `image_url` 格式直传，由模型端拉取，后端不下载中转；调用失败自动降级为纯文本分析。
3. **晒图四维提取**：实物品质状态（defect）、真实使用场景（scene）、正面视觉信号（positive）、图文一致性（defect），输出到 `imageInsights.findings`（3-6 条），须与评论文本交叉验证。
4. **已删除「优化前后效果对比」模块**：属于产品推介话术，对直接使用工具的运营无业务价值。当前四大模块：📊 痛点雷达 → 🖼️ 晒图视觉洞察 → 📝 重构爆款文案 → 🎨 通义万相生图。
5. **磁盘持久化**：项目数据存 `data/projects.json`（上传/分析/生图后即时落盘，启动时加载）；上传文件存 `uploads/`。
6. **生成图片本地转存**：万相返回 URL 仅 24 小时有效，生成后下载为 `uploads/gen_xxx.png` 并通过 `/uploads` 静态路由托管。
7. **分析输出 JSON 结构**：`painPoints[]`、`imageInsights.findings[]`、`copywriting{title,sellingPoints,description}`、`imagePrompt`（中文）。

## 必须遵守的规范

- 界面与输出**全地道中文**。
- 文本中**禁止出现「阿里」「阿里云」「千问」等敏感词**；大模型统一表述为 **Qwen3.8-Max**，生图统一表述为 **通义万相**。
- 界面**不展示任何技术细节**（Agent 日志、Token 统计、思维链、内部模型名等），纯业务成果展示。
- 生成文案须 100% 规避广告法极限词（最、第一、顶级、绝对等），并包含国标检测号（如 GB/T 22844-2009）。
- 生图提示词使用**中文**。
- Excel 解析：评论列识别 `data3`/`data4`/`评论`/`评价`/`comment`；图片列识别 `image`/`图片`/`img`/`晒图`，多 URL 按 `; , ， 换行` 分隔。

## 已知限制

- SheetJS 社区版不支持提取 Excel 嵌入图片，仅解析文本型 URL 列。
- 数据为文件级存储，无多用户/鉴权体系。
