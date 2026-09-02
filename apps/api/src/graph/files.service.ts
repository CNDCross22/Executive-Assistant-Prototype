import { MAX_EXTERNAL_FILE_BYTES, safeFileName } from '../content/safe-text.js';
import { extractDocumentText, supportsExtraction, SUPPORTED_FORMATS_SENTENCE, type ExtractedDocument } from '../content/documents.js';
import type { GraphClient } from './client.js';

export interface FileSummary {
  driveId: string;
  id: string;
  name: string;
  size: number;
  modifiedAt: string;
  webUrl: string;
  kind: 'file' | 'folder' | 'package' | 'unknown';
  mimeType: string;
  textSupported: boolean;
}

export interface SiteSummary { id: string; name: string; displayName: string; webUrl: string; }

interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  package?: { type?: string };
  parentReference?: { driveId?: string };
}

interface GraphSite { id: string; name?: string; displayName?: string; webUrl?: string; }

/** Read-only OneDrive and SharePoint file access with bounded text extraction. */
export class FilesService {
  constructor(private readonly graph: GraphClient) {}

  private shape(item: GraphDriveItem, fallbackDriveId = ''): FileSummary {
    const name = safeFileName(item.name);
    const mimeType = item.file?.mimeType ?? '';
    const kind = item.file ? 'file' : item.folder ? 'folder' : item.package ? 'package' : 'unknown';
    return {
      driveId: item.parentReference?.driveId ?? fallbackDriveId,
      id: item.id,
      name,
      size: Math.max(0, item.size ?? 0),
      modifiedAt: item.lastModifiedDateTime ?? '',
      webUrl: item.webUrl ?? '',
      kind,
      mimeType,
      textSupported: kind === 'file' && supportsExtraction(name, mimeType),
    };
  }

  async listOneDrive(folderId?: string, limit = 50): Promise<FileSummary[]> {
    const path = folderId
      ? `/me/drive/items/${encodeURIComponent(folderId)}/children`
      : '/me/drive/root/children';
    const rows = await this.graph.collect<GraphDriveItem>(path, {
      query: { $select: 'id,name,size,lastModifiedDateTime,webUrl,file,folder,package,parentReference', $top: Math.min(limit, 50) },
      label: 'onedrive.children.list',
    }, Math.ceil(limit / 50));
    return rows.slice(0, limit).map((row) => this.shape(row));
  }

  async searchOneDrive(query: string, limit = 25): Promise<FileSummary[]> {
    const escaped = query.replace(/'/g, "''");
    const rows = await this.graph.collect<GraphDriveItem>(`/me/drive/root/search(q='${encodeURIComponent(escaped)}')`, {
      query: { $select: 'id,name,size,lastModifiedDateTime,webUrl,file,folder,package,parentReference', $top: Math.min(limit, 50) },
      label: 'onedrive.search',
    }, Math.ceil(limit / 50));
    return rows.slice(0, limit).map((row) => this.shape(row));
  }

  async searchSites(query: string, limit = 20): Promise<SiteSummary[]> {
    const rows = await this.graph.collect<GraphSite>('/sites', {
      // Site search documents only the free-text search parameter.
      query: { search: query },
      label: 'sharepoint.sites.search',
    }, 1);
    return rows.slice(0, limit).map((site) => ({
      id: site.id,
      name: site.name?.trim() || 'Site',
      displayName: site.displayName?.trim() || site.name?.trim() || 'Site',
      webUrl: site.webUrl ?? '',
    }));
  }

  async listSiteFiles(siteId: string, query?: string, limit = 50): Promise<FileSummary[]> {
    const escaped = query?.replace(/'/g, "''");
    const path = escaped
      ? `/sites/${encodeURIComponent(siteId)}/drive/root/search(q='${encodeURIComponent(escaped)}')`
      : `/sites/${encodeURIComponent(siteId)}/drive/root/children`;
    const rows = await this.graph.collect<GraphDriveItem>(path, {
      query: { $select: 'id,name,size,lastModifiedDateTime,webUrl,file,folder,package,parentReference', $top: Math.min(limit, 50) },
      label: query ? 'sharepoint.files.search' : 'sharepoint.files.list',
    }, Math.ceil(limit / 50));
    return rows.slice(0, limit).map((row) => this.shape(row));
  }

  async readText(input: {
    driveId: string;
    itemId: string;
    startCharacter?: number;
    maxCharacters?: number;
  }): Promise<FileSummary & ExtractedDocument> {
    const item = await this.graph.request<GraphDriveItem>(
      `/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}`,
      { query: { $select: 'id,name,size,lastModifiedDateTime,webUrl,file,folder,package,parentReference' }, label: 'files.item.metadata' },
    );
    const metadata = this.shape(item, input.driveId);
    if (!metadata.textSupported) throw new Error(`I cannot read ${metadata.name}. ${SUPPORTED_FORMATS_SENTENCE}`);
    if (metadata.size > MAX_EXTERNAL_FILE_BYTES) throw new Error(`${metadata.name} is larger than the 5 MB inspection limit.`);
    const content = await this.graph.requestBytes(
      `/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}/content`,
      { maxBytes: MAX_EXTERNAL_FILE_BYTES, label: 'files.item.content' },
    );
    const extracted = await extractDocumentText({
      bytes: content.bytes,
      name: metadata.name,
      contentType: metadata.mimeType || content.contentType,
      startCharacter: input.startCharacter,
      maxCharacters: input.maxCharacters,
    });
    return { ...metadata, ...extracted };
  }
}
