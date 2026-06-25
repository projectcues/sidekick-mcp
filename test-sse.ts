import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function testConnection() {
  console.log('Connecting to local SSE MCP server...');
  
  // Connect to the local server
  const transport = new SSEClientTransport(new URL('http://localhost:3000/sse'));
  
  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    await client.connect(transport);
    console.log('✅ Successfully connected to MCP server via SSE!');

    console.log('Fetching available tools...');
    const tools = await client.listTools();
    
    console.log('✅ Tools retrieved:');
    tools.tools.forEach(tool => {
      console.log(` - ${tool.name}: ${tool.description}`);
    });

    console.log('Test complete. Server is fully operational and speaking SSE.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Connection failed:', error);
    process.exit(1);
  }
}

testConnection();
