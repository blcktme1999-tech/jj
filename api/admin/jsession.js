const { hasOwnProperty } = Object.prototype;
const { json, methodNotAllowed, requireAdminSession } = require('../_lib/jadmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return;
  }

  if (!requireAdminSession(req, res)) {
    return;
  }

  json(res, 200, { authenticated: true });
};
