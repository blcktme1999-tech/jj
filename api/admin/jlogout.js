const { createLogoutCookie, json, methodNotAllowed } = require('../_lib/jadmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST']);
    return;
  }

  res.setHeader('Set-Cookie', createLogoutCookie());
  json(res, 200, { ok: true });
};
