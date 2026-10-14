'use strict';

const path = require('path');

function getFileBrowserUrl() {
  return process.env.FILEBROWSER_URL || 'http://localhost:8080';
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

async function createFileBrowserShareLink(filePath, oidcToken) {
  const cleanPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const fileName = path.basename(cleanPath);
  const baseUrl = getFileBrowserUrl();
  const shareUrl = `${baseUrl}/files${cleanPath}?token=oidc-${encodeURIComponent(oidcToken || 'session')}`;

  return {
    url: shareUrl,
    name: fileName,
    mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
  };
}

async function fetchFileBrowserFiles(directoryPath = '/', oidcToken = null) {
  const baseUrl = getFileBrowserUrl();
  const targetPath = directoryPath.startsWith('/') ? directoryPath : `/${directoryPath}`;

  const headers = {
    'Accept': 'application/json'
  };
  if (oidcToken) {
    headers['Authorization'] = oidcToken.startsWith('Bearer ') ? oidcToken : `Bearer ${oidcToken}`;
  }

  // An unreachable or failing FileBrowser is an error the user sees, never a made-up listing (#343).
  const res = await fetch(`${baseUrl}/api/resources${targetPath}`, { headers });
  if (!res.ok) {
    throw new Error(`FileBrowser listing of ${targetPath} failed (${res.status})`);
  }
  const data = await res.json();
  return {
    success: true,
    path: targetPath,
    items: (data.items || []).map(item => ({
      name: item.name,
      path: item.path || `${targetPath}/${item.name}`.replace(/\/\//g, '/'),
      isDir: Boolean(item.isDir),
      size: item.size || 0,
      modified: item.modified || new Date().toISOString(),
      mimeType: item.type || (item.name?.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
      url: `${baseUrl}/files${item.path || `${targetPath}/${item.name}`}`
    }))
  };
}

module.exports = {
  getFileBrowserUrl,
  buildFileBrowserAttachment,
  createFileBrowserShareLink,
  fetchFileBrowserFiles
};
