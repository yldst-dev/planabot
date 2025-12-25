import { DirectoryLoader } from "@langchain/classic/document_loaders/fs/directory";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text";
import type { Document } from "@langchain/core/documents";

type AnyMetadata = Record<string, unknown>;

export async function loadSourceDirectory(sourceDir: string): Promise<Document<AnyMetadata>[]> {
  const loader = new DirectoryLoader(sourceDir, {
    ".md": (p: string) => new TextLoader(p),
    ".txt": (p: string) => new TextLoader(p),
    ".ts": (p: string) => new TextLoader(p),
    ".tsx": (p: string) => new TextLoader(p),
    ".js": (p: string) => new TextLoader(p),
    ".jsx": (p: string) => new TextLoader(p),
    ".json": (p: string) => new TextLoader(p),
    ".rs": (p: string) => new TextLoader(p),
    ".py": (p: string) => new TextLoader(p),
    ".toml": (p: string) => new TextLoader(p),
    ".yaml": (p: string) => new TextLoader(p),
    ".yml": (p: string) => new TextLoader(p)
  });

  return loader.load();
}
