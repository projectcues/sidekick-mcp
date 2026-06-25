-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Documents Table: High-level logical grouping
create table if not exists public.documents (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null,
    source_type text not null, -- 'pdf', 'notion', 'web', 'note'
    source_url text,           -- original URL if applicable
    metadata jsonb default '{}'::jsonb, -- dynamic tags, etc.
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS for documents
alter table public.documents enable row level security;

create policy "Users can only view their own documents"
on public.documents for select
using (auth.uid() = user_id);

create policy "Users can only insert their own documents"
on public.documents for insert
with check (auth.uid() = user_id);

create policy "Users can only update their own documents"
on public.documents for update
using (auth.uid() = user_id);

create policy "Users can only delete their own documents"
on public.documents for delete
using (auth.uid() = user_id);

-- Document Chunks Table: Stores chunked content with embeddings
create table if not exists public.document_chunks (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade, -- Denormalized for security
    content text not null,     -- The raw text content of the chunk
    embedding vector(1536),    -- Assuming OpenAI ada-002 model sizes
    chunk_index integer not null, -- Sequential order of the chunk
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create HNSW index for fast similarity search
create index on public.document_chunks using hnsw (embedding vector_cosine_ops);

-- Create GIN index for metadata filtering on documents
create index on public.documents using gin (metadata);

-- RLS for document_chunks
alter table public.document_chunks enable row level security;

create policy "Users can only view their own chunks"
on public.document_chunks for select
using (auth.uid() = user_id);

create policy "Users can only insert their own chunks"
on public.document_chunks for insert
with check (auth.uid() = user_id);

create policy "Users can only update their own chunks"
on public.document_chunks for update
using (auth.uid() = user_id);

create policy "Users can only delete their own chunks"
on public.document_chunks for delete
using (auth.uid() = user_id);

-- Function to match documents based on vector similarity and user isolation
create or replace function public.match_document_chunks (
  query_embedding vector(1536),
  match_count int default 10,
  filter jsonb default '{}'::jsonb
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where dc.user_id = auth.uid() -- Strict user isolation
    and d.metadata @> filter    -- Metadata filtering
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$;
