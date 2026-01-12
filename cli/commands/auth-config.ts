/**
 * Auth Config Types for LucieCode Integration
 *
 * LucieCode passes authentication configuration to RagForge daemon.
 * The daemon reads credential files on each API call for fresh tokens.
 *
 * @since 2025-12-20
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Authentication configuration passed from LucieCode to daemon.
 * LucieCode owns all auth, daemon just reads from file paths.
 */
export type AuthConfig =
  | { type: 'oauth-file'; path: string }   // ~/.luciecode/oauth_creds.json
  | { type: 'vertex-adc' }                 // Uses gcloud ADC automatically
  | { type: 'env' }                        // GEMINI_API_KEY from environment
  ;

/**
 * OAuth credentials format (matches LucieCode's format)
 */
export interface OAuthCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Auth Manager - handles reading credentials based on AuthConfig
 */
export class AuthManager {
  private authConfig: AuthConfig | null = null;
  private credentialsCache: OAuthCredentials | null = null;
  private cacheExpiresAt: number = 0;

  /**
   * Configure authentication
   */
  configure(config: AuthConfig): void {
    this.authConfig = config;
    // Clear cache when config changes
    this.credentialsCache = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * Get current auth config
   */
  getConfig(): AuthConfig | null {
    return this.authConfig;
  }

  /**
   * Check if auth is configured
   */
  isConfigured(): boolean {
    return this.authConfig !== null;
  }

  /**
   * Get access token for API calls.
   * Reads from file if oauth-file, uses gcloud if vertex-adc, or env if env type.
   * Returns null if no auth configured or credentials unavailable.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.authConfig) {
      return null;
    }

    switch (this.authConfig.type) {
      case 'oauth-file':
        return this.getOAuthToken(this.authConfig.path);

      case 'vertex-adc':
        return this.getVertexADCToken();

      case 'env':
        return process.env.GEMINI_API_KEY || null;

      default:
        return null;
    }
  }

  /**
   * Get API key for simpler API usage (for APIs that use API keys instead of OAuth)
   */
  async getApiKey(): Promise<string | null> {
    if (!this.authConfig) {
      return process.env.GEMINI_API_KEY || null;
    }

    switch (this.authConfig.type) {
      case 'env':
        return process.env.GEMINI_API_KEY || null;

      case 'oauth-file':
      case 'vertex-adc':
        // OAuth/ADC don't use API keys, they use access tokens
        return null;

      default:
        return process.env.GEMINI_API_KEY || null;
    }
  }

  /**
   * Get auth type for informational purposes
   */
  getAuthType(): string {
    if (!this.authConfig) {
      return 'none';
    }
    return this.authConfig.type;
  }

  /**
   * Read OAuth token from file.
   * File is re-read each time to get fresh tokens (LucieCode refreshes them).
   */
  private async getOAuthToken(filePath: string): Promise<string | null> {
    try {
      // Check cache first (valid for 5 seconds to reduce disk reads)
      if (this.credentialsCache && Date.now() < this.cacheExpiresAt) {
        // But still check if token is expired
        if (this.credentialsCache.expires_at && Date.now() < this.credentialsCache.expires_at) {
          return this.credentialsCache.access_token;
        }
      }

      // Read fresh credentials from file
      const content = await fs.readFile(filePath, 'utf-8');
      const creds = JSON.parse(content) as OAuthCredentials;

      // Check if token is expired
      if (creds.expires_at && Date.now() >= creds.expires_at) {
        console.warn('[AuthManager] OAuth token is expired, LucieCode should refresh it');
        // Return it anyway - LucieCode might be refreshing it
        // The API call will fail and trigger a refresh
      }

      // Cache for 5 seconds
      this.credentialsCache = creds;
      this.cacheExpiresAt = Date.now() + 5000;

      return creds.access_token;
    } catch (error: any) {
      console.error(`[AuthManager] Failed to read OAuth credentials from ${filePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get Vertex AI ADC token using gcloud.
   * Uses Application Default Credentials set up via gcloud auth application-default login.
   */
  private async getVertexADCToken(): Promise<string | null> {
    try {
      // Use Google Auth Library to get ADC token
      // This requires @google-cloud/local-auth or similar to be installed

      // For now, try to read from the well-known ADC location
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const adcPath = path.join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');

      const content = await fs.readFile(adcPath, 'utf-8');
      const adcCreds = JSON.parse(content);

      // ADC file contains client_id, client_secret, refresh_token
      // We need to exchange refresh_token for access_token
      // For simplicity, we'll use the token endpoint directly

      if (adcCreds.type === 'authorized_user') {
        // Exchange refresh token for access token
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: adcCreds.client_id,
            client_secret: adcCreds.client_secret,
            refresh_token: adcCreds.refresh_token,
            grant_type: 'refresh_token',
          }),
        });

        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed: ${tokenResponse.status}`);
        }

        const tokens = await tokenResponse.json() as { access_token: string };
        return tokens.access_token;
      }

      // Service account or other ADC types not yet supported
      console.warn('[AuthManager] Unsupported ADC type:', adcCreds.type);
      return null;
    } catch (error: any) {
      console.error(`[AuthManager] Failed to get Vertex ADC token: ${error.message}`);
      return null;
    }
  }
}

// Singleton instance for daemon
export const authManager = new AuthManager();
