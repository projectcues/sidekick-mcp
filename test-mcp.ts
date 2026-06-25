import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testMcp() {
  console.log("1. Signing up a test user...");
  // Use a random email to ensure we don't conflict on multiple test runs
  const email = `test.user.${Date.now()}@gmail.com`;
  const serviceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBvYmx4dm9ncXlmbHpvb3hnZG13Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjQyMTA2NiwiZXhwIjoyMDk3OTk3MDY2fQ.AxGSv_an_N7vKpSfZthLa52oR24H3d8TcBiHn4umJNE";
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  
  // Create user with email confirmed
  const { data: userData, error: userError } = await adminSupabase.auth.admin.createUser({
    email,
    password: 'TestPassword123!',
    email_confirm: true
  });

  if (userError) {
    console.error("Admin user creation failed:", userError.message);
    process.exit(1);
  }

  // Now sign in to get the session token
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password: 'TestPassword123!',
  });

  if (authError) {
    console.error("Sign in failed:", authError.message);
    process.exit(1);
  }

  const userToken = authData.session?.access_token;
  if (!userToken) {
    console.error("No access token returned. Check if email confirmations are required.");
    // In a new Supabase project, email confirmations are ON by default.
    // If they are on, signUp returns a user but NO session.
    // We may need to use service_role to insert a user, or disable email confirmations.
    console.log("No session found. If email confirmation is required, we can't test automatically without turning it off.");
  }
  
  console.log(`Test user created: ${email}`);

  // Let's spawn the MCP server
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"]
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" }
  );

  await client.connect(transport);
  console.log("2. MCP Client connected.");

  // If we have a token, run the tools
  if (userToken) {
    console.log("3. Testing save_note tool...");
    try {
      const saveResult = await client.callTool({
        name: "save_note",
        arguments: {
          title: "My First Test Note",
          content: "This is the content of the test note. It contains important test data.",
          sourceType: "note",
          userToken: userToken
        }
      });
      console.log("save_note result:", JSON.stringify(saveResult, null, 2));
    } catch (e) {
      console.error("save_note error:", e);
    }

    console.log("4. Testing search_brain tool...");
    try {
      const searchResult = await client.callTool({
        name: "search_brain",
        arguments: {
          query: "First Test Note",
          userToken: userToken
        }
      });
      console.log("search_brain result:", JSON.stringify(searchResult, null, 2));
    } catch (e) {
      console.error("search_brain error:", e);
    }
  }

  console.log("Test complete. Exiting...");
  process.exit(0);
}

testMcp().catch(console.error);
