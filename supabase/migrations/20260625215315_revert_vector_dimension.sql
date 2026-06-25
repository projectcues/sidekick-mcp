-- 1. Delete existing 384-dimensional data to prevent cast errors
delete from public.document_chunks;

-- 2. Drop the existing HNSW index
drop index if exists public.document_chunks_embedding_idx;

-- 3. Alter the embedding column from 384 back to 1536 dimensions
alter table public.document_chunks alter column embedding type vector(1536);

-- 4. Recreate the HNSW index
create index on public.document_chunks using hnsw (embedding vector_cosine_ops);

-- 5. Update the match_document_chunks function to accept vector(1536)
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
