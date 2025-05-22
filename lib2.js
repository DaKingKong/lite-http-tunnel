const { Writable, Duplex } = require('stream');
const { TunnelRequest, TunnelResponse } = require('./lib');

// HTTP/2 version of TunnelRequest that handles HTTP/2 frames
class HTTP2TunnelRequest extends TunnelRequest {
  constructor({ socket, requestId, request }) {
    super({ socket, requestId, request });
    
    // Mark this as HTTP/2 request
    this._socket.emit('http2-request', requestId, request);
  }

  _write(chunk, encoding, callback) {
    this._socket.emit('http2-request-pipe', this._requestId, chunk);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _writev(chunks, callback) {
    this._socket.emit('http2-request-pipes', this._requestId, chunks);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _final(callback) {
    this._socket.emit('http2-request-pipe-end', this._requestId);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _destroy(e, callback) {
    if (e) {
      this._socket.emit('http2-request-pipe-error', this._requestId, e && e.message);
      this._socket.conn.once('drain', () => {
        callback();
      });
      return;
    }
    callback();
  }
}

// HTTP/2 version of TunnelResponse that handles HTTP/2 frames
class HTTP2TunnelResponse extends Duplex {
  constructor({ socket, responseId }) {
    super();
    this._socket = socket;
    this._responseId = responseId;
    this._trailers = null;
    
    const onResponse = (responseId, data) => {
      if (this._responseId === responseId) {
        this._socket.off('http2-response', onResponse);
        this._socket.off('http2-request-error', onRequestError);
        this.emit('response', {
          statusCode: data.statusCode,
          statusMessage: data.statusMessage,
          headers: data.headers,
          httpVersion: '2.0',
        });
      }
    }
    
    const onResponsePipe = (responseId, data) => {
      if (this._responseId === responseId) {
        this.push(data);
      }
    };
    
    const onResponsePipes = (responseId, data) => {
      if (this._responseId === responseId) {
        data.forEach((chunk) => {
          this.push(chunk);
        });
      }
    };
    
    const onResponsePipeError = (responseId, error) => {
      if (this._responseId !== responseId) {
        return;
      }
      this._socket.off('http2-response-pipe', onResponsePipe);
      this._socket.off('http2-response-pipes', onResponsePipes);
      this._socket.off('http2-response-pipe-error', onResponsePipeError);
      this._socket.off('http2-response-pipe-end', onResponsePipeEnd);
      this._socket.off('http2-response-trailers', onResponseTrailers);
      this.destroy(new Error(error));
    };
    
    const onResponsePipeEnd = (responseId, data) => {
      if (this._responseId !== responseId) {
        return;
      }
      if (data) {
        this.push(data);
      }
      
      // If we have trailers, emit them as an event
      if (this._trailers) {
        this.emit('trailers', this._trailers);
      }
      
      this._socket.off('http2-response-pipe', onResponsePipe);
      this._socket.off('http2-response-pipes', onResponsePipes);
      this._socket.off('http2-response-pipe-error', onResponsePipeError);
      this._socket.off('http2-response-pipe-end', onResponsePipeEnd);
      this._socket.off('http2-response-trailers', onResponseTrailers);
      this.push(null);
    };
    
    const onResponseTrailers = (responseId, trailers) => {
      if (this._responseId === responseId) {
        // Store trailers to emit when the stream ends
        this._trailers = trailers;
      }
    };
    
    const onRequestError = (requestId, error) => {
      if (requestId === this._responseId) {
        this._socket.off('http2-request-error', onRequestError);
        this._socket.off('http2-response', onResponse);
        this._socket.off('http2-response-pipe', onResponsePipe);
        this._socket.off('http2-response-pipes', onResponsePipes);
        this._socket.off('http2-response-pipe-error', onResponsePipeError);
        this._socket.off('http2-response-pipe-end', onResponsePipeEnd);
        this._socket.off('http2-response-trailers', onResponseTrailers);
        this.emit('requestError', error);
      }
    };
    
    this._socket.on('http2-response', onResponse);
    this._socket.on('http2-response-pipe', onResponsePipe);
    this._socket.on('http2-response-pipes', onResponsePipes);
    this._socket.on('http2-response-pipe-error', onResponsePipeError);
    this._socket.on('http2-response-pipe-end', onResponsePipeEnd);
    this._socket.on('http2-response-trailers', onResponseTrailers);
    this._socket.on('http2-request-error', onRequestError);
  }

  _read(size) {}

  _write(chunk, encoding, callback) {
    this._socket.emit('http2-response-pipe', this._responseId, chunk);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _writev(chunks, callback) {
    this._socket.emit('http2-response-pipes', this._responseId, chunks);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _final(callback) {
    this._socket.emit('http2-response-pipe-end', this._responseId);
    this._socket.conn.once('drain', () => {
      callback();
    });
  }

  _destroy(e, callback) {
    if (e) {
      this._socket.emit('http2-response-pipe-error', this._responseId, e && e.message);
      this._socket.conn.once('drain', () => {
        callback();
      });
      return;
    }
    callback();
  }
}

// Helper function to convert HTTP/2 pseudo-headers to HTTP/1.1 style
function convertHTTP2HeadersToHTTP1(headers) {
  const result = { ...headers };
  if (result[':method']) {
    result.method = result[':method'];
    delete result[':method'];
  }
  if (result[':path']) {
    result.path = result[':path'];
    delete result[':path'];
  }
  if (result[':authority']) {
    result.host = result[':authority'];
    delete result[':authority'];
  }
  if (result[':scheme']) {
    result.scheme = result[':scheme'];
    delete result[':scheme'];
  }
  if (result[':status']) {
    result.status = result[':status'];
    delete result[':status'];
  }
  return result;
}

// Helper function to convert HTTP/1.1 headers to HTTP/2 style
function convertHTTP1HeadersToHTTP2(headers, method, path) {
  const result = { ...headers };
  
  // Add HTTP/2 pseudo-headers
  if (method) {
    result[':method'] = method;
  }
  
  if (path) {
    result[':path'] = path;
  }
  
  if (headers.host) {
    result[':authority'] = headers.host;
  }
  
  // Default to https scheme for HTTP/2
  result[':scheme'] = 'https';
  
  // Special handling for gRPC - ensure content-type is properly set
  if (headers['content-type'] && headers['content-type'].includes('application/grpc')) {
    // Make sure content-type is preserved exactly
    result['content-type'] = headers['content-type'];
    
    // Add TE:trailers header which is required for gRPC
    result['te'] = 'trailers';
  }
  
  return result;
}

// Check if request headers indicate gRPC
function isGrpcRequest(headers) {
  return headers && 
    (headers['content-type']?.includes('application/grpc') || 
     headers['grpc-encoding'] || 
     headers['grpc-accept-encoding']);
}

module.exports = {
  TunnelRequest,
  TunnelResponse,
  HTTP2TunnelRequest,
  HTTP2TunnelResponse,
  convertHTTP2HeadersToHTTP1,
  convertHTTP1HeadersToHTTP2,
  isGrpcRequest
}; 