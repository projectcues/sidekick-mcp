import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// The server expects Pickaxe to pass a valid Supabase Auth Token via the tool arguments
// Or it could accept a session token in a custom header if running over HTTP.
// Since MCP typically runs via Stdio or SSE, we'll require the token in the tool arguments for isolation.
// Alternatively, if this server runs securely behind an API, the token could be provided in environment variables per execution.

const server = new Server(
  {
    name: 'sidekick-mcp',
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
            query: { type: 'string', description: 'The search query or embedding string.' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['query', 'userToken'],
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
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['title', 'content', 'sourceType', 'userToken'],
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

  // Initialize Supabase Client with the user's JWT
  // This ensures Row Level Security (RLS) is applied automatically
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${args.userToken}`,
      },
    },
  });

  if (name === 'search_brain') {
    // In a real implementation, you would convert args.query to an embedding here using OpenAI or similar.
    // For this boilerplate, we'll assume a direct text search using Postgres Full-Text Search
    // or a placeholder for the vector search function `match_document_chunks`
    
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .textSearch('title', args.query as string);

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === 'save_note') {
    const { title, content, sourceType } = args;

    // First insert the document
    const { data: docData, error: docError } = await supabase
      .from('documents')
      .insert({
        title,
        source_type: sourceType,
      })
      .select('id')
      .single();

    if (docError) {
      throw new Error(`Failed to save document: ${docError.message}`);
    }

    // Then insert the chunk (in a real app, you'd generate the embedding here first)
    const { error: chunkError } = await supabase
      .from('document_chunks')
      .insert({
        document_id: docData.id,
        content,
        chunk_index: 0,
      });

    if (chunkError) {
      throw new Error(`Failed to save document chunk: ${chunkError.message}`);
    }

    return {
      content: [{ type: 'text', text: `Successfully saved "${title}" to Sidekick.` }],
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sidekick MCP Server running on stdio');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
