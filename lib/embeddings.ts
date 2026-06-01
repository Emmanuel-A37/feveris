// lib/embeddings.ts
import { env } from "@huggingface/transformers";

env.allowRemoteModels = true;

type EmbeddingPipeline = (
  input: string,
  options?: Record<string, unknown>
) => Promise<unknown>;

let embedPipeline: EmbeddingPipeline | null = null;

async function getEmbedder() {
  if (!embedPipeline) {
    console.log("[Embeddings] Loading Xenova/all-MiniLM-L6-v2...");
    const transformers = await import("@huggingface/transformers");
    const hfPipeline = (transformers as { pipeline: (...args: unknown[]) => Promise<EmbeddingPipeline> }).pipeline;

    embedPipeline = await hfPipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
    console.log("[Embeddings] Ready.");
  }
  return embedPipeline;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const embedder = await getEmbedder();

  const out = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  // @huggingface/transformers returns a Tensor object.
  // .tolist() is the safe cross-version way to extract the flat number array.
  // Handles both older (.data as Float32Array) and newer (nested Tensor) shapes.
  const tensor = out as {
    tolist?: () => number[] | number[][];
    data?: Float32Array;
    ort_tensor?: { cpuData: Float32Array };
  };

  if (typeof tensor.tolist === "function") {
    const list = tensor.tolist();
    // tolist() on a [1, 384] tensor returns [[...384 numbers...]]
    // Flatten one level if nested
    return Array.isArray(list[0]) ? (list[0] as number[]) : (list as number[]);
  }

  // Fallback for older versions that expose .data directly
  if (tensor.data instanceof Float32Array) {
    return Array.from(tensor.data);
  }

  // Last resort — ort_tensor path used in some edge runtime builds
  if (tensor.ort_tensor?.cpuData instanceof Float32Array) {
    return Array.from(tensor.ort_tensor.cpuData);
  }

  throw new Error(
    "Could not extract embedding vector from pipeline output. " +
    `Output shape: ${JSON.stringify(Object.keys(tensor))}`
  );
}