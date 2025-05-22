# Setting Up gRPC Tunneling

This guide explains how to set up the HTTP tunnel to expose a local gRPC service to the internet.

## Prerequisites

- Node.js 14+ installed
- A gRPC service running locally
- A server with a public IP address or a cloud service like Render.com

## Step 1: Deploy the Server

First, deploy the HTTP/2 compatible server on a machine with a public IP or on a service like Render.com:

### Using Render.com

1. Fork this repository on GitHub
2. Create a new Web Service on Render.com
3. Connect to your GitHub repository
4. Configure the following:
   - Build Command: `npm install`
   - Start Command: `npm run start:http2`
5. Add the following environment variables:
   - `SECRET_KEY`: A random string to sign JWT tokens (e.g., generate with `openssl rand -hex 32`)
   - `VERIFY_TOKEN`: A random string for verification (e.g., generate with `openssl rand -hex 32`)
   - `JWT_GENERATOR_USERNAME`: Username for generating authentication tokens
   - `JWT_GENERATOR_PASSWORD`: Password for generating authentication tokens

### Self-Hosted Server

If you're using your own server:

1. Clone this repository
2. Install dependencies: `npm install`
3. Generate SSL certificates (required for HTTP/2):
```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```
4. Set environment variables:
```bash
export SECRET_KEY=your_secret_key
export VERIFY_TOKEN=your_verify_token
export JWT_GENERATOR_USERNAME=your_auth_username
export JWT_GENERATOR_PASSWORD=your_auth_password
export SSL_KEY_PATH=./key.pem
export SSL_CERT_PATH=./cert.pem
```
5. Start the server: `npm run start:http2`

## Step 2: Set Up the Client

Install necessary dependencies:

```bash
npm install socket.io-client
```

Configure the client environment:

```bash
# Your tunnel server URL (HTTPS) 
export TUNNEL_SERVER_URL=https://your-server-url.com

# Get a JWT token from the server
curl "https://your-server-url.com/tunnel_jwt_generator?username=your_auth_username&password=your_auth_password"

# Set the JWT token and other configuration
export TUNNEL_AUTH_TOKEN=your_jwt_token
export LOCAL_PORT=50051  # Your local gRPC server port
export PATH_PREFIX=/your-service  # Optional path prefix
export DEBUG=true  # Enable detailed logging
```

## Step 3: Start the Client

Start the HTTP/2 client to tunnel your gRPC service:

```bash
node http2client-example.js
```

## Step 4: Connect to Your gRPC Service

Your gRPC service is now available at `https://your-server-url.com/your-service`.

Configure your gRPC client to connect to this URL instead of your local service.

### Example: Node.js gRPC Client

```javascript
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Load your proto file
const packageDefinition = protoLoader.loadSync('your_service.proto');
const serviceProto = grpc.loadPackageDefinition(packageDefinition);

// Connect to tunneled service instead of local
const client = new serviceProto.YourService(
  'your-server-url.com:443', // Use 443 for HTTPS
  grpc.credentials.createSsl() // Use SSL for secure connection
);

// Call your service
client.yourMethod({your: 'request'}, (err, response) => {
  if (err) {
    console.error('Error:', err);
    return;
  }
  console.log('Response:', response);
});
```

## Troubleshooting

### Common Issues

1. **"Error: Parse Error: Expected HTTP/"**
   - Make sure you're using the HTTP/2 server (http2server.js)
   - Ensure SSL certificates are properly configured
   - Check that your client is using the HTTP/2 client example

2. **Connection Refused**
   - Check that your local gRPC server is running and accessible
   - Verify the LOCAL_PORT environment variable matches your gRPC server port

3. **Authentication Errors**
   - Make sure your JWT token is correct and not expired
   - Verify the SECRET_KEY and VERIFY_TOKEN on the server

### Enabling Debug Logs

For more detailed logging, set these environment variables:

```bash
export DEBUG=true
export NODE_DEBUG=http2,http
```

This will provide more information about the HTTP/2 connections and help diagnose issues.

## Advanced Configuration

### Using Path-Based Routing

You can tunnel multiple gRPC services by using different path prefixes:

```bash
# Service 1
export PATH_PREFIX=/service1
node http2client-example.js

# Service 2 (in another terminal)
export PATH_PREFIX=/service2
export LOCAL_PORT=50052
node http2client-example.js
```

### Insecure Mode

If you need to connect to a local gRPC server that uses self-signed certificates:

```bash
export INSECURE=true
```

This will disable SSL certificate validation for the connection to your local server.

## Security Considerations

- Always use HTTPS for your tunnel server
- Rotate your JWT_GENERATOR credentials after initial setup
- Consider implementing IP restrictions on your tunnel server
- Be aware that tunneling introduces additional latency for gRPC calls 