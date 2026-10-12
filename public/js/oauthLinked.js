/**
 * oauthLinked.js — runs in the OAuth popup after an account was linked
 * (server/routes/auth.js). External file because the CSP forbids inline
 * scripts (issue #338).
 */
if (window.opener) {
  window.opener.postMessage('google-account-linked', window.location.origin);
}
window.close();
