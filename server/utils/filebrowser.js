'use strict';

const path = require('path');
const { userError } = require('./errorSanitizer');

function getFileBrowserUrl() {
  return process.env.FILEBROWSER_URL || 'http://localhost:8080';
}

/**
 * Issue #533: a caller-chosen FileBrowser path never steers the request on the
 * FileBrowser host. `.`/`..` segments, `?`, `#`, backslashes, control
 * characters and lone surrogates are refused; every remaining segment is percent-encoded.
 * Returns the clean path ("/a/b") and its URL-encoded form ("/a/b").
 */
function normalizeFileBrowserPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '' || !rawPath.isWellFormed()) {
    throw userError('Ungültiger Dateipfad.', 400);
  }
  // eslint-disable-next-line no-control-regex
  if (/[?#\\\u0000-\u001f\u007f]/.test(rawPath)) {
    throw userError('Ungültiger Dateipfad.', 400);
  }
  const segments = rawPath.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw userError('Ungültiger Dateipfad.', 400);
  }
  return {
    path: '/' + segments.join('/'),
    encoded: '/' + segments.map(encodeURIComponent).join('/')
  };
}

function buildFileBrowserAttachment(fileItem, shareUrl) {
  const url = shareUrl || fileItem.url || `${getFileBrowserUrl()}/files${fileItem.path || '/' + (fileItem.name || 'file')}`;
  const name = fileItem.name || (fileItem.path ? path.basename(fileItem.path) : 'attachment');
  const mimeType = fileItem.mimeType || (name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');

  return {
    url,
    name,
    mimeType
  };
}

// The link is persisted into the event and seen by every sharee, so it carries
// no credential; opening it needs the viewer's own FileBrowser login (#533).
async function createFileBrowserShareLink(filePath) {
  const target = normalizeFileBrowserPath(filePath);
  const fileName = path.posix.basename(target.path);

  return {
    url: `${getFileBrowserUrl()}/files${target.encoded}`,
    name: fileName,
    mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
  };
}

async function fetchFileBrowserFiles(directoryPath = '/', oidcToken = null) {
  const baseUrl = getFileBrowserUrl();
  const target = normalizeFileBrowserPath(directoryPath);
  const targetPath = target.path;

  const headers = {
    'Accept': 'application/json'
  };
  if (oidcToken) {
    headers['Authorization'] = oidcToken.startsWith('Bearer ') ? oidcToken : `Bearer ${oidcToken}`;
  }

  // An unreachable or failing FileBrowser is an error the user sees, never a made-up listing (#343).
  const res = await fetch(`${baseUrl}/api/resources${target.encoded}`, { headers });
  if (!res.ok) {
    throw new Error(`FileBrowser listing of ${targetPath} failed (${res.status})`);
  }
  const data = await res.json();
  return {
    success: true,
    path: targetPath,
    items: (data.items || []).map(item => {
      const itemPath = item.path || `${targetPath}/${item.name}`.replace(/\/\//g, '/');
      return {
        name: item.name,
        path: itemPath,
        isDir: Boolean(item.isDir),
        size: item.size || 0,
        modified: item.modified || new Date().toISOString(),
        mimeType: item.type || (item.name?.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
        url: `${baseUrl}/files${itemPath.split('/').map(encodeURIComponent).join('/')}`
      };
    })
  };
}

module.exports = {
  getFileBrowserUrl,
  normalizeFileBrowserPath,
  buildFileBrowserAttachment,
  createFileBrowserShareLink,
  fetchFileBrowserFiles
};
