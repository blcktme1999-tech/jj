const { getJsonBody, json, methodNotAllowed, requireAdminSession } = require('../_lib/jadmin');

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\n\r]+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    base64: match[2].replace(/[\n\r]/g, '')
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST']);
    return;
  }

  if (!requireAdminSession(req, res)) {
    return;
  }

  try {
    const apiKey = String(process.env.IMGBB_API_KEY || '').trim();
    if (!apiKey) {
      json(res, 500, { error: '缺少 IMGBB_API_KEY，請先在環境變數設定圖床金鑰。' });
      return;
    }

    const body = await getJsonBody(req);
    const parsed = parseDataUrl(body?.dataUrl);
    if (!parsed) {
      json(res, 400, { error: '圖片格式錯誤，請重新選擇照片上傳。' });
      return;
    }

    const fileName = String(body?.fileName || 'case-photo.jpg').trim().slice(0, 120);
    const params = new URLSearchParams();
    params.set('image', parsed.base64);
    params.set('name', fileName || 'case-photo.jpg');

    const response = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const rawText = await response.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      data = {};
    }

    if (!response.ok || !data?.success) {
      const message = data?.error?.message || ('圖床上傳失敗（HTTP ' + response.status + '）');
      json(res, 502, { error: message });
      return;
    }

    const hostedUrl = String(data?.data?.url || data?.data?.display_url || '').trim();
    if (!hostedUrl) {
      json(res, 502, { error: '圖床未回傳可用網址。' });
      return;
    }

    json(res, 200, {
      ok: true,
      url: hostedUrl,
      mimeType: parsed.mimeType
    });
  } catch (error) {
    json(res, 500, { error: error.message || '圖片上傳失敗。' });
  }
};
