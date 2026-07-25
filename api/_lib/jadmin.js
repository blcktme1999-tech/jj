const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

function getConfig() {
  const config = {
    sessionSecret: process.env.SESSION_SECRET,
    sharedAdminLogin: process.env.SHARED_ADMIN_LOGIN,
    sharedAdminPassword: process.env.SHARED_ADMIN_PASSWORD,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseAdminUserId: process.env.SUPABASE_ADMIN_USER_ID,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    supabaseAdminEmail: process.env.SUPABASE_ADMIN_EMAIL,
    supabaseAdminPassword: process.env.SUPABASE_ADMIN_PASSWORD
  };

  if (!config.sessionSecret || !config.sharedAdminLogin || !config.sharedAdminPassword || !config.supabaseUrl) {
    throw new Error('Missing required environment variables.');
  }

  const hasServiceRoleMode = Boolean(config.supabaseServiceRoleKey && config.supabaseAdminUserId);
  const hasPasswordMode = Boolean(config.supabaseAnonKey && config.supabaseAdminEmail && config.supabaseAdminPassword);
  if (!hasServiceRoleMode && !hasPasswordMode) {
    throw new Error('Missing Supabase admin mode config. Set SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ADMIN_USER_ID, or SUPABASE_ANON_KEY + SUPABASE_ADMIN_EMAIL + SUPABASE_ADMIN_PASSWORD.');
  }

  return config;
}

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

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((cookies, part) => {
    const trimmed = part.trim();
    if (!trimmed) return cookies;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) return cookies;
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function signSessionValue(loginId, expiresAt, sessionSecret) {
  return crypto.createHmac('sha256', sessionSecret).update(loginId + '.' + expiresAt).digest('hex');
}

function createSessionCookie() {
  const { sessionSecret, sharedAdminLogin } = getConfig();
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const signature = signSessionValue(sharedAdminLogin, expiresAt, sessionSecret);
  const rawValue = [sharedAdminLogin, String(expiresAt), signature].join('.');
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(rawValue),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function createLogoutCookie() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const parts = [
    SESSION_COOKIE + '=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function hasAdminSession(req) {
  try {
    const { sessionSecret, sharedAdminLogin } = getConfig();
    const cookies = parseCookies(req);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return false;

    const parts = raw.split('.');
    if (parts.length !== 3) return false;

    const [loginId, expiresAtText, signature] = parts;
    const expiresAt = Number(expiresAtText);
    if (!expiresAt || expiresAt < Date.now()) return false;
    if (loginId !== sharedAdminLogin) return false;

    const expected = signSessionValue(loginId, expiresAt, sessionSecret);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length) return false;

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch (_) {
    return false;
  }
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

function requireAdminSession(req, res) {
  if (!hasAdminSession(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function signInAdmin() {
  const config = getConfig();
  const hasPasswordMode = Boolean(config.supabaseAnonKey && config.supabaseAdminEmail && config.supabaseAdminPassword);

  if (config.supabaseServiceRoleKey && config.supabaseAdminUserId) {
    const serviceKey = String(config.supabaseServiceRoleKey || '');
    const looksLikePublishable = serviceKey.startsWith('sb_publishable_');

    if (!looksLikePublishable) {
      const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      });

      return {
        client,
        user: {
          id: config.supabaseAdminUserId,
          email: config.supabaseAdminEmail || null
        }
      };
    }

    if (!hasPasswordMode) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY looks like a publishable key. Please set a valid service role key.');
    }
  }

  if (!hasPasswordMode) {
    throw new Error('Supabase admin config is incomplete.');
  }

  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const { data, error } = await client.auth.signInWithPassword({
    email: config.supabaseAdminEmail,
    password: config.supabaseAdminPassword
  });

  if (error || !data?.user) {
    throw error || new Error('Unable to sign in admin user with email/password mode.');
  }

  return { client, user: data.user };
}

module.exports = {
  createLogoutCookie,
  createSessionCookie,
  getConfig,
  getJsonBody,
  json,
  methodNotAllowed,
  requireAdminSession,
  signInAdmin
};
