const { json, methodNotAllowed, requireAdminSession, signInAdmin } = require('../_lib/jadmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return;
  }

  if (!requireAdminSession(req, res)) {
    return;
  }

  try {
    const { client, user } = await signInAdmin();
    const [profileResult, recordsResult] = await Promise.all([
      client.from('user_profiles').select('*').eq('auth_user_id', user.id).maybeSingle(),
      client.from('user_records').select('*').eq('auth_user_id', user.id).order('created_at', { ascending: false })
    ]);

    if (profileResult.error) throw profileResult.error;
    if (recordsResult.error) throw recordsResult.error;

    json(res, 200, {
      profile: profileResult.data || {},
      records: recordsResult.data || []
    });
  } catch (error) {
    json(res, 500, { error: error.message || '讀取後台資料失敗。' });
  }
};
