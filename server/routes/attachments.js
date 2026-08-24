'use strict';

const express = require('express');
const router = express.Router();
const { fetchFileBrowserFiles, createFileBrowserShareLink, buildFileBrowserAttachment } = require('../utils/filebrowser');

function extractOidcToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return req.session?.oidcToken || req.session?.userId || null;
}

router.get('/filebrowser/files', async (req, res) => {
  try {
    const targetPath = req.query.path || '/';
    const oidcToken = extractOidcToken(req);
    const result = await fetchFileBrowserFiles(targetPath, oidcToken);
    res.json({
      success: true,
      path: result.path,
      files: result.items
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch FileBrowser resources' });
  }
});

router.post('/filebrowser/link', async (req, res) => {
  try {
    const { filePath, mimeType } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const oidcToken = extractOidcToken(req);
    const shareResult = await createFileBrowserShareLink(filePath, oidcToken);
    const attachment = buildFileBrowserAttachment(
      { name: shareResult.name, path: filePath, mimeType: mimeType || shareResult.mimeType },
      shareResult.url
    );

    res.json({
      success: true,
      attachment
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create FileBrowser attachment link' });
  }
});

module.exports = router;
