/**
 * gtalkClient.js
 * ------------------------------------------------------------------
 * Client gọi GHN GTalk REST API — đầy đủ theo swagger.yaml.
 *
 * Yêu cầu biến môi trường:
 *   GTALK_BASE_URL      - https://mbff.ghn.vn (prod) hoặc https://test-api.mbff.ghn.tech (test)
 *   GTALK_OA_ID          - OA ID
 *   GTALK_USERNAME       - phần username của oaToken
 *   GTALK_PASSWORD       - phần password của oaToken
 *   GTALK_CHANNEL_ID     - kênh GTalk nhận cảnh báo
 *   GTALK_WEBHOOK_SECRET - secret dùng verify chữ ký webhook inbound
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const crypto = require('crypto');

const BASE_URL = process.env.GTALK_BASE_URL || 'https://test-api.mbff.ghn.tech';
const OA_TOKEN = `${process.env.GTALK_USERNAME}:${process.env.GTALK_PASSWORD}`;
const OA_ID = process.env.GTALK_OA_ID;

/* ======================== HTTP helper ======================== */

async function post(path, body) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, oaToken: OA_TOKEN }),
    });
  } catch (networkErr) {
    console.error(`[gtalkClient] Không kết nối được tới ${url}`);
    console.error(`[gtalkClient] Nguyên nhân gốc:`, networkErr.cause || networkErr.message);
    throw new Error(`Network error khi gọi ${url}: ${networkErr.cause?.code || networkErr.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`GTalk trả về dữ liệu không phải JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} từ GTalk: ${JSON.stringify(json)}`);
  }
  if (json.errorCode && json.errorCode !== 'success') {
    const err = new Error(`GTalk API error [${json.errorCode}]: ${JSON.stringify(json.error)}`);
    err.payload = json;
    throw err;
  }
  return json.data;
}

async function putBinary(presignedUrl, buffer, contentType) {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`S3 upload thất bại (HTTP ${res.status})`);
  }
}

/* ======================== Messages ======================== */

async function sendText(channelId, text, { parseMode = 'MARKDOWN' } = {}) {
  return post('/api/gtalk/send-message', {
    channelId,
    clientMsgId: String(Date.now()),
    content: { text, parseMode },
  });
}

async function sendTemplate(channelId, { templateId = 'tmpl_alert', shortMessage, iconUrl, title, content, actions = [] }) {
  return post('/api/gtalk/send-message', {
    channelId,
    clientMsgId: String(Date.now()),
    content: {
      template: {
        templateId,
        shortMessage,
        data: JSON.stringify({ icon_url: iconUrl, title, content, actions }),
      },
    },
  });
}

async function sendPhoto(channelId, fileId, width, height, { caption } = {}) {
  return post('/api/gtalk/send-message', {
    channelId,
    clientMsgId: String(Date.now()),
    content: {
      attachment: {
        caption,
        items: [{ image: { fileId, width, height } }],
      },
    },
  });
}

async function sendFile(channelId, fileId, fileName, mimeType, fileSize) {
  return post('/api/gtalk/send-message', {
    channelId,
    clientMsgId: String(Date.now()),
    content: {
      attachment: {
        items: [{ file: { fileId, fileName, mimeType, fileSize } }],
      },
    },
  });
}

async function sendVideo(channelId, fileId, width, height, duration, { caption } = {}) {
  return post('/api/gtalk/send-message', {
    channelId,
    clientMsgId: String(Date.now()),
    content: {
      attachment: {
        caption,
        items: [{ video: { fileId, width, height, duration } }],
      },
    },
  });
}

/* ======================== Modify Message ======================== */

async function modifyMessage(channelId, globalMsgId, action, content) {
  return post('/api/gtalk/modify-message', {
    channelId,
    globalMsgId,
    action,
    ...(action === 1 && content ? { content } : {}),
  });
}

async function editMessage(channelId, globalMsgId, newText, { parseMode = 'MARKDOWN' } = {}) {
  return modifyMessage(channelId, globalMsgId, 1, { text: newText, parseMode });
}

async function deleteMessage(channelId, globalMsgId) {
  return modifyMessage(channelId, globalMsgId, 2);
}

/* ======================== Receipts ======================== */

async function sendReceipt(channelId, globalMsgId, statuses) {
  const receipts = (statuses || [2, 3]).map((status) => ({
    status,
    receiptedTs: Date.now(),
    globalMsgId,
  }));
  return post('/api/gtalk/send-message-receipt', {
    oaId: OA_ID,
    receiptMessage: { channelId, receipts },
  });
}

/* ======================== File Upload ======================== */

async function initiateUpload(channelId, fileName, fileSize, mimeType, metadata) {
  return post('/api/gtalk/initiate-upload', {
    ChannelId: channelId,
    FileName: fileName,
    FileSize: String(fileSize),
    MimeType: mimeType,
    ...(metadata ? { Metadata: JSON.stringify(metadata) } : {}),
  });
}

async function completeUpload(uploadId) {
  return post('/api/gtalk/complete-upload', { UploadId: uploadId });
}

async function uploadFile(channelId, fileName, fileBuffer, mimeType, { thumbBuffer, metadata } = {}) {
  const initData = await initiateUpload(channelId, fileName, fileBuffer.length, mimeType, metadata);

  await putBinary(initData.PresignedURL, fileBuffer, mimeType);

  if (thumbBuffer && initData.PresignedThumbURL) {
    await putBinary(initData.PresignedThumbURL, thumbBuffer, 'image/jpeg');
  }

  return completeUpload(initData.UploadId);
}

/* ======================== File Info ======================== */

async function detailFile(fileId) {
  return post('/api/gtalk/detail-file', { Id: fileId });
}

async function getFileUrl(fileId) {
  return post('/api/gtalk/get-file', { Id: fileId });
}

/* ======================== Channels ======================== */

async function createDirectChannel(userId) {
  return post('/api/gtalk/create-server-direct-channel', {
    oaId: OA_ID,
    userId,
  });
}

async function createDirectChannelByIdentity(identityId, identityChannel = 1) {
  return post('/api/gtalk/create-server-direct-channel', {
    oaId: OA_ID,
    identity: { identityChannel, identityId },
  });
}

async function configChannelWebhook(channelId, webhookURL, { webhookSecret, timeoutSeconds = 30, retry } = {}) {
  return post('/api/gtalk/config-channel-processing', {
    oaId: OA_ID,
    channelId,
    processingConfig: {
      webhook: {
        enabled: true,
        webhookURL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        webhookResponseTimeoutInSecond: timeoutSeconds,
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(retry ? { retry } : {}),
      },
    },
  });
}

/* ======================== Users ======================== */

async function getUserProfile(userId) {
  return post('/api/gtalk/get-user-simple-profile', {
    oaId: OA_ID,
    userId,
  });
}

/* ======================== Webhook Verification ======================== */

function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!webhookSecret) return true;
  if (!signatureHeader) return false;

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const parsed = JSON.parse(payload);
  const { oaId, timestamp } = parsed;

  const input = oaId + payload + timestamp + webhookSecret;
  const hex = crypto.createHash('sha256').update(input).digest('hex');
  const expected = 'mac=' + hex;

  if (signatureHeader.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

/* ======================== Exports ======================== */

module.exports = {
  // Messages
  sendText,
  sendTemplate,
  sendPhoto,
  sendFile,
  sendVideo,
  // Modify
  editMessage,
  deleteMessage,
  modifyMessage,
  // Receipts
  sendReceipt,
  // File upload
  uploadFile,
  initiateUpload,
  completeUpload,
  // File info
  detailFile,
  getFileUrl,
  // Channels
  createDirectChannel,
  createDirectChannelByIdentity,
  configChannelWebhook,
  // Users
  getUserProfile,
  // Webhook verification
  verifyWebhookSignature,
};
