import { env } from '../../config/env.js';
import type { AdConnector } from './connector.js';
import { MetaConnector } from './meta-connector.js';
import { GoogleConnector } from './google-connector.js';

/**
 * Build the connectors whose credentials are present. Missing creds → the
 * connector is simply absent and its job logs-and-skips, so the service runs
 * fine before any ad account is wired.
 */
export function buildConnectors(): AdConnector[] {
  const connectors: AdConnector[] = [];

  if (env.META_ACCESS_TOKEN && env.META_AD_ACCOUNT_ID) {
    connectors.push(
      new MetaConnector({
        accessToken: env.META_ACCESS_TOKEN,
        adAccountId: env.META_AD_ACCOUNT_ID,
        graphVersion: env.META_GRAPH_VERSION,
      }),
    );
  }

  if (
    env.GOOGLE_ADS_DEVELOPER_TOKEN &&
    env.GOOGLE_ADS_CLIENT_ID &&
    env.GOOGLE_ADS_CLIENT_SECRET &&
    env.GOOGLE_ADS_REFRESH_TOKEN &&
    env.GOOGLE_ADS_LOGIN_CUSTOMER_ID &&
    env.GOOGLE_ADS_CUSTOMER_ID
  ) {
    connectors.push(
      new GoogleConnector({
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
        clientId: env.GOOGLE_ADS_CLIENT_ID,
        clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
        refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
        loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
        apiVersion: env.GOOGLE_ADS_API_VERSION,
      }),
    );
  }

  return connectors;
}
