export interface VerifiedExternalIdentity {
  readonly provider: string;
  readonly providerSubject: string;
  readonly displayName: string;
}

export interface AuthProviderAdapter {
  readonly providerName: string;
  isConfigured(): boolean;
  buildAuthorizationUrl(params: {
    state: string;
    callbackUrl: string;
  }): string;
  exchangeCodeForIdentity(params: {
    code: string;
    callbackUrl: string;
  }): Promise<VerifiedExternalIdentity>;
}

export interface GitHubOAuthConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Production authentication provider using GitHub OAuth 2.0 browser sign-in flow.
 * Provider secrets (GITHUB_CLIENT_SECRET) remain strictly inside the Cloudflare Worker
 * environment and are never bundled into the Electron desktop app.
 */
export class GitHubOAuthProvider implements AuthProviderAdapter {
  public readonly providerName = 'github';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: GitHubOAuthConfig) {
    this.clientId = (config.clientId ?? '').trim();
    this.clientSecret = (config.clientSecret ?? '').trim();
    this.fetchFn = config.fetchImpl ?? fetch.bind(globalThis);
  }

  public isConfigured(): boolean {
    return this.clientId.length > 0 && this.clientSecret.length > 0;
  }

  public buildAuthorizationUrl(params: {
    state: string;
    callbackUrl: string;
  }): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', params.callbackUrl);
    url.searchParams.set('state', params.state);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('allow_signup', 'true');
    return url.toString();
  }

  public async exchangeCodeForIdentity(params: {
    code: string;
    callbackUrl: string;
  }): Promise<VerifiedExternalIdentity> {
    if (!this.isConfigured()) {
      throw new Error('GitHub OAuth provider credentials are not configured.');
    }

    const tokenResponse = await this.fetchFn(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Elm-AnyDesk-Worker/0.2.0',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: params.code,
          redirect_uri: params.callbackUrl,
        }),
      }
    );

    if (!tokenResponse.ok) {
      throw new Error(
        `GitHub token exchange failed with HTTP ${tokenResponse.status}`
      );
    }

    const tokenJson = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenJson.access_token) {
      throw new Error(
        `GitHub OAuth error: ${
          tokenJson.error_description || tokenJson.error || 'missing access_token'
        }`
      );
    }

    const userResponse = await this.fetchFn('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Elm-AnyDesk-Worker/0.2.0',
      },
    });

    if (!userResponse.ok) {
      throw new Error(
        `GitHub user profile fetch failed with HTTP ${userResponse.status}`
      );
    }

    const userJson = (await userResponse.json()) as {
      id?: number | string;
      login?: string;
      name?: string | null;
    };

    if (userJson.id === undefined || userJson.id === null) {
      throw new Error('GitHub user profile missing stable id');
    }

    const displayName = (userJson.name || userJson.login || 'GitHub User').trim();

    return {
      provider: this.providerName,
      providerSubject: String(userJson.id),
      displayName,
    };
  }
}
