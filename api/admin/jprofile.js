const { getJsonBody, json, methodNotAllowed, requireAdminSession, signInAdmin } = require('../_lib/jadmin');

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

async function uploadToImgBB(dataUrl, fileName) {
  const apiKey = String(process.env.IMGBB_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('缺少 IMGBB_API_KEY，請先在環境變數設定圖床金鑰。');
  }

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('頭像格式錯誤，請重新選擇圖片。');
  }

  const safeName = String(fileName || 'avatar.jpg').trim().slice(0, 120) || 'avatar.jpg';
  const params = new URLSearchParams();
  params.set('image', parsed.base64);
  params.set('name', safeName);

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
    throw new Error(message);
  }

  const hostedUrl = String(data?.data?.url || data?.data?.display_url || '').trim();
  if (!hostedUrl) {
    throw new Error('圖床未回傳可用網址。');
  }

  return hostedUrl;
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
    const { client, user } = await signInAdmin();
    const body = await getJsonBody(req);
    let avatarUrl = body?.avatar_url || null;

    // Allow directly uploading avatar via profile API so clients don't need a separate upload step.
    if (body?.avatar_data_url) {
      avatarUrl = await uploadToImgBB(body.avatar_data_url, body?.avatar_file_name || 'avatar.jpg');
    }

    const payload = {
      auth_user_id: user.id,
      display_name: body?.display_name || null,
      avatar_url: avatarUrl,
      issuing_place: body?.issuing_place || null,
      id_number: body?.id_number || null
    };
    const { error } = await client.from('user_profiles').upsert(payload, { onConflict: 'auth_user_id' });
    if (error) throw error;
    json(res, 200, { ok: true, avatar_url: avatarUrl });
  } catch (error) {
    json(res, 500, { error: error.message || '更新基本資料失敗。' });
  }
};
