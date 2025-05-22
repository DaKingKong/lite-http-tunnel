/**
 * HTTP/2 Tunnel Client Example
 * 
 * This example shows how to configure a client that supports tunneling HTTP/2 traffic (including gRPC)
 * through the lite-http-tunnel server.
 */

const http2 = require('http2');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { convertHTTP2HeadersToHTTP1, convertHTTP1HeadersToHTTP2 } = require('./lib2');

// Configuration
const config = {
  // Your tunnel server address
  serverUrl: process.env.TUNNEL_SERVER_URL || 'https://your-tunnel-server.com',
  // Your JWT token for authentication
  authToken: process.env.TUNNEL_AUTH_TOKEN,
  // Local HTTP/2 server port to tunnel
  localPort: process.env.LOCAL_PORT || 8080,
  // Optional path prefix for the tunnel
  pathPrefix: process.env.PATH_PREFIX || '',
  // Local server host
  localHost: process.env.LOCAL_HOST || 'localhost',
  // Debug mode
  debug: process.env.DEBUG === 'true'
};

// Log function that respects debug mode
function log(...args) {
  if (config.debug) {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }
}

// Connect to tunnel server
const socket = io(config.serverUrl, {
  path: '/$web_tunnel',
  auth: {
    token: config.authToken
  },
  extraHeaders: {
    'path-prefix': config.pathPrefix,
    'supports-http2': 'true' // Signal to server that this client supports HTTP/2
  }
});

// Keep track of active requests
const activeRequests = new Map();

// Create HTTP/2 connection to local server
let localClient;

function createLocalClient() {
  log('Creating local HTTP/2 client connection');
  
  // Connect to local server
  localClient = http2.connect(`http://${config.localHost}:${config.localPort}`);
  
  localClient.on('error', (err) => {
    console.error('Local HTTP/2 client error:', err);
    // Try to reconnect after a brief delay
    setTimeout(() => {
      createLocalClient();
    }, 1000);
  });
  
  localClient.on('close', () => {
    log('Local HTTP/2 client connection closed');
    setTimeout(() => {
      createLocalClient();
    }, 1000);
  });
}

// Socket.io event handlers
socket.on('connect', () => {
  console.log('Connected to tunnel server');
  createLocalClient();
});

socket.on('disconnect', () => {
  console.log('Disconnected from tunnel server');
  if (localClient) {
    localClient.close();
  }
});

// Handle HTTP/2 requests from tunnel server
socket.on('http2-request', (requestId, request) => {
  log('Received HTTP/2 request', requestId, request.path);
  
  if (!localClient || localClient.destroyed) {
    socket.emit('http2-request-error', requestId, 'Local HTTP/2 client not connected');
    return;
  }
  
  try {
    // Convert headers to HTTP/2 format
    const headers = convertHTTP1HeadersToHTTP2(request.headers, request.method, request.path);
    
    // Create a new stream for this request
    const stream = localClient.request(headers);
    
    // Store stream in active requests
    activeRequests.set(requestId, stream);
    
    // Handle response headers
    stream.once('response', (headers) => {
      log('Received HTTP/2 response headers for', requestId);
      
      // Convert HTTP/2 headers to HTTP/1.1 for tunneling
      const responseHeaders = convertHTTP2HeadersToHTTP1(headers);
      let statusCode = 200;
      let statusMessage = 'OK';
      
      if (headers[':status']) {
        statusCode = parseInt(headers[':status'], 10);
      }
      
      // Send response headers back through tunnel
      socket.emit('http2-response', requestId, {
        statusCode,
        statusMessage,
        headers: responseHeaders
      });
    });
    
    // Forward response data back through tunnel
    stream.on('data', (chunk) => {
      socket.emit('http2-response-pipe', requestId, chunk);
    });
    
    // Handle end of response
    stream.on('end', () => {
      log('HTTP/2 stream ended for', requestId);
      socket.emit('http2-response-pipe-end', requestId);
      activeRequests.delete(requestId);
    });
    
    // Handle stream errors
    stream.on('error', (err) => {
      console.error('HTTP/2 stream error for', requestId, err);
      socket.emit('http2-response-pipe-error', requestId, err.message);
      activeRequests.delete(requestId);
    });
    
    // For POST, PUT etc. requests, we need to handle request body
    stream.on('wantTrailers', () => {
      log('Stream wants trailers for', requestId);
      // Indicate no trailers are coming
      stream.close();
    });
  } catch (err) {
    console.error('Error creating HTTP/2 request:', err);
    socket.emit('http2-request-error', requestId, err.message);
  }
});

// Handle request data
socket.on('http2-request-pipe', (requestId, chunk) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    log('Writing chunk to stream for', requestId, chunk.length, 'bytes');
    stream.write(chunk);
  }
});

// Handle request data (multiple chunks)
socket.on('http2-request-pipes', (requestId, chunks) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    for (const chunk of chunks) {
      log('Writing chunk to stream for', requestId, chunk.length, 'bytes');
      stream.write(chunk);
    }
  }
});

// Handle end of request
socket.on('http2-request-pipe-end', (requestId) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    log('Ending stream for', requestId);
    stream.end();
  }
});

// Handle request errors
socket.on('http2-request-pipe-error', (requestId, error) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    log('Request error for', requestId, error);
    stream.destroy(new Error(error));
    activeRequests.delete(requestId);
  }
});

// Regular HTTP/1.1 handlers (kept for backward compatibility)
socket.on('request', (requestId, request) => {
  log('Received HTTP/1.1 request', requestId, request.path);
  
  if (!localClient || localClient.destroyed) {
    socket.emit('request-error', requestId, 'Local HTTP/2 client not connected');
    return;
  }
  
  try {
    // Convert headers to HTTP/2 format
    const headers = convertHTTP1HeadersToHTTP2(request.headers, request.method, request.path);
    
    // Create a new stream for this request
    const stream = localClient.request(headers);
    
    // Store stream in active requests
    activeRequests.set(requestId, stream);
    
    // Handle response headers
    stream.once('response', (headers) => {
      log('Received HTTP/2 response headers for HTTP/1.1 request', requestId);
      
      // Convert HTTP/2 headers to HTTP/1.1 for tunneling
      const responseHeaders = convertHTTP2HeadersToHTTP1(headers);
      let statusCode = 200;
      let statusMessage = 'OK';
      
      if (headers[':status']) {
        statusCode = parseInt(headers[':status'], 10);
      }
      
      // Send response headers back through tunnel
      socket.emit('response', requestId, {
        statusCode,
        statusMessage,
        headers: responseHeaders
      });
    });
    
    // Forward response data back through tunnel
    stream.on('data', (chunk) => {
      socket.emit('response-pipe', requestId, chunk);
    });
    
    // Handle end of response
    stream.on('end', () => {
      log('HTTP/2 stream ended for HTTP/1.1 request', requestId);
      socket.emit('response-pipe-end', requestId);
      activeRequests.delete(requestId);
    });
    
    // Handle stream errors
    stream.on('error', (err) => {
      console.error('HTTP/2 stream error for HTTP/1.1 request', requestId, err);
      socket.emit('response-pipe-error', requestId, err.message);
      activeRequests.delete(requestId);
    });
  } catch (err) {
    console.error('Error creating HTTP/2 request for HTTP/1.1 request:', err);
    socket.emit('request-error', requestId, err.message);
  }
});

// Handle request data for HTTP/1.1
socket.on('request-pipe', (requestId, chunk) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    stream.write(chunk);
  }
});

socket.on('request-pipes', (requestId, chunks) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    for (const chunk of chunks) {
      stream.write(chunk);
    }
  }
});

socket.on('request-pipe-end', (requestId) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    stream.end();
  }
});

socket.on('request-pipe-error', (requestId, error) => {
  const stream = activeRequests.get(requestId);
  if (stream) {
    stream.destroy(new Error(error));
    activeRequests.delete(requestId);
  }
});

// Cleanup function to be called before exit
function cleanup() {
  console.log('Cleaning up...');
  
  if (localClient) {
    localClient.close();
  }
  
  socket.disconnect();
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('Received SIGINT signal');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal');
  cleanup();
  process.exit(0);
});

console.log(`HTTP/2 tunnel client started for ${config.localHost}:${config.localPort}`);
if (config.pathPrefix) {
  console.log(`Path prefix: ${config.pathPrefix}`);
} 