-- FEVERIS retrieval corpus schema (Supabase / Postgres + pgvector).
--
-- Derived from how the code uses the database, not from prose:
--   * scripts/embedAndStore.ts  upserts rows into  feveris_cases
--       (onConflict: "patient_uid", ignoreDuplicates: true) with columns
--       patient_uid, pmid, title, age_text, gender_text, document, diagnosis,
--       presenting_complaint, source, embedding   (embedding = 384 floats,
--       Xenova/all-MiniLM-L6-v2, mean-pooled, L2-normalised).
--   * lib/supabase.ts  calls  rpc("match_feveris_cases",
--       { query_embedding, match_threshold, match_count })  and reads back
--       patient_uid, pmid, title, age_text, gender_text, document, diagnosis,
--       presenting_complaint, source, similarity.
--   * lib/supabase.ts uses the ANON key at runtime (read-only via the RPC);
--     scripts/embedAndStore.ts uses the SERVICE ROLE key (inserts).
--
-- NOT derivable from code (chosen here, copied from the original setup guide):
--   HNSW parameters m=16 / ef_construction=64, the surrogate `id`/`created_at`
--   columns, and the RLS policy. This file has not been diffed against the
--   live database the paper's numbers were produced on.
--
-- Run the whole file once in Supabase Dashboard -> SQL Editor.

create extension if not exists vector;

create table if not exists feveris_cases (
  id                   bigint primary key generated always as identity,
  patient_uid          text not null unique,
  pmid                 text not null default '',
  title                text not null default '',
  age_text             text not null default '',
  gender_text          text not null default '',
  document             text not null,                       -- the retrieval_text that was embedded
  diagnosis            text not null default '',            -- regex-extracted, often empty (see scripts/extractDiagnosis.ts)
  presenting_complaint text not null default '',
  source               text not null default 'PMC-Patients-V2',
  embedding            vector(384) not null,
  created_at           timestamptz not null default now()
);

-- Approximate nearest-neighbour index, cosine distance (matches the <=> operator below).
create index if not exists feveris_cases_embedding_idx
  on feveris_cases
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- PostgREST cannot call pgvector operators directly, hence the RPC.
-- lib/supabase.ts: retrieveTopCasesForAssessment() -> k = 3, threshold = 0.4;
-- retrieveSimilarCases() defaults -> k = 5, threshold = 0.3.
create or replace function match_feveris_cases(
  query_embedding  vector(384),
  match_threshold  float default 0.3,
  match_count      int   default 5
)
returns table (
  patient_uid          text,
  pmid                 text,
  title                text,
  age_text             text,
  gender_text          text,
  document             text,
  diagnosis            text,
  presenting_complaint text,
  source               text,
  similarity           float
)
language sql stable as $$
  select
    patient_uid, pmid, title, age_text, gender_text,
    document, diagnosis, presenting_complaint, source,
    1 - (embedding <=> query_embedding) as similarity
  from feveris_cases
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Access: anon may read (runtime retrieval); only service_role inserts (service_role bypasses RLS).
alter table feveris_cases enable row level security;
drop policy if exists feveris_cases_read on feveris_cases;
create policy feveris_cases_read on feveris_cases for select to anon, authenticated using (true);

grant select on feveris_cases to anon, authenticated;
grant insert, delete on feveris_cases to service_role;
grant execute on function match_feveris_cases to anon, authenticated, service_role;
