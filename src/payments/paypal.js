const PAYPAL_BASE = (process.env.PAYPAL_ENV === 'live')
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/**
 * Exchange client credentials for an access token.
 */
export async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('missing_paypal_creds');
  const resp = await fetch(PAYPAL_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('paypal_token_failed:' + t);
  }
  const j = await resp.json();
  return j.access_token;
}

/**
 * Retrieve subscription details by ID.
 */
export async function getSubscription(subId) {
  const token = await getAccessToken();
  const resp = await fetch(PAYPAL_BASE + '/v1/billing/subscriptions/' + subId, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('paypal_sub_lookup_failed:' + t);
  }
  return await resp.json();
}
