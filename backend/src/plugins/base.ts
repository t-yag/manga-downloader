/**
 * Plugin system interfaces.
 * Each download source implements these interfaces.
 */

// --- Manifest ---

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** "series" = multi-volume title management, "standalone" = each item is independent */
  contentType: "series" | "standalone";
  supportedFeatures: {
    search: boolean;
    metadata: boolean;
    download: boolean;
    auth: boolean;
    newReleaseCheck: boolean;
  };
}

// --- Auth ---

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password" | "email";
  required: boolean;
}

export interface SessionData {
  cookies: CookieData[];
  expiresAt?: string;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
}

export interface AuthProvider {
  login(credentials: Record<string, string>): Promise<boolean>;
  validateSession(): Promise<boolean>;
  getSession(): SessionData | null;
  getCredentialFields(): CredentialField[];
  loadSession(cookiePath: string): Promise<boolean>;
  saveSession(cookiePath: string): Promise<void>;
}

// --- URL Parsing ---

export interface ParsedUrl {
  pluginId: string;
  titleId: string;
  /** Set when the URL points to a specific volume */
  volume?: number;
  /** "title" = title/series page, "volume" = specific volume page, "reader" = reader URL */
  type: "title" | "volume" | "reader";
}

export interface UrlParser {
  /** Check if this plugin can handle the given URL */
  canHandle(url: string): boolean;
  /** Parse URL into structured info */
  parse(url: string): ParsedUrl;
}

// --- Availability Check ---

export interface VolumeAvailability {
  volume: number;
  unit?: string;
  available: boolean;
  /** "purchased", "free", "subscription", "not_purchased", "unknown" */
  reason: string;
  /** Raw ViewMode from the content API (plugin-specific) */
  viewMode?: number;
}

export interface VolumeQuery {
  volume: number;
  unit?: string;
}

export interface AvailabilityChecker {
  /**
   * Check download availability for specified volumes.
   * Only checks volumes that are passed in (caller should skip already-downloaded ones).
   */
  checkAvailability(
    titleId: string,
    volumes: VolumeQuery[],
    session: SessionData | null
  ): Promise<VolumeAvailability[]>;
}

// --- Metadata ---

export interface TitleInfo {
  titleId: string;
  title: string;
  seriesTitle: string;
  author: string;
  genres: string[];
  totalVolumes: number;
  coverUrl?: string;
  volumes: VolumeInfo[];
}

export interface VolumeInfo {
  volume: number;
  /** "vol" (default) or "ep" — determines file naming ({unit} template variable) */
  unit?: string;
  readerUrl: string;
  /** Plugin-specific identifier (contentId, cid, etc.) */
  contentKey: string;
  detailUrl?: string;
  thumbnailUrl?: string;
  /** ISO date string — free campaign expiry (e.g. "2026-03-31") */
  freeUntil?: string;
}

export interface MetadataProvider {
  getTitleInfo(titleId: string): Promise<TitleInfo>;
  getVolumeInfo(titleId: string, volume: number): Promise<VolumeInfo>;
}

// --- Download ---

export interface DownloadJob {
  jobId: number;
  titleId: string;
  volume: number;
  readerUrl: string;
  contentKey: string;
  outputDir: string;
}

export interface DownloadProgress {
  phase: "init" | "loading" | "downloading" | "combining" | "done" | "error";
  /** 0.0 ~ 1.0 */
  progress: number;
  currentPage?: number;
  totalPages?: number;
  message: string;
}

export interface DownloadResult {
  totalPages: number;
  totalTime: number;
  filePath: string;
  fileSize: number;
}

export interface Downloader {
  download(
    job: DownloadJob,
    session: SessionData | null
  ): AsyncGenerator<DownloadProgress, DownloadResult>;
}

// --- New Release Check ---

export interface NewRelease {
  volume: number;
  title?: string;
  releaseDate?: string;
}

export interface NewReleaseChecker {
  checkNewReleases(
    titleId: string,
    lastKnownVolume: number
  ): Promise<NewRelease[]>;
}

// --- Plugin ---

export interface Plugin {
  manifest: PluginManifest;
  urlParser: UrlParser;
  auth?: AuthProvider;
  metadata?: MetadataProvider;
  availabilityChecker?: AvailabilityChecker;
  downloader: Downloader;
  newReleaseChecker?: NewReleaseChecker;
  dispose?(): Promise<void>;
}
