export type StoredChunk = {
  id: string;
  source: string;
  text: string;
  embedding: number[];
};

export type StoredIndex = {
  version: 1;
  embeddingModel: string;
  embeddingDimension?: number;
  chunks: StoredChunk[];
};
