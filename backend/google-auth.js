export function googleProviderConfig(clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    // An extension may be used on a shared dealership computer. Always let the user choose
    // which Google identity CarXprt should use instead of silently reusing Chrome's default.
    prompt: 'select_account'
  };
}
