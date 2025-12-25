export type GoogleSearchTool = {
  googleSearch: Record<string, never>;
};

export function createGoogleSearchTool(): GoogleSearchTool {
  return { googleSearch: {} };
}

export function createGoogleSearchRetrievalTool(): GoogleSearchTool {
  return createGoogleSearchTool();
}
