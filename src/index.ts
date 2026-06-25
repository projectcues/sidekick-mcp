import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';

const openai = new OpenAI({ apiKey: openaiApiKey });

// The server expects Pickaxe to pass a valid Supabase Auth Token via the tool arguments
// Or it could accept a session token in a custom header if running over HTTP.
// Since MCP typically runs via Stdio or SSE, we'll require the token in the tool arguments for isolation.
// Alternatively, if this server runs securely behind an API, the token could be provided in environment variables per execution.

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
      {
        name: 'ingest_google_doc',
        description: "Ingest a public Google Doc URL into the user's Second Brain by chunking and vectorizing the text.",
        inputSchema: {
          type: 'object',
          properties: {
            documentUrl: { type: 'string', description: 'The public Google Doc URL.' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['documentUrl', 'userToken'],
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
      .textSearch('title', args.query as string, { type: 'websearch' });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === 'save_note') {
    const { title, content, sourceType } = args;

    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) {
      throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);
    }

    // First insert the document
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

    // Then insert the chunk (in a real app, you'd generate the embedding here first)
    const { error: chunkError } = await supabase
      .from('document_chunks')
      .insert({
        document_id: docData.id,
        user_id: user.id,
        content,
        chunk_index: 0,
      });

    if (chunkError) {
      throw new Error(`Failed to save document chunk: ${chunkError.message}`);
    }

    return {
      content: [{ type: 'text', text: `Successfully saved "${title}" to Sidekicks.` }],
    };
  }

  if (name === 'ingest_google_doc') {
    const { documentUrl } = args;

    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) {
      throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);
    }

    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured on the server.');
    }

    // 1. Extract Doc ID and Fetch Text
    const docIdMatch = (documentUrl as string).match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    if (!docIdMatch) {
      throw new Error('Invalid Google Doc URL.');
    }
    const docId = docIdMatch[1];
    
    // Attempt to fetch public text
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await fetch(exportUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google Doc. Make sure it is set to 'Anyone with the link can view'. HTTP ${response.status}`);
    }
    const text = await response.text();

    // 2. Insert the parent document
    const { data: docData, error: docError } = await supabase
      .from('documents')
      .insert({
        user_id: user.id,
        title: `Google Doc: ${docId}`,
        source_type: 'google_doc',
        source_url: documentUrl as string,
      })
      .select('id')
      .single();

    if (docError) {
      throw new Error(`Failed to save document record: ${docError.message}`);
    }

    // 3. Chunk the text (simple paragraph-based chunking ~1000 characters)
    const paragraphs = text.split(/\n\s*\n/);
    const chunks: string[] = [];
    let currentChunk = '';
    
    for (const p of paragraphs) {
      if (currentChunk.length + p.length > 1000 && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      currentChunk += p + '\n\n';
    }
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    // 4. Generate Embeddings & Insert
    let insertedChunks = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      if (!chunkText) continue;

      const embedRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunkText,
      });
      const embedding = embedRes.data[0].embedding;

      const { error: chunkError } = await supabase
        .from('document_chunks')
        .insert({
          document_id: docData.id,
          user_id: user.id,
          content: chunkText,
          embedding,
          chunk_index: i,
        });

      if (chunkError) {
        throw new Error(`Failed to save document chunk ${i}: ${chunkError.message}`);
      }
      insertedChunks++;
    }

    return {
      content: [{ type: 'text', text: `Successfully ingested Google Doc. Created ${insertedChunks} vectorized chunks.` }],
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sidekicks MCP Server running on stdio');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
