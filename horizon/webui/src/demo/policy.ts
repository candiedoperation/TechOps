export const DEMO_PREFIX = '/__horizon_demo__/'
export function isLoopback(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
}
export function demoAllowed(
  buildAllowsDemo: boolean,
  development: boolean,
  setting: unknown,
  hostname: string,
) {
  return buildAllowsDemo && development && setting === 'true' && isLoopback(hostname)
}
export function isDemoPath(url: URL) {
  return (
    isLoopback(url.hostname) &&
    url.pathname.startsWith(DEMO_PREFIX) &&
    !/%|\\|\.\./.test(url.pathname)
  )
}
