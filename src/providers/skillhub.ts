import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parseFrontmatter } from '../frontmatter.ts';
import { sanitizeMetadata } from '../sanitize.ts';
import type { WellKnownFileContent, WellKnownSkill } from './wellknown.ts';

const DEFAULT_BASE_URL = 'https://skillhub.uniontech.com';
const MAX_ARCHIVE_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1000;

export interface SkillHubSummary {
  slug: string;
  displayName: string;
  summary: string;
  stats?: {
    downloads?: number;
    stars?: number;
  };
  latestVersion?: {
    version?: string;
  };
}

interface SkillHubListResponse {
  items?: SkillHubSummary[];
}

interface SkillHubSearchResponse {
  results?: SkillHubSummary[];
}

interface SkillHubDetailResponse {
  skill?: SkillHubSummary;
}

export class SkillHubProvider {
  readonly id = 'skillhub';
  readonly displayName = 'UnionTech SkillHub';
  private readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private get apiBase(): string {
    return `${this.baseUrl.replace(/\/$/, '')}/api/v1`;
  }

  getSourceIdentifier(): string {
    return 'skillhub.uniontech.com';
  }

  async listSkills(page = 0, size = 100): Promise<SkillHubSummary[]> {
    const url = `${this.apiBase}/skills?page=${page}&size=${size}`;
    const data = (await this.fetchJson(url)) as SkillHubListResponse;
    return Array.isArray(data.items) ? data.items.filter(isSkillSummary) : [];
  }

  async searchSkills(query: string, page = 0, size = 20): Promise<SkillHubSummary[]> {
    const url = `${this.apiBase}/search?q=${encodeURIComponent(query)}&page=${page}&size=${size}`;
    const data = (await this.fetchJson(url)) as SkillHubSearchResponse;
    return Array.isArray(data.results) ? data.results.filter(isSkillSummary) : [];
  }

  async getSkill(slug: string): Promise<SkillHubSummary | null> {
    const url = `${this.apiBase}/skills/${encodeURIComponent(slug)}`;
    const data = (await this.fetchJson(url)) as SkillHubDetailResponse;
    return isSkillSummary(data.skill) ? data.skill : null;
  }

  async fetchSkill(slug: string, summary?: SkillHubSummary): Promise<WellKnownSkill | null> {
    const safeSlug = sanitizeSlug(slug);
    const sourceUrl = `${this.apiBase}/download/${encodeURIComponent(safeSlug)}`;

    const response = await fetch(sourceUrl, {
      headers: { Accept: 'application/zip, application/octet-stream' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    const files = extractZip(bytes);
    normalizeRootSkill(files);

    const skillMd = files.get('SKILL.md');
    if (!skillMd) return null;

    const content = typeof skillMd === 'string' ? skillMd : new TextDecoder().decode(skillMd);
    files.set('SKILL.md', content);

    const { data } = parseFrontmatter(content);
    if (typeof data.name !== 'string' || typeof data.description !== 'string') return null;

    return {
      name: sanitizeMetadata(data.name),
      description: sanitizeMetadata(data.description),
      content,
      installName: safeSlug,
      sourceUrl,
      metadata:
        data.metadata && typeof data.metadata === 'object'
          ? (data.metadata as Record<string, unknown>)
          : undefined,
      files,
      indexEntry: {
        name: safeSlug,
        description: summary?.summary || data.description,
        type: 'archive',
        url: sourceUrl,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`SkillHub request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}

function isSkillSummary(value: unknown): value is SkillHubSummary {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.slug === 'string' &&
    record.slug.length > 0 &&
    typeof record.displayName === 'string' &&
    typeof record.summary === 'string'
  );
}

function sanitizeSlug(slug: string): string {
  const decoded = decodeURIComponent(slug);
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) {
    throw new Error(`Invalid SkillHub skill slug: ${slug}`);
  }
  return decoded;
}

function normalizeArchivePath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(rawPath)) return null;
  if (rawPath.includes('\\')) return null;

  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;

  return parts.join('/');
}

function addArchiveFile(
  files: Map<string, WellKnownFileContent>,
  path: string,
  content: Uint8Array,
  runningTotal: { bytes: number }
) {
  const normalizedPath = normalizeArchivePath(path);
  if (!normalizedPath) throw new Error(`Unsafe archive path: ${path}`);

  runningTotal.bytes += content.byteLength;
  if (runningTotal.bytes > MAX_ARCHIVE_UNPACKED_BYTES) {
    throw new Error('Archive exceeds maximum unpacked size');
  }
  if (files.size >= MAX_ARCHIVE_FILES) {
    throw new Error('Archive contains too many files');
  }

  files.set(normalizedPath, content);
}

function extractZip(bytes: Uint8Array): Map<string, WellKnownFileContent> {
  const buffer = Buffer.from(bytes);
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error('Invalid zip archive');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const files = new Map<string, WellKnownFileContent>();
  const runningTotal = { bytes: 0 };
  let offset = centralDirectoryOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid zip directory');

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const rawName = buffer.subarray(nameStart, nameStart + fileNameLength);
    const fileName = new TextDecoder(flags & 0x800 ? 'utf-8' : undefined).decode(rawName);

    offset = nameStart + fileNameLength + extraLength + commentLength;

    if (fileName.endsWith('/')) continue;
    if (flags & 0x1) throw new Error('Encrypted zip entries are not supported');

    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000 || fileType === 0o10000) {
      throw new Error('Archive links are not supported');
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error('Invalid zip local header');
    }
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip compression method: ${method}`);
    }

    if (content.byteLength !== uncompressedSize) {
      throw new Error('Zip entry size mismatch');
    }

    addArchiveFile(files, fileName, new Uint8Array(content), runningTotal);
  }

  if (!files.has('SKILL.md')) {
    stripSingleTopLevelDirectory(files);
  }
  if (!files.has('SKILL.md')) throw new Error('Archive missing root SKILL.md');
  return files;
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function stripSingleTopLevelDirectory(files: Map<string, WellKnownFileContent>): void {
  const paths = Array.from(files.keys());
  const topLevels = new Set(paths.map((path) => path.split('/')[0]));
  if (topLevels.size !== 1) return;

  const prefix = `${paths[0]!.split('/')[0]!}/`;
  if (!files.has(`${prefix}SKILL.md`)) return;

  const stripped = new Map<string, WellKnownFileContent>();
  for (const [path, content] of files) {
    if (path.startsWith(prefix)) {
      stripped.set(path.slice(prefix.length), content);
    }
  }

  files.clear();
  for (const [path, content] of stripped) {
    files.set(path, content);
  }
}

function normalizeRootSkill(files: Map<string, WellKnownFileContent>): void {
  const skillMd = files.get('SKILL.md');
  if (skillMd && typeof skillMd !== 'string') {
    files.set('SKILL.md', new TextDecoder().decode(skillMd));
  }
}

export const skillHubProvider = new SkillHubProvider();
