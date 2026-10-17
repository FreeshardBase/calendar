'use strict';

const express = require('express');
const router = express.Router();
const { fetchFileBrowserFiles, createFileBrowserShareLink, buildFileBrowserAttachment } = require('../utils/filebrowser');
const { sendError } = require('../utils/errorSanitizer');

// Only a token the caller presents is forwarded. The session holds no delegated
// FileBrowser token, and the user id is not a credential (#533).
function extractOidcToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
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
    return sendError(res, err, '[filebrowser files]');
  }
});

router.post('/filebrowser/link', async (req, res) => {
  try {
    const { filePath, mimeType } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const shareResult = await createFileBrowserShareLink(filePath);
    const attachment = buildFileBrowserAttachment(
      { name: shareResult.name, mimeType: mimeType || shareResult.mimeType },
      shareResult.url
    );

    res.json({
      success: true,
      attachment
    });
  } catch (err) {
    return sendError(res, err, '[filebrowser link]');
  }
});

module.exports = router;
