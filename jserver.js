require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const agoraTokenHandler = require('./api/jagora-token');

const app = express();
const port = Number(process.env.PORT || 3000);
const {
  SESSION_SECRET,
  SHARED_ADMIN_LOGIN,
  SHARED_ADMIN_PASSWORD,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_ADMIN_EMAIL,
  SUPABASE_ADMIN_PASSWORD
} = process.env;

if (!SESSION_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_ADMIN_EMAIL || !SUPABASE_ADMIN_PASSWORD) {
  throw new Error('Missing required environment variables. Copy .env.example to .env and fill the values.');
}

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

async function signInAdmin() {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const { data, error } = await client.auth.signInWithPassword({
    email: SUPABASE_ADMIN_EMAIL,
    password: SUPABASE_ADMIN_PASSWORD
  });

  if (error || !data?.user) {
    throw error || new Error('Unable to sign in admin user.');
  }

  return { client, user: data.user };
}

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

function requireAdminSession(req, res, next) {
  if (!req.session.adminAuthenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function formatSupabaseError(error, fallbackMessage) {
  const rawMessage = String(error?.message || '').trim();
  const lower = rawMessage.toLowerCase();

  const tableMatch = rawMessage.match(/table\s+['"]([^'"]+)['"]/i)
    || rawMessage.match(/relation\s+['"]([^'"]+)['"]\s+does not exist/i);
  const tableName = tableMatch ? tableMatch[1] : '';
  const missingTable = lower.includes('could not find the table')
    || (lower.includes('relation') && lower.includes('does not exist'));

  if (missingTable) {
    const suffix = tableName ? '（' + tableName + '）' : '';
    return '資料庫資料表尚未建立或 schema 快取未更新' + suffix + '。請在 Supabase SQL Editor 執行 jsupabase-init.sql，然後執行 NOTIFY pgrst, \'reload schema\';';
  }

  return rawMessage || fallbackMessage;
}

app.post('/api/admin/login', (req, res) => {
  const { loginId, password } = req.body || {};
  if (loginId !== SHARED_ADMIN_LOGIN || password !== SHARED_ADMIN_PASSWORD) {
    res.status(401).json({ error: '帳號或密碼錯誤。' });
    return;
  }

  req.session.adminAuthenticated = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.adminAuthenticated) });
});

app.get('/api/admin/data', requireAdminSession, async (req, res) => {
  try {
    const { client, user } = await signInAdmin();
    const [profileResult, recordsResult] = await Promise.all([
      client.from('user_profiles').select('*').eq('auth_user_id', user.id).maybeSingle(),
      client.from('user_records').select('*').eq('auth_user_id', user.id).order('created_at', { ascending: false })
    ]);

    if (profileResult.error) throw profileResult.error;
    if (recordsResult.error) throw recordsResult.error;

    res.json({
      profile: profileResult.data || {},
      records: recordsResult.data || []
    });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '讀取後台資料失敗。') });
  }
});

app.post('/api/admin/profile', requireAdminSession, async (req, res) => {
  try {
    const { client, user } = await signInAdmin();
    let avatarUrl = req.body?.avatar_url || null;

    // Allow directly uploading avatar via profile API so clients can submit one request.
    if (req.body?.avatar_data_url) {
      avatarUrl = await uploadToImgBB(req.body.avatar_data_url, req.body?.avatar_file_name || 'avatar.jpg');
    }

    const payload = {
      auth_user_id: user.id,
      display_name: req.body?.display_name || null,
      avatar_url: avatarUrl,
      issuing_place: req.body?.issuing_place || null,
      id_number: req.body?.id_number || null
    };
    const { error } = await client.from('user_profiles').upsert(payload, { onConflict: 'auth_user_id' });
    if (error) throw error;
    res.json({ ok: true, avatar_url: avatarUrl });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '更新基本資料失敗。') });
  }
});

app.post('/api/admin/records', requireAdminSession, async (req, res) => {
  try {
    const { client, user } = await signInAdmin();
    const payload = {
      auth_user_id: user.id,
      title: req.body?.title || '未命名案件',
      info_text: req.body?.info_text || ''
    };
    const { error } = await client.from('user_records').insert(payload);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '新增案件失敗。') });
  }
});

app.patch('/api/admin/records/:id', requireAdminSession, async (req, res) => {
  try {
    const { client, user } = await signInAdmin();
    const payload = {
      title: req.body?.title || '未命名案件',
      info_text: req.body?.info_text || ''
    };
    const { error } = await client.from('user_records').update(payload).eq('id', req.params.id).eq('auth_user_id', user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '更新案件失敗。') });
  }
});

app.post('/api/admin/upload-image', requireAdminSession, async (req, res) => {
  try {
    const apiKey = String(process.env.IMGBB_API_KEY || '').trim();
    if (!apiKey) {
      res.status(500).json({ error: '缺少 IMGBB_API_KEY，請先在環境變數設定圖床金鑰。' });
      return;
    }

    const dataUrl = String(req.body?.dataUrl || '').trim();
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\n\r]+)$/);
    if (!match) {
      res.status(400).json({ error: '圖片格式錯誤，請重新選擇照片上傳。' });
      return;
    }

    const base64 = match[2].replace(/[\n\r]/g, '');
    const fileName = String(req.body?.fileName || 'case-photo.jpg').trim().slice(0, 120);
    const params = new URLSearchParams();
    params.set('image', base64);
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
      res.status(502).json({ error: message });
      return;
    }

    const hostedUrl = String(data?.data?.url || data?.data?.display_url || '').trim();
    if (!hostedUrl) {
      res.status(502).json({ error: '圖床未回傳可用網址。' });
      return;
    }

    res.json({ ok: true, url: hostedUrl });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '圖片上傳失敗。') });
  }
});

app.post('/api/admin/photos', requireAdminSession, async (req, res) => {
  try {
    const { client } = await signInAdmin();
    const photoUrl = String(req.body?.photo_url || '').trim();
    if (!photoUrl) {
      res.status(400).json({ error: '缺少照片內容。' });
      return;
    }

    const isHttpUrl = /^https?:\/\//i.test(photoUrl);
    const isDataImage = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(photoUrl);
    if (!isHttpUrl && !isDataImage) {
      res.status(400).json({ error: '照片格式不支援，請使用圖片網址或直接上傳圖片。' });
      return;
    }

    const payload = {
      record_id: req.body?.record_id,
      photo_url: photoUrl,
      caption: req.body?.caption || null
    };
    const { error } = await client.from('record_photos').insert(payload);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: formatSupabaseError(error, '新增照片失敗。') });
  }
});

app.post('/api/agora-token', async (req, res) => {
  await agoraTokenHandler(req, res);
});

app.use(express.static(__dirname));

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
