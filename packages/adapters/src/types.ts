export interface SourceItem {
  title: string;
  url: string;
  content: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  name: string;
  sourceType: string;
  fetch(configMetadata?: Record<string, unknown>): Promise<SourceItem[]>;
}

export interface CrawlService {
  crawl(url: string): Promise<{ markdown: string; metadata?: Record<string, unknown> }>;
}
