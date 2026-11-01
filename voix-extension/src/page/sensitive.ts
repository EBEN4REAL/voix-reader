// Pages whose text is never sent to the voice service (the privacy notice
// promises this for banking and email). A deliberately simple host check.

const EMAIL_HOSTS = [
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com", "mail.proton.me", "app.fastmail.com", "www.icloud.com", "mail.zoho.com",
];
const FINANCE_HOSTS = ["paypal.com", "wise.com", "revolut.com", "stripe.com", "venmo.com", "cash.app"];

export function isSensitiveHost(host: string = location.hostname): boolean {
  const h = host.toLowerCase();
  if (EMAIL_HOSTS.includes(h)) return true;
  if (FINANCE_HOSTS.some((d) => h === d || h.endsWith("." + d))) return true;
  return h.includes("bank"); // errs on the side of privacy (also matches e.g. bankrate.com)
}
