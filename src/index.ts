import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';

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
            query: { type: 'string', description: 'The search query.' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
            openAiApiKey: { type: 'string', description: 'The OpenAI API key to use for generating embeddings.' },
          },
          required: ['query', 'userToken', 'openAiApiKey'],
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
            openAiApiKey: { type: 'string', description: 'The OpenAI API key to use for generating embeddings.' },
          },
          required: ['title', 'content', 'sourceType', 'userToken', 'openAiApiKey'],
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
            openAiApiKey: { type: 'string', description: 'The OpenAI API key to use for generating embeddings.' },
          },
          required: ['documentUrl', 'userToken', 'openAiApiKey'],
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

  if (typeof args.openAiApiKey !== 'string') {
    throw new Error('openAiApiKey is required for AI vector operations.');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${args.userToken}`,
      },
    },
  });

  const openai = new OpenAI({ apiKey: args.openAiApiKey });

  if (name === 'search_brain') {
    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: args.query as string,
    });
    const query_embedding = embedRes.data[0].embedding;

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

    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: content as string,
    });
    const embedding = embedRes.data[0].embedding;

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

  if (name === 'ingest_google_doc') {
    const { documentUrl } = args;

    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) {
      throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);
    }

    const docIdMatch = (documentUrl as string).match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    if (!docIdMatch) {
      throw new Error('Invalid Google Doc URL.');
    }
    const docId = docIdMatch[1];
    
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await fetch(exportUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google Doc. Make sure it is set to 'Anyone with the link can view'. HTTP ${response.status}`);
    }
    const text = await response.text();

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
