import { Platform } from "react-native";

let BASE_URL = Platform.OS === "web" ? "http://localhost:3000" : "http://localhost:3000";

export function setBaseUrl(url: string) {
  BASE_URL = url.replace(/\/+$/, "");
}

export function getBaseUrl() {
  return BASE_URL;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// --- URL Parse ---

export interface ParsedUrl {
  pluginId: string;
  titleId: string;
  volume?: number;
  type: "title" | "volume" | "reader";
}

export interface TitleInfo {
  titleId: string;
  title: string;
  seriesTitle: string;
  author: string;
  genres: string[];
  totalVolumes: number;
  coverUrl?: string;
  volumes: { volume: number; readerUrl: string; contentKey: string }[];
}

export function parseUrl(url: string) {
  return request<{ parsed: ParsedUrl; titleInfo: TitleInfo | null }>("/api/url/parse", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

// --- Library ---

export interface LibraryTitle {
  id: number;
  pluginId: string;
  titleId: string;
  title: string;
  author: string | null;
  contentType: "series" | "standalone";
  totalVolumes: number | null;
  coverUrl: string | null;
  genres: string[];
  displayGenres: string[] | null;
  volumeSummary: {
    total: number;
    downloaded: number;
    available: number;
    unknown: number;
  };
}

export interface Volume {
  id: number;
  libraryId: number | null;
  volumeNum: number;
  unit: string | null;
  status: string;
  availabilityReason: string | null;
  freeUntil: string | null;
  pageCount: number | null;
  filePath: string | null;
  thumbnailUrl: string | null;
  downloadedAt: string | null;
  checkedAt: string | null;
  metadata: Record<string, unknown> | null;
  jobProgress: number | null;
  jobMessage: string | null;
}

export interface LibraryDetail extends Omit<LibraryTitle, "volumeSummary"> {
  volumes: Volume[];
}

export interface LibraryQuery {
  search?: string;
  pluginIds?: string[];
  contentTypes?: ("series" | "standalone")[];
  tags?: string[];
  sort?: "lastAccessedAt" | "createdAt" | "title" | "updatedAt";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface LibraryResponse {
  items: LibraryTitle[];
  total: number;
}

export function getLibrary(params?: LibraryQuery) {
  const q = new URLSearchParams();
  if (params?.search) q.set("search", params.search);
  if (params?.pluginIds?.length) q.set("pluginId", params.pluginIds.join(","));
  if (params?.contentTypes?.length) q.set("contentType", params.contentTypes.join(","));
  if (params?.tags?.length) q.set("tags", params.tags.join(","));
  if (params?.sort) q.set("sort", params.sort);
  if (params?.order) q.set("order", params.order);
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  const qs = q.toString();
  return request<LibraryResponse>(`/api/library${qs ? `?${qs}` : ""}`);
}

export interface TagInfo {
  name: string;
  count: number;
}

export function getLibraryTags() {
  return request<{ tags: TagInfo[] }>("/api/library/tags");
}

export function getLibraryTitle(id: number) {
  return request<LibraryDetail>(`/api/library/${id}`);
}

export function addToLibrary(params: { url?: string; pluginId?: string; titleId?: string }) {
  return request<LibraryDetail>("/api/library", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateLibraryTitle(id: number, params: { title?: string; author?: string }) {
  return request<{ message: string }>(`/api/library/${id}`, {
    method: "PATCH",
    body: JSON.stringify(params),
  });
}

export function deleteFromLibrary(id: number) {
  return request<{ message: string }>(`/api/library/${id}`, { method: "DELETE" });
}

export function deleteVolumes(id: number, volumes: number[]) {
  return request<{ message: string; deletedCount: number; errors: string[] }>(
    `/api/library/${id}/delete-volumes`,
    { method: "POST", body: JSON.stringify({ volumes }) }
  );
}

export function refreshTitle(id: number) {
  return request<{ message: string; totalVolumes: number; newVolumes: number }>(
    `/api/library/${id}/refresh`,
    { method: "POST" }
  );
}

export function checkAvailability(id: number, accountId?: number) {
  return request<{ message: string; results: { volume: number; available: boolean; reason: string }[] }>(
    `/api/library/${id}/check-availability`,
    { method: "POST", body: JSON.stringify({ accountId }) }
  );
}

export function syncTitle(id: number, accountId?: number, volumes?: number[]) {
  return request<{ message: string; newVolumes: number; totalVolumes: number | null; checkedVolumes: number; availableCount: number }>(
    `/api/library/${id}/sync`,
    { method: "POST", body: JSON.stringify({ accountId, volumes }) }
  );
}

export function downloadVolumes(id: number, volumes: number[] | "available" | "all" | "error", accountId?: number, unit?: string) {
  return request<{ message: string; jobIds: number[]; volumes: number[] }>(
    `/api/library/${id}/download`,
    { method: "POST", body: JSON.stringify({ volumes, accountId, unit }) }
  );
}

// --- Jobs ---

export interface Job {
  id: number;
  pluginId: string;
  accountId: number | null;
  volumeId: number | null;
  status: string;
  priority: number;
  progress: number;
  message: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  titleName: string | null;
  volumeNum: number | null;
  unit: string | null;
  libraryId: number | null;
}

export function getJobs(params?: { status?: string; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  const qs = q.toString();
  return request<Job[]>(`/api/jobs${qs ? `?${qs}` : ""}`);
}

export function cancelJob(id: number) {
  return request<{ message: string }>(`/api/jobs/${id}`, { method: "DELETE" });
}

export function cancelAllJobs() {
  return request<{ message: string; pendingCancelled: number; runningCancelled: number }>(
    "/api/jobs",
    { method: "DELETE" },
  );
}

// --- Plugins ---

export type LoginMethod = "credentials" | "browser" | "cookie_import";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  contentType: "series" | "standalone";
  loginMethods?: LoginMethod[];
  authCookieNames?: string[];
  authUrl?: string;
  supportedFeatures: Record<string, boolean>;
}

export interface Capabilities {
  enableBrowserLogin: boolean;
}

export function getPlugins() {
  return request<PluginInfo[]>("/api/plugins");
}

// --- Accounts ---

export interface AccountSession {
  hasCookies: boolean;
  cookieCount: number;
  expiresAt: string | null;
}

export interface Account {
  id: number;
  pluginId: string;
  label: string | null;
  isActive: boolean;
  credentials: string;
  session: AccountSession;
}

export function getAccounts() {
  return request<Account[]>("/api/accounts");
}

export function createAccount(params: { pluginId: string; label?: string; credentials?: Record<string, string> }) {
  return request<Account>("/api/accounts", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateAccount(id: number, params: { label?: string; credentials?: Record<string, string> }) {
  return request<{ message: string }>(`/api/accounts/${id}`, {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

export function deleteAccount(id: number) {
  return request<{ message: string }>(`/api/accounts/${id}`, { method: "DELETE" });
}

export function loginAccount(id: number) {
  return request<{ success: boolean; message: string }>(`/api/accounts/${id}/login`, {
    method: "POST",
  });
}

export function clearAccountSession(id: number) {
  return request<{ message: string }>(`/api/accounts/${id}/clear-session`, {
    method: "POST",
  });
}

export function importCookies(id: number, cookies: Array<{ name: string; value: string; expires?: string }>) {
  return request<{ success: boolean; valid: boolean; cookieCount: number; message: string }>(
    `/api/accounts/${id}/import-cookies`,
    { method: "POST", body: JSON.stringify({ cookies }) },
  );
}

export function getCapabilities() {
  return request<Capabilities>("/api/capabilities");
}

// --- Settings ---

export function getSettings() {
  return request<Record<string, unknown>>("/api/settings");
}

export function updateSettings(settings: Record<string, unknown>) {
  return request<{ message: string }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

// --- Tag Rules ---

export interface TagRule {
  id: number;
  original: string;
  action: "show" | "map" | "hide";
  mappedTo: string | null;
}

export interface TagDiscoverItem {
  tag: string;
  count: number;
  plugins: string[];
  rule: { id: number; action: "show" | "map" | "hide"; mappedTo: string | null } | null;
}

export function discoverTags(pluginId?: string) {
  const qs = pluginId ? `?pluginId=${pluginId}` : "";
  return request<{ tags: TagDiscoverItem[] }>(`/api/tags/discover${qs}`);
}

export interface TagItemEntry {
  id: number;
  pluginId: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
}

export function getTagItems(tag: string, params?: { limit?: number; offset?: number }) {
  const q = new URLSearchParams({ tag });
  if (params?.limit != null) q.set("limit", String(params.limit));
  if (params?.offset != null) q.set("offset", String(params.offset));
  return request<{ items: TagItemEntry[]; total: number }>(`/api/tags/items?${q}`);
}

export function getTagRules() {
  return request<TagRule[]>("/api/tag-rules");
}

export function createTagRule(params: {
  original: string;
  action: "show" | "map" | "hide";
  mappedTo?: string | null;
}) {
  return request<TagRule>("/api/tag-rules", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateTagRule(
  id: number,
  params: { action?: "show" | "map" | "hide"; mappedTo?: string | null }
) {
  return request<{ message: string }>(`/api/tag-rules/${id}`, {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

export function deleteTagRule(id: number) {
  return request<{ message: string }>(`/api/tag-rules/${id}`, {
    method: "DELETE",
  });
}

export function importTagRules(params: {
  mode: "merge" | "replace";
  rules: Record<string, string | null>;
}) {
  return request<{ message: string; created: number; updated: number }>(
    "/api/tag-rules/import",
    { method: "POST", body: JSON.stringify(params) }
  );
}

export function rebuildDisplayGenres() {
  return request<{ message: string; updated: number }>("/api/tag-rules/rebuild", {
    method: "POST",
  });
}

// --- Health ---

export function healthCheck() {
  return request<{ status: string; timestamp: string }>("/api/health");
}
