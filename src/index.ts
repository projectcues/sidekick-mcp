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
      {
        name: 'add_contact',
        description: 'Add a new lead or contact to the CRM.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            company: { type: 'string' },
            notes: { type: 'string' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['name', 'userToken'],
        },
      },
      {
        name: 'get_contact_history',
        description: 'Retrieve a contact and all their past interactions.',
        inputSchema: {
          type: 'object',
          properties: {
            contact_id: { type: 'string' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['contact_id', 'userToken'],
        },
      },
      {
        name: 'update_contact_status',
        description: 'Update the status of a contact (e.g. Lead, Active, Churned).',
        inputSchema: {
          type: 'object',
          properties: {
            contact_id: { type: 'string' },
            status: { type: 'string' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['contact_id', 'status', 'userToken'],
        },
      },
      {
        name: 'log_interaction',
        description: 'Log an email, call, or note to a contact.',
        inputSchema: {
          type: 'object',
          properties: {
            contact_id: { type: 'string' },
            type: { type: 'string', enum: ['email', 'call', 'note'] },
            summary: { type: 'string' },
            userToken: { type: 'string', description: 'The Supabase JWT access token for the user.' },
          },
          required: ['contact_id', 'type', 'summary', 'userToken'],
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

  if (name === 'add_contact') {
    const { name: contactName, email, phone, company, notes } = args;
    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);

    const { data, error } = await supabase
      .from('contacts')
      .insert({ user_id: user.id, name: contactName, email, phone, company, notes })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to add contact: ${error.message}`);
    return { content: [{ type: 'text', text: `Successfully added contact. ID: ${data.id}` }] };
  }

  if (name === 'get_contact_history') {
    const { contact_id } = args;
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError) throw new Error(`Failed to retrieve contact: ${contactError.message}`);

    const { data: interactions, error: interactionsError } = await supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', contact_id)
      .order('created_at', { ascending: false });

    if (interactionsError) throw new Error(`Failed to retrieve interactions: ${interactionsError.message}`);

    return {
      content: [{ type: 'text', text: JSON.stringify({ contact, interactions }, null, 2) }],
    };
  }

  if (name === 'update_contact_status') {
    const { contact_id, status } = args;
    const { error } = await supabase
      .from('contacts')
      .update({ status })
      .eq('id', contact_id);

    if (error) throw new Error(`Failed to update status: ${error.message}`);
    return { content: [{ type: 'text', text: `Status updated to ${status}` }] };
  }

  if (name === 'log_interaction') {
    const { contact_id, type, summary } = args;
    const { data: { user }, error: userAuthError } = await supabase.auth.getUser();
    if (userAuthError || !user) throw new Error(`Unauthorized: ${userAuthError?.message || 'User not found'}`);

    const { error } = await supabase
      .from('interactions')
      .insert({ user_id: user.id, contact_id, type, summary });

    if (error) throw new Error(`Failed to log interaction: ${error.message}`);
    return { content: [{ type: 'text', text: `Successfully logged ${type} interaction.` }] };
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

// Webhook endpoint for proactive automation (replacing Zapier)
// Note: we use express.json() only for this route to avoid conflicting with the MCP SDK
app.post('/webhook/inbound', express.json(), async (req, res) => {
  console.log('Received inbound webhook:', req.body);
  
  // In a full implementation, you would:
  // 1. Verify the webhook signature (e.g. from SendGrid/Postmark)
  // 2. Identify the user based on the destination email
  // 3. Make an API call to Pickaxe to trigger the Agent silently in the background.
  
  // Respond immediately so the external service doesn't timeout
  res.status(200).json({ status: 'received', message: 'Agent triggered' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Sidekicks MCP Server listening for HTTP SSE connections on port ${port}`);
});
