'use strict';

const zlib = require('zlib');

function isCompressibleType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).toLowerCase();
  return (
    type.includes('text/') ||
    type.includes('application/javascript') ||
    type.includes('application/x-javascript') ||
    type.includes('application/json') ||
    type.includes('application/xml') ||
    type.includes('image/svg+xml')
  );
}

function compressionMiddleware(options = {}) {
  const threshold = options.threshold !== undefined ? options.threshold : 256;

  return function (req, res, next) {
    if (req.method === 'HEAD') {
      return next();
    }

    const acceptEncoding = req.headers['accept-encoding'] || '';
    let encoding = null;
    if (acceptEncoding.includes('gzip')) {
      encoding = 'gzip';
    } else if (acceptEncoding.includes('br')) {
      encoding = 'br';
    } else if (acceptEncoding.includes('deflate')) {
      encoding = 'deflate';
    }

    if (!encoding) {
      return next();
    }

    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalWriteHead = res.writeHead;

    let compressStream = null;
    let isCompressing = false;
    let bufferChunks = [];
    let bufferedLength = 0;

    function flushHeadersIfNeeded() {
      if (!res.headersSent) {
        originalWriteHead.call(res, res.statusCode || 200);
      }
    }

    function initCompression() {
      if (isCompressing) return true;
      if (res.getHeader('Content-Encoding')) return false;

      const contentType = res.getHeader('Content-Type');
      if (!isCompressibleType(contentType)) return false;

      const currentVary = res.getHeader('Vary');
      if (!currentVary) {
        res.setHeader('Vary', 'Accept-Encoding');
      } else if (!String(currentVary).toLowerCase().includes('accept-encoding')) {
        res.setHeader('Vary', `${currentVary}, Accept-Encoding`);
      }

      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');

      if (encoding === 'gzip') {
        compressStream = zlib.createGzip();
      } else if (encoding === 'br') {
        compressStream = zlib.createBrotliCompress();
      } else if (encoding === 'deflate') {
        compressStream = zlib.createDeflate();
      }

      compressStream.on('data', (chunk) => {
        flushHeadersIfNeeded();
        if (originalWrite.call(res, chunk) === false) {
          compressStream.pause();
        }
      });

      res.on('drain', () => {
        if (compressStream && compressStream.isPaused && compressStream.isPaused()) {
          compressStream.resume();
        }
      });

      compressStream.on('drain', () => {
        res.emit('drain');
      });

      compressStream.on('end', () => {
        flushHeadersIfNeeded();
        if (typeof res._compressionCallback === 'function') {
          originalEnd.call(res, res._compressionCallback);
        } else {
          originalEnd.call(res);
        }
      });

      isCompressing = true;
      return true;
    }

    res.writeHead = function (statusCode, statusMessage, headers) {
      let headerObj = headers;
      if (typeof statusMessage === 'object') {
        headerObj = statusMessage;
        statusMessage = undefined;
      }

      res.statusCode = statusCode;
      if (statusMessage) res.statusMessage = statusMessage;

      if (headerObj) {
        for (const [k, v] of Object.entries(headerObj)) {
          res.setHeader(k, v);
        }
      }

      if (statusCode === 304 || statusCode === 204 || statusCode < 200) {
        return originalWriteHead.call(res, res.statusCode, res.statusMessage);
      }

      initCompression();
      if (!isCompressing) {
        return originalWriteHead.call(res, res.statusCode, res.statusMessage);
      }
    };

    res.write = function (chunk, enc, cb) {
      if (!chunk) return true;
      if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }

      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);

      if (!isCompressing && compressStream === null) {
        bufferedLength += buf.length;
        bufferChunks.push(buf);

        if (bufferedLength >= threshold) {
          if (initCompression()) {
            let written = true;
            for (const item of bufferChunks) {
              written = compressStream.write(item) && written;
            }
            bufferChunks = [];
            return written;
          } else {
            flushHeadersIfNeeded();
            let written = true;
            for (const item of bufferChunks) {
              written = originalWrite.call(res, item) && written;
            }
            bufferChunks = [];
            return written;
          }
        } else {
          return true;
        }
      }

      if (isCompressing && compressStream) {
        return compressStream.write(buf, cb);
      }

      flushHeadersIfNeeded();
      return originalWrite.call(res, chunk, enc, cb);
    };

    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
        enc = undefined;
      } else if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }

      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
        bufferedLength += buf.length;
        bufferChunks.push(buf);
      }

      if (!isCompressing && compressStream === null) {
        if (bufferedLength >= threshold) {
          initCompression();
        }
      }

      if (isCompressing && compressStream) {
        if (cb) res._compressionCallback = cb;
        for (const item of bufferChunks) {
          compressStream.write(item);
        }
        bufferChunks = [];
        compressStream.end();
      } else {
        flushHeadersIfNeeded();
        for (const item of bufferChunks) {
          originalWrite.call(res, item);
        }
        bufferChunks = [];
        if (cb) {
          return originalEnd.call(res, cb);
        }
        return originalEnd.call(res);
      }
    };

    next();
  };
}

module.exports = compressionMiddleware;
