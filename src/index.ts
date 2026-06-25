import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

const server = new Server(
  {
    name: 'sidekicks-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_brain',
        description: "Search the user's Second Brain for relevant notes and documents.",
        inputSchema: {
          type: 'object',
          properties: {
            query_embedding: { 
              type: 'array', 
              items: { type: 'number' },
              description: 'The 1536-dimensional vector embedding of the search query.' 
            },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['query_embedding', 'userToken'],
        },
      },
      {
        name: 'save_note',
        description: "Save a quick note or document to the user's Second Brain.",
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            sourceType: { type: 'string', enum: ['note', 'web', 'pdf', 'notion'] },
            embedding: { 
              type: 'array', 
              items: { type: 'number' },
              description: 'The 1536-dimensional vector embedding of the content.' 
            },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['title', 'content', 'sourceType', 'embedding', 'userToken'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args || typeof args.userToken !== 'string') {
    throw new Error('userToken is required for all operations.');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${args.userToken}`,
      },
    },
  });

  if (name === 'search_brain') {
    const query_embedding = args.query_embedding as number[];
    if (!Array.isArray(query_embedding)) {
      throw new Error('query_embedding must be an array of numbers.');
    }

    const { data, error } = await supabase.rpc('match_document_chunks', {
      query_embedding,
      match_count: 5,
    });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === 'save_note') {
    const { title, content, sourceType } = args;
    const embedding = args.embedding as number[];

    if (!Array.isArray(embedding)) {
      throw new Error('embedding must be an array of numbers.');
    }

    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) {
      throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);
    }

    const { data: docData, error: docError } = await supabase
      .from('documents')
      .insert({
        user_id: user.id,
        title,
        source_type: sourceType,
      })
      .select('id')
      .single();

    if (docError) {
      throw new Error(`Failed to save document: ${docError.message}`);
    }

    const { error: chunkError } = await supabase
      .from('document_chunks')
      .insert({
        document_id: docData.id,
        user_id: user.id,
        content,
        embedding,
        chunk_index: 0,
      });

    if (chunkError) {
      throw new Error(`Failed to save document chunk: ${chunkError.message}`);
    }

    return {
      content: [{ type: 'text', text: `Successfully saved "${title}" to Sidekicks.` }],
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

const app = express();

const transports = new Map<string, SSEServerTransport>();

// Endpoint for Pickaxe to initiate the SSE connection
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  transports.set(transport.sessionId, transport);
  
  res.on('close', () => {
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// Endpoint for Pickaxe to send tool execution POST requests
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    res.status(404).send('Session not found');
    return;
  }
  
  await transport.handlePostMessage(req, res);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Sidekicks MCP Server listening for HTTP SSE connections on port ${port}`);
});
