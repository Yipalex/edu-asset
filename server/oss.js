// 阿里云 OSS 对象存储封装
// - 服务器上传走内网 Endpoint（同地域 ECS↔OSS 流量免费）
// - 浏览器读取走公共读外链（Bucket 已开公共读）
// - 未配置 OSS_ACCESS_KEY_ID/SECRET 时 enabled=false，上传自动降级为本地磁盘（本地开发用）
const crypto = require('crypto');
const path = require('path');

function env(k, dft) {
  const v = process.env[k];
  return v === undefined || v === '' ? dft : v;
}

const cfg = {
  accessKeyId: env('OSS_ACCESS_KEY_ID', ''),
  accessKeySecret: env('OSS_ACCESS_KEY_SECRET', ''),
  bucket: env('OSS_BUCKET', 'edushuhua'),
  // 服务器侧上传用内网节点（要求 ECS 与 Bucket 同地域，否则传不出去）
  endpoint: env('OSS_ENDPOINT', 'oss-cn-shenzhen-internal.aliyuncs.com'),
  // 浏览器/外链访问用公网地址
  publicBase: env('OSS_PUBLIC_BASE', 'https://edushuhua.oss-cn-shenzhen.aliyuncs.com').replace(/\/+$/, ''),
  // 对象键前缀：与其他系统（双师/仓储等）在同一 Bucket 内隔离
  prefix: env('OSS_PREFIX', 'zc-asset').replace(/^\/+|\/+$/g, ''),
};

const enabled = Boolean(cfg.accessKeyId && cfg.accessKeySecret);

let client = null;
function getClient() {
  if (!client) {
    // 延迟加载：未启用 OSS 时不引入 ali-oss 依赖
    const OSS = require('ali-oss');
    client = new OSS({
      endpoint: cfg.endpoint,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      timeout: 120 * 1000,
    });
  }
  return client;
}

// 生成对象键：前缀/时间戳-随机串.扩展名（与旧本地上传命名风格一致，便于追溯）
function objectKey(originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || '.jpg';
  return `${cfg.prefix}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

// 上传 buffer，返回公网可访问的完整 URL
async function put(buffer, originalname) {
  const key = objectKey(originalname);
  await getClient().put(key, buffer);
  return `${cfg.publicBase}/${key}`;
}

// 删除对象（维护用）
async function del(key) {
  await getClient().delete(key);
}

module.exports = { enabled, cfg, put, del, getClient, objectKey };
