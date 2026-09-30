// scripts/extractDiagnosis.ts
// Pure, side-effect-free diagnosis-extraction helper shared by
// scripts/chunkCases.ts (production, capped at 1,500) and
// scripts/chunkCasesFullPool.ts (experiment/full-pool variant) — kept in
// its own module specifically so it can be imported without also triggering
// either script's top-level IIFE (which reads/writes real files as a side
// effect of being loaded).

/**
 * Extracts a diagnosis string from free-text using regex patterns common
 * in case report writing. Returns empty string if no match — embedAndStore
 * will store "" and the LLM will derive diagnosis from the full narrative
 * instead.
 *
 * The `blood culture grew/yielded X` pattern was added after sampling real
 * misses in the corpus (see FEVERIS_IMPLEMENTATION_NOTES.md §9): several
 * genuinely-diagnosed typhoid cases state the microbiology result directly
 * ("Blood culture grew Salmonella enterica serovar Typhi") rather than using
 * "diagnosed with"/"diagnosis of" phrasing, so none of the original patterns
 * ever matched them. This pattern generalizes beyond typhoid to any
 * culture-confirmed diagnosis written the same way.
 *
 * Deliberately NOT loosened further than this: sampling also turned up
 * several "typhoid" mentions in the corpus that must NOT be extracted as a
 * diagnosis — negative serology/Widal/IgM results ("...were normal"/"was
 * negative"), prior vaccination history, and failed empirical treatment
 * preceding a different eventual diagnosis. None of the patterns here match
 * "negative"/"normal"-qualified mentions, prior-history phrasing, or
 * vaccination context — only a positive, direct culture-growth statement.
 */
export function extractDiagnosis(text: string): string {
  const patterns = [
    /diagnosed with ([^.,"]{3,60})/i,
    /diagnosis of ([^.,"]{3,60})/i,
    /confirmed ([^.,"]{3,60}) infection/i,
    /consistent with ([^.,"]{3,60})/i,
    /final diagnosis[:\s]+([^.,"]{3,60})/i,
    /impression[:\s]+([^.,"]{3,60})/i,
    /blood culture (?:grew|yielded(?:\s+(?:a|the)\s+growth\s+of)?|showed growth of|isolated) ([^.,;"]{3,55})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      // Trim a run-on second culture result that got captured alongside the
      // first (e.g. "Bacillus Species and urine culture grew Klebsiella
      // ESBL" — two different specimens' results merged into one string by
      // the regex having no internal punctuation to stop at otherwise).
      const cleaned = match[1].split(/\s+and\s+\w+\s+culture\b/i)[0].trim();
      if (cleaned) return cleaned.toLowerCase();
    }
  }
  return "";
}
