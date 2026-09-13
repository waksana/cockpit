// Keep images path-only. Browsers normalize backslashes and strip tabs/newlines,
// which can turn an apparent local path into a protocol-relative external URL.
export function isMessageImageSrcAllowed(src: string | undefined): boolean {
  if (!src || src.includes('\\') || /[\t\n\r]/.test(src)) return false
  return (
    (src.startsWith('/') && !src.startsWith('//')) ||
    src.startsWith('./') ||
    src.startsWith('../')
  )
}
