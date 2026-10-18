# FEVERIS

> ## Research prototype, not for clinical use
> FEVERIS is an academic research prototype. It has **not** been validated on real patients, is **not** a medical device, and must **not** be used to diagnose, treat, or make decisions about any real person. Its outputs can be wrong, sometimes with great confidence. All evaluation here uses short, author-written, synthetic case scripts.

**FEVERIS** (Febrile Evidence-based Voice Enhanced Reasoning and Inference System) is a voice-enabled decision-support prototype for febrile illness. A clinician describes a patient turn by turn (typed or spoken); the system asks follow-up questions and, on request or after enough turns, produces a ranked three-item differential diagnosis grounded in similar published case reports.

## Architecture

1. **Next.js app** (`app/consultation`) hosts a chat UI with an optional voice mode (Deepgram `nova-2-medical` streaming STT in the browser; Deepgram Aura or ElevenLabs TTS via `/api/tts`).
2. **`/api/chat`** drives a small state machine (`lib/agent.ts`) and calls Claude (`claude-sonnet-4-6`, temperature 0.3, system prompt in `lib/claude.ts`).
3. **BioNER** (`d4data/biomedical-ner-all` on HuggingFace hosted inference, `lib/bioner.ts`) extracts symptoms/exposures with negation handling and builds a retrieval query.
4. **Retrieval** embeds the query with `Xenova/all-MiniLM-L6-v2` (384-d) and calls a Supabase pgvector RPC (`schema.sql`) for the top-3 cases with cosine similarity > 0.4.
5. The retrieved cases are injected into the assessment prompt; Claude returns the structured `---FEVERIS ASSESSMENT---` block.

## Prerequisites

- Node.js 20+ and npm
- Accounts/keys: Anthropic, HuggingFace (read token), Supabase (free tier is enough), Deepgram (voice only), ElevenLabs (optional)
- ~1–2 GB free disk and several hours for rebuilding the corpus (the embedding step runs on CPU)

## Setup

```bash
npm ci
cp .env.example .env.local      # then fill in real values; every variable is documented inside
# In the Supabase SQL Editor, run schema.sql once.
# Rebuild and load the corpus (next section), then:
npm run dev                     # http://localhost:3000
```

## Rebuilding the corpus (data are NOT included)

The retrieval corpus is derived from **PMC-Patients-V2** (Zhao et al.), which is distributed under **CC BY-NC-SA 4.0** (non-commercial, share-alike, attribution). Because that does not clearly permit redistributing it inside this repository, neither the raw dataset nor the processed chunks are included. Rebuild them yourself from the public dataset:

1. Download `PMC-Patients-V2.json` from <https://huggingface.co/datasets/zhengyun21/PMC-Patients-V2> (free HuggingFace account may be required) to `data/raw/PMC-Patients-V2.json` (~840 MB).
2. `npm run corpus:filter` keeps the first 3,000+ records (file order; in our run 3,004) whose text is ≥ 200 characters and contains any of the **26 febrile keyword filters** listed in `scripts/filterPmc.ts`, and writes `data/raw/febrile_cases.json`.
3. `npm run corpus:chunk` builds one retrieval chunk per filtered case (age/sex, first two sentences, first 1,000 characters of narrative, regex-extracted diagnosis), and writes `data/processed/case_chunks.json`.
4. `npm run corpus:embed` embeds every chunk with all-MiniLM-L6-v2 and upserts into Supabase (`SUPABASE_SERVICE_ROLE_KEY` required; resumable).

Cite PMC-Patients if you use the data: Zhao et al., *Scientific Data* 10, 909 (2023).

## Running the evaluation

```bash
npm run dev                      # terminal 1 (needs corpus loaded + all keys)
npm run eval                     # terminal 2: all 20 cases in evaluation/testCases.json
npx tsx evaluation/runEval.ts --case=TC001 --verbose   # single case with transcript
```

Metrics are printed by `evaluation/runEval.ts`: Top-1 as the script labels it (expected string appears anywhere in the assessment text, case-insensitive), Top-3 (expected string appears in one of the three parsed differential names), Test Mentioned, Format OK, retrieval relevance, latency. Run logs are written to `evaluation/results/` (git-ignored). Note that the script's "Top-1" is a whole-text check (95% in our run). The paper's Top-1 is the first-differential figure (85%), produced from a saved run log by `npx tsx evaluation/rescore.ts`.

**Expected cost and runtime (estimate):** the logged run took ~15.5 minutes wall-clock (20 cases, 120 measured Claude calls, mean 5.5 s per call) because cases run sequentially. Token usage was not logged. Assuming ~10k input and ~2k output tokens per case at Sonnet-class pricing, this is on the order of **$1–2 per 20-case run**. This is an estimate and was not measured. BioNER and Supabase usage fit free tiers. Runs are not deterministic (temperature 0.3).

## Known limitations

These come from what the code and logs show.

- **Scripted, synthetic test set.** 20 author-written cases, one per disease (two sepsis), five scripted clinician turns each. These are not real patients, and the cases were not written independently of the system's design.
- **Retrieval adds little measurable value so far.** Retrieved cases were exact-match relevant in only 3 of 60 slots in the last run, and many corpus records have an empty or noisy regex-extracted diagnosis field. There is no no-retrieval ablation in this repo yet.
- **Corpus is a biased sample.** It is the first ~3,000 keyword-matching records in file order, with no random or stratified sampling.
- **Possible label leakage.** In four cases (TC001, TC003, TC004, TC008) the scripted history itself names the target disease (e.g. "no prior malaria", "unvaccinated for yellow fever"). BioNER's "Conditions" slot feeds the retrieval query.
- **Weak negation and entity handling.** Negation is a 45-character window regex. BioNER fragments some terms, and the exposure-context slot admits noise words.
- **Latency.** Two figures are reported. Mean generation latency (5.5 s per call) times only the Claude API call. End-to-end case time (about 35–45 s for a scripted five-turn conversation) also includes BioNER, retrieval, and request overhead. Neither figure includes speech recognition or synthesis, because the evaluation harness sends typed text.
- **Voice path.** It was checked with unit-level tests of the reconnect and sentence logic, plus the author's own end-to-end trials with a real microphone and network. It has not been tested with other users or devices. The browser Deepgram key is exposed client-side in this prototype.
- **Single model, single run.** No confidence intervals, no repeated runs, no comparison against other LLMs or clinicians.

## License

Code: MIT (see `LICENSE`). Data derived from PMC-Patients-V2 are CC BY-NC-SA 4.0 and are not included.