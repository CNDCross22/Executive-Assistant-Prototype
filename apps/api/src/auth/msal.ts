import {
  ConfidentialClientApplication,
  CryptoProvider,
  type AuthenticationResult,
  type Configuration,
  type ICachePlugin,
} from '@azure/msal-node';
import { env, redirectUri } from '../config/env.js';
import { activeScopes, activeGraphScopes } from '../config/graphScopes.js';
import { Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { cachePluginFor, scratchCachePlugin, adoptScratchCache, clearTokenCache } from './tokenCache.js';

export const cryptoProvider = new CryptoProvider();

export function microsoftConfigured(): boolean {
  return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_TENANT_ID);
}

function baseConfig(cachePlugin?: ICachePlugin): Configuration {
  if (!microsoftConfigured()) throw Errors.notConfigured('Microsoft sign-in');
  return {
    auth: {
      clientId: env.MICROSOFT_CLIENT_ID!,
      clientSecret: env.MICROSOFT_CLIENT_SECRET!,
      // Single-tenant authority. Accounts from other organisations cannot sign in.
      authority: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}`,
    },
    ...(cachePlugin ? { cache: { cachePlugin } } : {}),
    system: {
      loggerOptions: {
        loggerCallback: (_level, message, containsPii) => {
          if (!containsPii) logger.debug({ msal: message }, 'msal');
        },
        piiLoggingEnabled: false,
      },
    },
  };
}

export interface PkcePair {
  challenge: string;
  verifier: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const { challenge, verifier } = await cryptoProvider.generatePkceCodes();
  return { challenge, verifier };
}

export function newState(): string {
  return cryptoProvider.createNewGuid();
}

/** Build the Microsoft sign-in URL. */
export async function buildAuthCodeUrl(state: string, pkce: PkcePair): Promise<string> {
  const client = new ConfidentialClientApplication(baseConfig());
  return client.getAuthCodeUrl({
    scopes: activeScopes(),
    redirectUri: redirectUri(),
    state,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: 'S256',
    prompt: 'select_account',
  });
}

export interface ExchangeResult {
  result: AuthenticationResult;
  cacheBlob: string | null;
}

/** Exchange the authorization code. Uses a scratch cache; we do not have a user id yet. */
export async function exchangeCode(code: string, verifier: string): Promise<ExchangeResult> {
  const sink: { blob: string | null } = { blob: null };
  const client = new ConfidentialClientApplication(baseConfig(scratchCachePlugin(sink)));
  const result = await client.acquireTokenByCode({
    code,
    scopes: activeScopes(),
    redirectUri: redirectUri(),
    codeVerifier: verifier,
  });
  return { result, cacheBlob: sink.blob };
}

export async function persistCacheForUser(userId: string, cacheBlob: string): Promise<void> {
  await adoptScratchCache(userId, cacheBlob);
}

/**
 * Get a Graph access token for a user, refreshing silently.
 * Throws `needs_reauth` when the refresh token is gone or revoked.
 */
export async function getAccessToken(userId: string, homeAccountId: string): Promise<string> {
  const client = new ConfidentialClientApplication(baseConfig(cachePluginFor(userId)));
  const cache = client.getTokenCache();
  const account = await cache.getAccountByHomeId(homeAccountId);

  if (!account) {
    logger.warn({ userId }, 'No cached Microsoft account; re-auth required');
    throw Errors.needsReauth();
  }

  try {
    const result = await client.acquireTokenSilent({
      account,
      scopes: activeGraphScopes(),
      forceRefresh: false,
    });
    if (!result?.accessToken) throw Errors.needsReauth();
    return result.accessToken;
  } catch (err) {
    logger.warn({ userId, err }, 'Silent token acquisition failed');
    await clearTokenCache(userId);
    throw Errors.needsReauth();
  }
}

export async function signOutUser(userId: string): Promise<void> {
  await clearTokenCache(userId);
}

/** Where to send the browser to end the Microsoft session too. */
export function logoutUrl(): string {
  const post = encodeURIComponent(env.APP_URL);
  return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`;
}
