const http2 = require('http2');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { v4: uuidV4 } = require('uuid');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const { TunnelRequest, TunnelResponse, HTTP2TunnelRequest, HTTP2TunnelResponse } = require('./lib2');

// Create Express app
const app = express();

// Create separate HTTP/1.1 and HTTP/2 servers
let httpServer;
let http2Server;

// For HTTP/2
if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
  const options = {
    key: fs.readFileSync(process.env.SSL_KEY_PATH),
    cert: fs.readFileSync(process.env.SSL_CERT_PATH),
    allowHTTP1: true // Allow HTTP/1 connections on the same port
  };
  
  // Create HTTP/2 server
  http2Server = http2.createSecureServer(options);
  httpServer = http2Server;
  
  console.log('Using HTTP/2 server with SSL');
} else {
  // Fallback to HTTP/1.1 server if no SSL certs
  httpServer = http.createServer();
  console.log('Using HTTP/1.1 server (no SSL certificates provided)');
}

// Socket.io configuration
const webTunnelPath = '/$web_tunnel';
const io = new Server(httpServer, {
  path: webTunnelPath,
});

// Tunnel socket management
let tunnelSockets = [];

function getTunnelSocket(host, pathPrefix) {
  return tunnelSockets.find((s) =>
    s.host === host && s.pathPrefix === pathPrefix
  );
}

function setTunnelSocket(host, pathPrefix, socket) {
  tunnelSockets.push({
    host,
    pathPrefix,
    socket,
    supportsHTTP2: socket.handshake.headers['supports-http2'] === 'true',
  });
}

function removeTunnelSocket(host, pathPrefix) {
  tunnelSockets = tunnelSockets.filter((s) => 
    !(s.host === host && s.pathPrefix === pathPrefix)
  );
  console.log('tunnelSockets: ', tunnelSockets);
}

function getAvailableTunnelSocket(host, url) {
  const tunnels = tunnelSockets.filter((s) => {
    if (s.host !== host) {
      return false;
    }
    if (!s.pathPrefix) {
      return true;
    }
    return url.indexOf(s.pathPrefix) === 0;
  }).sort((a, b) => {
    if (!a.pathPrefix) {
      return 1;
    }
    if (!b.pathPrefix) {
      return -1;
    }
    return b.pathPrefix.length - a.pathPrefix.length;
  });
  if (tunnels.length === 0) {
    return null;
  }
  return tunnels[0];
}

// Socket.io authentication middleware
io.use((socket, next) => {
  const connectHost = socket.handshake.headers.host;
  const pathPrefix = socket.handshake.headers['path-prefix'];
  if (getTunnelSocket(connectHost, pathPrefix)) {
    return next(new Error(`${connectHost} has a existing connection`));
  }
  if (!socket.handshake.auth || !socket.handshake.auth.token){
    next(new Error('Authentication error'));
  }
  jwt.verify(socket.handshake.auth.token, process.env.SECRET_KEY, function(err, decoded) {
    if (err) {
      return next(new Error('Authentication error'));
    }
    if (decoded.token !== process.env.VERIFY_TOKEN) {
      return next(new Error('Authentication error'));
    }
    next();
  });  
});

// Socket.io connection handler
io.on('connection', (socket) => {
  const connectHost = socket.handshake.headers.host;
  const pathPrefix = socket.handshake.headers['path-prefix'];
  const supportsHTTP2 = socket.handshake.headers['supports-http2'] === 'true';
  
  setTunnelSocket(connectHost, pathPrefix, socket);
  console.log(`client connected at ${connectHost}, path prefix: ${pathPrefix}, HTTP/2 support: ${supportsHTTP2}`);
  
  const onMessage = (message) => {
    if (message === 'ping') {
      socket.send('pong');
    }
  }
  
  const onDisconnect = (reason) => {
    console.log('client disconnected: ', reason);
    removeTunnelSocket(connectHost, pathPrefix);
    socket.off('message', onMessage);
  };
  
  socket.on('message', onMessage);
  socket.once('disconnect', onDisconnect);
});

// Express middleware
app.use(morgan('tiny'));

// JWT token generator endpoint
app.get('/tunnel_jwt_generator', (req, res) => {
  if (!process.env.JWT_GENERATOR_USERNAME || !process.env.JWT_GENERATOR_PASSWORD) {
    res.status(404);
    res.send('Not found');
    return;
  }
  if (
    req.query.username === process.env.JWT_GENERATOR_USERNAME &&
    req.query.password === process.env.JWT_GENERATOR_PASSWORD
  ) {
    const jwtToken = jwt.sign({ token: process.env.VERIFY_TOKEN }, process.env.SECRET_KEY);
    res.status(200);
    res.send(jwtToken);
    return;
  }
  res.status(401);
  res.send('Forbidden');
});

// Helper function to get request headers
function getReqHeaders(req) {
  const encrypted = !!(req.socket.encrypted);
  const headers = { ...req.headers };
  const host = headers.host || '';
  const url = new URL(`${encrypted ? 'https' : 'http'}://${host}`);
  const forwardValues = {
    for: req.socket?.remoteAddress,
    port: url.port || (encrypted ? 443 : 80),
    proto: encrypted ? 'https' : 'http',
  };
  ['for', 'port', 'proto'].forEach((key) => {
    const previousValue = req.headers[`x-forwarded-${key}`] || '';
    headers[`x-forwarded-${key}`] =
      `${previousValue || ''}${previousValue ? ',' : ''}${forwardValues[key]}`;
  });
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || host || '';
  return headers;
}

// Main request handler
function handleRequest(req, res) {
  const tunnelSocketObj = getAvailableTunnelSocket(req.headers.host, req.url);
  if (!tunnelSocketObj) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  const tunnelSocket = tunnelSocketObj.socket;
  const requestId = uuidV4();
  
  // Check if this is a gRPC or HTTP/2 request
  const isHttp2 = req.httpVersion === '2.0' || (
    req.headers['content-type'] && 
    req.headers['content-type'].includes('application/grpc')
  );

  // Use appropriate tunnel request/response type based on protocol
  if (isHttp2 && tunnelSocketObj.supportsHTTP2) {
    handleHTTP2Request(req, res, tunnelSocket, requestId);
  } else {
    handleHTTP1Request(req, res, tunnelSocket, requestId);
  }
}

function handleHTTP1Request(req, res, tunnelSocket, requestId) {
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  
  const onReqError = (e) => {
    tunnelRequest.destroy(new Error(e || 'Aborted'));
  }
  
  req.once('aborted', onReqError);
  req.once('error', onReqError);
  req.pipe(tunnelRequest);
  
  req.once('end', () => {
    req.off('aborted', onReqError);
    req.off('error', onReqError);
  });
  
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    res.statusCode = 502;
    res.end('Request error');
  };
  
  const onResponse = ({ statusCode, statusMessage, headers }) => {
    tunnelRequest.off('requestError', onRequestError)
    res.writeHead(statusCode, statusMessage, headers);
  };
  
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
  tunnelResponse.pipe(res);
  
  const onSocketError = () => {
    res.off('close', onResClose);
    res.statusCode = 500;
    res.end();
  };
  
  const onResClose = () => {
    tunnelSocket.off('disconnect', onSocketError);
  };
  
  tunnelSocket.once('disconnect', onSocketError)
  res.once('close', onResClose);
}

function handleHTTP2Request(req, res, tunnelSocket, requestId) {
  const tunnelRequest = new HTTP2TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
      httpVersion: '2.0',
    },
  });
  
  const onReqError = (e) => {
    tunnelRequest.destroy(new Error(e || 'Aborted'));
  }
  
  req.once('aborted', onReqError);
  req.once('error', onReqError);
  req.pipe(tunnelRequest);
  
  req.once('end', () => {
    req.off('aborted', onReqError);
    req.off('error', onReqError);
  });
  
  const tunnelResponse = new HTTP2TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    res.statusCode = 502;
    res.end('Request error');
  };
  
  const onResponse = ({ statusCode, statusMessage, headers }) => {
    tunnelRequest.off('requestError', onRequestError)
    // Set appropriate headers for HTTP/2 responses
    const responseHeaders = { ...headers };
    delete responseHeaders[':status'];
    
    res.writeHead(statusCode, statusMessage, responseHeaders);
  };
  
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
  tunnelResponse.pipe(res);
  
  const onSocketError = () => {
    res.off('close', onResClose);
    res.statusCode = 500;
    res.end();
  };
  
  const onResClose = () => {
    tunnelSocket.off('disconnect', onSocketError);
  };
  
  tunnelSocket.once('disconnect', onSocketError)
  res.once('close', onResClose);
}

// WebSocket handling
function createSocketHttpHeader(line, headers) {
  return Object.keys(headers).reduce(function (head, key) {
    var value = headers[key];

    if (!Array.isArray(value)) {
      head.push(key + ': ' + value);
      return head;
    }

    for (var i = 0; i < value.length; i++) {
      head.push(key + ': ' + value[i]);
    }
    return head;
  }, [line])
  .join('\r\n') + '\r\n\r\n';
}

function handleUpgrade(req, socket, head) {
  if (req.url.indexOf(webTunnelPath) === 0) {
    return;
  }
  
  console.log(`WS ${req.url}`);
  
  // Proxy WebSocket request
  const tunnelSocketObj = getAvailableTunnelSocket(req.headers.host, req.url);
  if (!tunnelSocketObj) {
    socket.destroy();
    return;
  }
  
  const tunnelSocket = tunnelSocketObj.socket;
  
  if (head && head.length) socket.unshift(head);
  const requestId = uuidV4();
  
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  
  req.pipe(tunnelRequest);
  
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    socket.end();
  };
  
  const onResponse = ({ statusCode, statusMessage, headers, httpVersion }) => {
    tunnelResponse.off('requestError', onRequestError);
    if (statusCode) {
      socket.once('error', (err) => {
        console.log(`WS ${req.url} ERROR`);
        console.error(err);
        tunnelResponse.destroy();
      });

      // Create upgrade header
      const head = createSocketHttpHeader(
        `HTTP/${httpVersion || '1.1'} ${statusCode} ${statusMessage || 'OK'}`,
        headers || {}
      );
      socket.write(head);

      if (statusCode !== 101) {
        tunnelResponse.destroy();
        socket.end();
        return;
      }

      socket.pipe(tunnelResponse);
      tunnelResponse.pipe(socket);

      socket.once('end', () => {
        tunnelResponse.end();
      });

      tunnelResponse.once('end', () => {
        socket.end();
      });
    } else {
      tunnelResponse.destroy();
      socket.end();
    }
  };
  
  tunnelResponse.once('requestError', onRequestError);
  tunnelResponse.once('response', onResponse);
}

// For HTTP/1.1 - attach our express app
if (!http2Server) {
  // For plain HTTP/1.1, we need to manually integrate Express
  const originalListen = app.listen;
  app.listen = function() {
    return originalListen.apply(this, arguments);
  };

  // Handle Express routes first, fall back to tunnel handler
  httpServer.on('request', (req, res) => {
    // Check if it's an express route
    const expressRoute = req.url === '/tunnel_jwt_generator';
    
    if (expressRoute) {
      // This is for Express to handle
      app(req, res);
    } else {
      // This is for our tunnel handler
      handleRequest(req, res);
    }
  });
  
  httpServer.on('upgrade', handleUpgrade);
} else {
  // For HTTP/2 server
  http2Server.on('request', (req, res) => {
    // Check if it's an express route
    const expressRoute = req.url === '/tunnel_jwt_generator';
    
    if (expressRoute) {
      // This is for Express to handle
      app(req, res);
    } else {
      // This is for our tunnel handler
      handleRequest(req, res);
    }
  });
  
  // For WebSocket upgrade in HTTP/2
  http2Server.on('upgrade', handleUpgrade);
}

// Start server
const port = process.env.PORT || 3000;
httpServer.listen(port, '0.0.0.0', () => {
  if (http2Server) {
    console.log(`HTTP/2 server listening on port ${port} on all interfaces`);
  } else {
    console.log(`HTTP/1.1 server listening on port ${port} on all interfaces`);
  }
}); 