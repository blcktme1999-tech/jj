const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowedMethods) {
  res.setHeader('Allow', allowedMethods.join(', '));
  json(res, 405, { error: 'Method not allowed.' });
}

async function getJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function normalizeUid(uidInput) {
  if (uidInput === undefined || uidInput === null) return null;
  const raw = String(uidInput).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    if (Number.isSafeInteger(num) && num >= 0) {
      return num;
    }
  }

  return raw;
}

function resolveExpiresIn() {
  // Agora token cannot be truly permanent; use a long TTL by default.
  const defaultSeconds = 60 * 60 * 24 * 365 * 10;
  const maxSeconds = 60 * 60 * 24 * 365 * 20;
  const minSeconds = 60;

  const raw = String(process.env.AGORA_TOKEN_EXPIRES_IN || '').trim();
  if (!raw) return defaultSeconds;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultSeconds;

  const value = Math.floor(parsed);
  if (value <= 0) return maxSeconds;
  if (value < minSeconds) return minSeconds;
  if (value > maxSeconds) return maxSeconds;
  return value;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST']);
    return;
  }

  try {
    const appId = String(process.env.AGORA_APP_ID || '').trim();
    const appCertificate = String(process.env.AGORA_APP_CERTIFICATE || '').trim();

    if (!appId || !appCertificate) {
      json(res, 500, { error: 'Agora token service is not configured.' });
      return;
    }

    const body = await getJsonBody(req);
    const channel = String(body?.channel || '').trim();
    const uid = normalizeUid(body?.uid);

    if (!channel) {
      json(res, 400, { error: 'Missing channel.' });
      return;
    }

    if (uid === null) {
      json(res, 400, { error: 'Missing uid.' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    // Some validators still expect 32-bit Unix time; cap expiry to avoid invalid future claims.
    const maxUnixSeconds = 2147483647 - 60;
    const desiredExpiresIn = resolveExpiresIn();
    const expiresAt = Math.min(now + desiredExpiresIn, maxUnixSeconds);
    const expiresIn = Math.max(60, expiresAt - now);
    const role = RtcRole.PUBLISHER;

    let token;
    if (typeof uid === 'number') {
      token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channel, uid, role, expiresAt);
    } else {
      token = RtcTokenBuilder.buildTokenWithAccount(appId, appCertificate, channel, uid, role, expiresAt);
    }

    json(res, 200, {
      token,
      appId,
      uid,
      expiresIn,
      expiresAt
    });
  } catch (error) {
    json(res, 500, { error: error.message || 'Failed to build RTC token.' });
  }
};
