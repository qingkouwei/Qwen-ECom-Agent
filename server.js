require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// 数据持久化目录与文件
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const dataFile = path.join(dataDir, 'projects.json');

// 项目存储：启动时从磁盘加载，数据变更时即时落盘，重启不丢失
const projects = new Map();

function loadProjectsFromDisk() {
  try {
    if (fs.existsSync(dataFile)) {
      const saved = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      Object.values(saved).forEach(p => projects.set(p.id, p));
      console.log(`📂 已从磁盘加载 ${projects.size} 个历史项目`);
    }
  } catch (e) {
    console.error('加载历史数据失败:', e.message);
  }
}

function saveProjectsToDisk() {
  try {
    const obj = {};
    projects.forEach((p, id) => { obj[id] = p; });
    fs.writeFileSync(dataFile, JSON.stringify(obj), 'utf-8');
  } catch (e) {
    console.error('保存数据失败:', e.message);
  }
}

loadProjectsFromDisk();

// ============================================================
//  结构化统计日志：每次调用写入 logs/app.log（JSON 行格式），不展示到前端
// ============================================================
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = path.join(logDir, 'app.log');

function logStat(entry) {
  const record = {
    ts: new Date().toISOString(),
    ...entry
  };
  // 控制台输出关键字段，完整 JSON 落盘
  const { type, action, seconds, tokens, cost, status } = record;
  console.log(`📊 [${type}] ${action || ''} ${status || ''} ${seconds != null ? seconds + 's' : ''} ${tokens ? tokens + 'tokens' : ''} ${cost ? '¥' + cost : ''}`.trim());
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    console.error('写入统计日志失败:', e.message);
  }
}

// 按 Qwen3.8-Max 定价估算成本：输入 ¥12/M tokens，输出 ¥36/M tokens
function calcCost(promptTokens, completionTokens) {
  return Math.round((promptTokens * 12 + completionTokens * 36) / 1e6 * 100) / 100;
}

// multer 配置
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
  else cb(new Error('仅支持 .xlsx / .xls 格式文件'));
}});

// ============================================================
//  文件上传接口
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const uploadStartedAt = Date.now();
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // 提取评论文本与买家晒图
    const reviews = [];
    const images = [];

    jsonData.forEach(row => {
      // 评论列：尝试多种可能的列名
      const reviewText = row['data3'] || row['data4'] || row['评论'] || row['评价'] || row['comment'] || '';
      if (reviewText && String(reviewText).trim()) {
        reviews.push(String(reviewText).trim());
      }
      // 图片列
      const imgCol = row['image'] || row['图片'] || row['img'] || row['晒图'] || '';
      if (imgCol && String(imgCol).trim()) {
        const urls = String(imgCol).split(/[;,，\n]/).map(u => u.trim()).filter(Boolean);
        images.push(...urls);
      }
    });

    const projectId = `proj_${Date.now()}`;
    const project = {
      id: projectId,
      name: req.file.originalname,
      uploadTime: new Date().toISOString(),
      reviews,
      images: images.slice(0, 50), // 最多保留50张
      analysisResult: null,
      generatedImage: null
    };
    projects.set(projectId, project);
    saveProjectsToDisk();

    logStat({
      type: 'upload', action: '文件上传解析', status: 'success',
      project: project.name, projectId,
      reviewCount: reviews.length, imageCount: images.length,
      seconds: Math.round((Date.now() - uploadStartedAt) / 100) / 10
    });

    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        uploadTime: project.uploadTime,
        reviewCount: reviews.length,
        imageCount: images.length
      }
    });
  } catch (err) {
    console.error('上传解析失败:', err);
    logStat({ type: 'upload', action: '文件上传解析', status: 'fail', error: err.message, seconds: Math.round((Date.now() - uploadStartedAt) / 100) / 10 });
    res.status(500).json({ error: '文件解析失败: ' + err.message });
  }
});

// ============================================================
//  大模型分析接口 — 调用 Qwen3.8-Max（原生多模态旗舰，文本+图像一次调用完成）
// ============================================================
app.post('/api/analyze', async (req, res) => {
  const analyzeStartedAt = Date.now();
  let logCtx = {};
  try {
    const { projectId, apiKey } = req.body;
    const project = projects.get(projectId);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const key = apiKey || process.env.DASHSCOPE_API_KEY;
    if (!key) return res.status(400).json({ error: '未配置 API Key，请在设置中填入您的 DashScope API Key' });

    // 组装评论上下文（截取前 6000 字符防止超长）
    const reviewContext = project.reviews.join('\n---\n').slice(0, 6000);
    // 过滤出合法的公网图片链接（视觉模型会直接拉取 URL，无需后端下载）
    const imageUrls = project.images
      .filter(u => /^https?:\/\/.+/i.test(u))
      .slice(0, 6);

    const systemPrompt = `你是一位顶级电商运营专家和数据分析师。你需要根据用户提供的真实竞品评论数据，进行深度全维度拆解分析，帮助商家重构自己商品的标题、卖点与主图，从而提升运营效率和转化率。
输出要求：
1. 必须严格输出合法 JSON，不要包含 markdown 代码块标记。
2. 所有文案必须100%规避广告法极限词（最、第一、顶级、绝对等），用合规替代词。
3. 文案中需包含国标检测号（示例格式：GB/T 22844-2009）。
4. 所有文本使用地道中文。

【买家晒图信息提取要求】若附带了买家晒图，必须逐图提取以下四类信息，并汇总为独立条目输出到 imageInsights.findings：
1. 实物品质状态：真实颜色（判断与商品页主图是否存在色差）、做工细节（车缝、接口、材质、安装质量）、破损/变形/磨损等缺陷证据 → type 用 defect；
2. 真实使用场景：使用环境（室内/户外/特定场合）、实际用法、尺寸感知与搭配方式 → type 用 scene；
3. 正面视觉信号：晒图中商品表现好的部分（颜值、氛围感、好评细节）→ type 用 positive；
4. 图文一致性：晒图实物与商家宣传的差异点 → type 用 defect，并在 detail 中说明差异。
要求：findings 输出 3-6 条最有价值的发现，必须与评论文本交叉验证；视觉上得到证实的缺陷应同时进入 painPoints 并给出更具体的 detail；positive 类发现应用于 copywriting 的卖点提炼；imagePrompt 必须基于晒图中识别到的真实商品品类与形态特征撰写。若未附带晒图，则不输出 imageInsights 字段。

请输出如下 JSON 结构：
{
  "painPoints": [
    { "label": "痛点名称", "percentage": 数字(0-100), "detail": "具体描述", "icon": "emoji" }
  ],
  "imageInsights": {
    "findings": [
      { "type": "defect 或 positive 或 scene", "label": "发现标签", "detail": "具体描述（含视觉证据）" }
    ]
  },
  "copywriting": {
    "title": "重构爆款标题（合规、高转化）",
    "sellingPoints": ["卖点1", "卖点2", "卖点3"],
    "description": "100字以内爆款描述"
  },
  "imagePrompt": "中文生图提示词，针对本商品品类，描述高品质电商主图的场景、光影、构图与质感细节（50-120字）"
}`;

    const userPrompt = `以下是一款竞品的真实买家评论数据${imageUrls.length ? '与买家晒图' : ''}，请进行全维度深度分析：

【买家评论原文】
${reviewContext}
${imageUrls.length ? '\n【买家晒图】见附带的图片，请严格按照系统提示中的四类信息提取要求逐图分析，并与评论文本交叉验证后融入各模块输出。' : ''}

请基于以上真实数据，输出完整的 JSON 分析结果。`;

    // 统一调用入口：Qwen3.8-Max 原生支持视觉理解，评论文本与买家晒图 URL 直传，由模型端拉取图片
    const chatEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

    // 有晒图时用多模态消息结构，无晒图时退化为纯文本结构
    const userContent = imageUrls.length > 0
      ? [
          { type: 'text', text: userPrompt },
          ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
        ]
      : userPrompt;

    async function callQwen() {
      return axios.post(chatEndpoint, {
        model: 'qwen3.8-max',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.7,
        max_tokens: 4000,
        enable_thinking: false
      }, { headers, timeout: 180000 });
    }

    let response;
    let degraded = false;
    try {
      response = await callQwen();
    } catch (mmErr) {
      // 晒图链接失效导致多模态调用失败时，降级为纯文本分析保证主流程可用
      if (imageUrls.length > 0) {
        console.warn('多模态调用失败，降级为纯文本分析:', mmErr.response?.data?.error?.message || mmErr.message);
        degraded = true;
        response = await axios.post(chatEndpoint, {
          model: 'qwen3.8-max',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 4000,
          enable_thinking: false
        }, { headers, timeout: 180000 });
      } else {
        throw mmErr;
      }
    }

    let content = response.data.choices?.[0]?.message?.content || '';
    // 清理可能的 markdown 代码块包裹
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let analysisResult;
    try {
      analysisResult = JSON.parse(content);
    } catch (e) {
      // 尝试从文本中提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('大模型返回内容无法解析为 JSON');
      }
    }

    project.analysisResult = analysisResult;
    saveProjectsToDisk();

    // 记录分析调用统计：耗时、token 用量、成本估算
    const usage = response.data.usage || {};
    const seconds = Math.round((Date.now() - analyzeStartedAt) / 100) / 10;
    const cost = calcCost(usage.prompt_tokens || 0, usage.completion_tokens || 0);
    logCtx = { project: project.name, projectId, reviewCount: project.reviews.length };
    logStat({
      type: 'analyze', action: 'Qwen3.8-Max 全维分析', status: 'success',
      ...logCtx,
      multimodal: imageUrls.length > 0 && !degraded,
      imageCount: imageUrls.length,
      degraded,
      seconds,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      tokens: usage.total_tokens || 0,
      cost
    });

    res.json({ success: true, result: analysisResult });
  } catch (err) {
    console.error('分析失败:', err.response?.data || err.message);
    logStat({
      type: 'analyze', action: 'Qwen3.8-Max 全维分析', status: 'fail',
      ...logCtx,
      error: err.response?.data?.error?.message || err.message,
      seconds: Math.round((Date.now() - analyzeStartedAt) / 100) / 10
    });
    const errMsg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: '分析调用失败: ' + errMsg });
  }
});

// ============================================================
//  通义万相生图接口
// ============================================================
app.post('/api/generate-image', async (req, res) => {
  const genStartedAt = Date.now();
  let logCtx = {};
  try {
    const { projectId, apiKey, prompt } = req.body;
    const project = projects.get(projectId);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const key = apiKey || process.env.DASHSCOPE_API_KEY;
    if (!key) return res.status(400).json({ error: '未配置 API Key' });

    const imagePrompt = prompt || project.analysisResult?.imagePrompt || '高品质电商商品主图，白色背景，专业产品摄影';
    logCtx = { project: project.name, projectId };

    // 第一步：提交生图任务
    const submitRes = await axios.post(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
      {
        model: 'wanx-v1',
        input: {
          prompt: imagePrompt
        },
        parameters: {
          style: '<photography>',
          size: '1024*1024',
          n: 1
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        timeout: 30000
      }
    );

    const taskId = submitRes.data.output?.task_id;
    if (!taskId) throw new Error('生图任务提交失败');

    // 第二步：轮询获取结果（最多等待 60 秒）
    let imageUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const checkRes = await axios.get(
        `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
        {
          headers: { 'Authorization': `Bearer ${key}` },
          timeout: 10000
        }
      );
      const status = checkRes.data.output?.task_status;
      if (status === 'SUCCEEDED') {
        const results = checkRes.data.output.results;
        if (results && results.length > 0) {
          imageUrl = results[0].url;
        }
        break;
      } else if (status === 'FAILED') {
        throw new Error('生图任务失败: ' + (checkRes.data.output?.message || '未知错误'));
      }
    }

    if (!imageUrl) throw new Error('生图超时，请稍后重试');

    // 万相返回的图片 URL 仅 24 小时有效，下载转存到本地保证持久化后仍可访问
    try {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const localName = `gen_${Date.now()}.png`;
      fs.writeFileSync(path.join(uploadDir, localName), Buffer.from(imgRes.data));
      imageUrl = `/uploads/${localName}`;
    } catch (dlErr) {
      // 下载失败时保留原始 URL（短期内仍可访问）
      console.warn('生成图片本地转存失败，保留原始链接:', dlErr.message);
    }

    project.generatedImage = imageUrl;
    saveProjectsToDisk();

    // 记录生图调用统计：总耗时（含任务轮询）、提示词长度
    logStat({
      type: 'generate-image', action: '通义万相生图', status: 'success',
      ...logCtx,
      seconds: Math.round((Date.now() - genStartedAt) / 100) / 10,
      promptLength: imagePrompt.length,
      storedAs: imageUrl
    });

    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('生图失败:', err.response?.data || err.message);
    logStat({
      type: 'generate-image', action: '通义万相生图', status: 'fail',
      ...logCtx,
      error: err.response?.data?.message || err.message,
      seconds: Math.round((Date.now() - genStartedAt) / 100) / 10
    });
    const errMsg = err.response?.data?.message || err.message;
    res.status(500).json({ error: '生图失败: ' + errMsg });
  }
});

// ============================================================
//  获取项目列表 / 项目详情
// ============================================================
app.get('/api/projects', (req, res) => {
  const list = [];
  projects.forEach(p => {
    list.push({
      id: p.id,
      name: p.name,
      uploadTime: p.uploadTime,
      reviewCount: p.reviews.length,
      imageCount: p.images.length,
      hasAnalysis: !!p.analysisResult,
      hasImage: !!p.generatedImage
    });
  });
  res.json({ projects: list });
});

app.get('/api/project/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  res.json({
    id: project.id,
    name: project.name,
    uploadTime: project.uploadTime,
    reviewCount: project.reviews.length,
    imageCount: project.images.length,
    images: project.images.slice(0, 6),
    analysisResult: project.analysisResult,
    generatedImage: project.generatedImage
  });
});

// 设置 API Key 接口（前端传入后暂存于内存）
let globalApiKey = '';
app.post('/api/config', (req, res) => {
  if (req.body.apiKey) {
    globalApiKey = req.body.apiKey;
    process.env.DASHSCOPE_API_KEY = req.body.apiKey;
  }
  res.json({ success: true });
});

app.get('/api/config', (req, res) => {
  res.json({ hasKey: !!(globalApiKey || process.env.DASHSCOPE_API_KEY) });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 电商竞品爆款全维拆解与重构助手已启动`);
  console.log(`📡 访问地址: http://localhost:${PORT}`);
  console.log(`📊 统计日志文件: ${logFile}\n`);
  logStat({ type: 'system', action: '服务启动', status: 'success', projectCount: projects.size });
});
