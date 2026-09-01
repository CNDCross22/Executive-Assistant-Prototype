import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env, allowedEmailDomains, allowedUsers, emailIsAllowed, getSetupStatus, isDemo } from '../config/env.js';
import { Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/crypto.js';
import {
  buildAuthCodeUrl,
  exchangeCode,
  generatePkce,
  newState,
  persistCacheForUser,
  microsoftConfigured,
  logoutUrl,
  signOutUser,
} from '../auth/msal.js';
import { authStore } from '../auth/store.js';
import { issueSession, clearSession, currentUser, requireAuth } from '../auth/session.js';
import { UserService } from '../graph/user.service.js';
import { subscribeToInbox } from '../realtime/subscriptions.js';

const FLOW_COOKIE = 'hermes_flow';

const callbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  /** Present when an administrator arrives via the admin-consent endpoint. */
  admin_consent: z.string().optional(),
  tenant: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Where the browser asks "who am I, and is anything set up?" */
  app.get('/api/auth/me', async (request) => {
    const setup = getSetupStatus();

    if (isDemo) {
      const { fixtureUser } = await import('../dev/fixtures.js');
      const demo = fixtureUser();
      return {
        authenticated: true,
        demo: true,
        setup,
        user: {
          id: demo.id,
          email: demo.email,
          displayName: demo.displayName,
          jobTitle: demo.jobTitle,
          timezone: demo.timezone,
        },
        microsoft: { status: 'connected' as const },
      };
    }

    const user = await currentUser(request);

    if (!user) return { authenticated: false, setup };

    const connection = await authStore().getConnection(user.id);
    return {
      authenticated: true,
      setup,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        jobTitle: user.jobTitle,
        timezone: user.timezone,
      },
      microsoft: { status: connection?.status ?? 'needs_reauth' },
    };
  });

  app.get('/api/auth/login', async (request, reply) => {
    if (!microsoftConfigured()) throw Errors.notConfigured('Microsoft sign-in');

    const state = newState();
    const pkce = await generatePkce();

    // State and verifier ride in a short-lived signed cookie, not server memory,
    // so the flow survives a restart during development.
    reply.setCookie(FLOW_COOKIE, JSON.stringify({ state, verifier: pkce.verifier }), {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.COOKIE_SAME_SITE,
      path: '/',
      maxAge: 600,
      signed: true,
    });

    const url = await buildAuthCodeUrl(state, pkce);
    return reply.redirect(url);
  });

  app.get('/api/auth/callback', async (request, reply) => {
    const params = callbackSchema.parse(request.query);

    if (params.error) {
      logger.warn({ error: params.error, detail: params.error_description }, 'Microsoft returned an error');
      return reply.redirect(`${env.APP_URL}/signin?error=${encodeURIComponent(params.error)}`);
    }

    // An administrator granting consent lands here with no auth code. That is a
    // success, not a failure, and they should not see a broken page for it.
    if (params.admin_consent) {
      const granted = params.admin_consent.toLowerCase() === 'true';
      logger.info({ tenant: params.tenant, granted }, 'Admin consent callback');
      return reply.redirect(`${env.APP_URL}/signin?consent=${granted ? 'granted' : 'declined'}`);
    }

    if (!params.code || !params.state) throw Errors.badRequest('Missing code or state.');

    const rawFlow = request.cookies[FLOW_COOKIE];
    if (!rawFlow) throw Errors.badRequest('Sign-in took too long. Please try again.');

    const unsigned = request.unsignCookie(rawFlow);
    if (!unsigned.valid || !unsigned.value) throw Errors.badRequest('Sign-in could not be verified.');

    const flow = JSON.parse(unsigned.value) as { state: string; verifier: string };
    if (!safeEqual(flow.state, params.state)) throw Errors.badRequest('Sign-in could not be verified.');

    reply.clearCookie(FLOW_COOKIE, {
      path: '/',
      secure: env.NODE_ENV === 'production',
      sameSite: env.COOKIE_SAME_SITE,
    });

    const { result, cacheBlob } = await exchangeCode(params.code, flow.verifier);

    // --- Tenant lock. A token from any other organisation is rejected. ---
    const claims = result.idTokenClaims as { tid?: string; oid?: string; preferred_username?: string } | undefined;
    if (!claims?.tid || claims.tid !== env.MICROSOFT_TENANT_ID) {
      logger.warn({ tid: claims?.tid }, 'Rejected sign-in from a different tenant');
      return reply.redirect(`${env.APP_URL}/signin?error=wrong_tenant`);
    }

    // --- Allowlist. Named accounts or explicitly configured organisation domains. ---
    const signedInAs = (result.account?.username ?? claims.preferred_username ?? '').toLowerCase();
    const allowed = allowedUsers();
    const allowedDomains = allowedEmailDomains();

    // Read the real profile from Graph rather than trusting the token alone.
    const { GraphClient } = await import('../graph/client.js');
    const graph = new GraphClient(result.accessToken, { userId: signedInAs });
    const profile = await new UserService(graph).getProfile();
    // A Microsoft UPN can use the tenant's onmicrosoft.com alias while the
    // canonical mailbox address uses the organisation domain. Accept either
    // verified representation, but fail closed when neither is configured.
    const tokenIdentityAllowed = emailIsAllowed(signedInAs, allowed, allowedDomains);
    const profileIdentityAllowed = emailIsAllowed(profile.email, allowed, allowedDomains);
    if (!tokenIdentityAllowed && !profileIdentityAllowed) {
      logger.warn({ signedInAs, profileEmail: profile.email }, 'Rejected profile outside the configured email allowlist');
      return reply.redirect(`${env.APP_URL}/signin?error=not_allowed`);
    }

    let timezone = 'UTC';
    try {
      timezone = (await new UserService(graph).getMailboxSettings()).timezone;
    } catch {
      logger.debug('Mailbox settings unavailable at sign-in; defaulting timezone');
    }

    const user = await authStore().upsertUser({
      msUserId: profile.msUserId,
      email: profile.email.toLowerCase(),
      displayName: profile.displayName,
      jobTitle: profile.jobTitle,
      timezone,
    });

    if (cacheBlob) await persistCacheForUser(user.id, cacheBlob);

    await authStore().saveConnection({
      userId: user.id,
      homeAccountId: result.account?.homeAccountId ?? '',
      scopes: result.scopes ?? [],
      status: 'connected',
    });

    await issueSession(reply, user.id);
    logger.info({ userId: user.id, email: user.email }, 'Signed in');

    // Start real-time mail for this account. Deliberately not awaited: a
    // subscription failure must never block a successful sign-in, and the
    // scheduled renewal pass creates anything missed here.
    void subscribeToInbox(user.id, graph).catch((err) => {
      logger.warn({ err, userId: user.id }, 'Could not start real-time mail at sign-in');
    });

    return reply.redirect(env.APP_URL);
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    await clearSession(request, reply);
    await signOutUser(userId);
    await authStore().markNeedsReauth(userId);
    return { ok: true, microsoftLogoutUrl: logoutUrl() };
  });
}
