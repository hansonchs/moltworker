#!/usr/bin/env node
// Google Service Account JWT Auth — Zero dependencies
// Generates access tokens from a GCP service account JSON file
// using node:crypto for RS256 signing + built-in fetch for token exchange.

import fs from 'node:fs';
import crypto from 'node:crypto';

const CREDENTIALS_PATH = '/root/clawd/credentials/gcp-service-account.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Cache: { token, expiresAt }
let tokenCache = {};

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Service account credentials not found at ${CREDENTIALS_PATH}\n` +
      'Please upload your GCP service account JSON to /root/clawd/credentials/gcp-service-account.json'
    );
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function createJWT(credentials, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(credentials.private_key, 'base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Get an access token for the given scopes.
 * Caches tokens for ~55 minutes to avoid unnecessary requests.
 * @param {string|string[]} scopes - Google API scope(s)
 * @returns {Promise<string>} access token
 */
export async function getAccessToken(scopes) {
  const scopeKey = Array.isArray(scopes) ? scopes.sort().join(',') : scopes;

  // Return cached token if still valid (with 5 min buffer)
  if (tokenCache[scopeKey] && tokenCache[scopeKey].expiresAt > Date.now() + 300_000) {
    return tokenCache[scopeKey].token;
  }

  const credentials = loadCredentials();
  const jwt = createJWT(credentials, scopes);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  }

  tokenCache[scopeKey] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return data.access_token;
}

/**
 * Get the service account email (useful for setup instructions).
 */
export function getServiceAccountEmail() {
  const credentials = loadCredentials();
  return credentials.client_email;
}
