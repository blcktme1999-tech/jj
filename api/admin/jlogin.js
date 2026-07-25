const { createSessionCookie, getConfig, getJsonBody, json, methodNotAllowed } = require('../_lib/jadmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST']);
    return;
  }

  try {
    const { sharedAdminLogin, sharedAdminPassword } = getConfig();
    const body = await getJsonBody(req);
    const loginId = String(body?.loginId || '').trim();
    const password = String(body?.password || '');

    if (loginId !== sharedAdminLogin || password !== sharedAdminPassword) {
      json(res, 401, { error: '帳號或密碼錯誤。' });
      return;
    }

    res.setHeader('Set-Cookie', createSessionCookie());
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 500, { error: error.message || '登入失敗。' });
  }
};
