export function isLoginGateBypassedForLocal() {
  return process.env.NEXT_PUBLIC_BYPASS_LOGIN_FOR_LOCAL === 'true';
}
