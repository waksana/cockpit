type Transfer = Pick<DataTransfer, 'items' | 'files' | 'types'>;

export function hasTransferFiles(data: Transfer): boolean {
  return Array.from(data.types).includes('Files')
    || Array.from(data.items).some(item => item.kind === 'file')
    || data.files.length > 0;
}

export function transferFiles(data: Transfer): File[] {
  const items = Array.from(data.items).filter(item => item.kind === 'file');
  if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
    throw new Error('不支持上传目录；本批未添加，请选择单个或多个文件。');
  }
  // items and files describe the same payload, not two batches to concatenate.
  const files = items.map(item => item.getAsFile()).filter((file): file is File => file !== null);
  if (items.length && files.length === items.length) return files;
  const fallback = Array.from(data.files);
  if (fallback.length >= items.length) return fallback;
  throw new Error('浏览器未提供可读取的文件；本批未添加，请拖入文件或使用附件按钮。');
}

export function readableClipboardHtml(html: string): string {
  // Template contents stay disconnected and inert, including image/iframe URLs.
  const template = document.createElement('template');
  template.innerHTML = html;
  const content = template.content;
  content.querySelectorAll('script, style, template').forEach(node => node.remove());
  content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  content.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6')
    .forEach(node => node.append('\n'));
  return (content.textContent ?? '').trim();
}
