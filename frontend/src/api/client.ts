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
  description: string;
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
  totalVolumes: number | null;
  coverUrl: string | null;
  genres: string[];
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
  status: string;
  availabilityReason: string | null;
  pageCount: number | null;
  filePath: string | null;
  downloadedAt: string | null;
  checkedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LibraryDetail extends Omit<LibraryTitle, "volumeSummary"> {
  description: string | null;
  volumes: Volume[];
}

export function getLibrary() {
  return request<LibraryTitle[]>("/api/library");
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

export function deleteFromLibrary(id: number) {
  return request<{ message: string }>(`/api/library/${id}`, { method: "DELETE" });
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

export function downloadVolumes(id: number, volumes: number[] | "available" | "all", accountId?: number) {
  return request<{ message: string; jobIds: number[]; volumes: number[] }>(
    `/api/library/${id}/download`,
    { method: "POST", body: JSON.stringify({ volumes, accountId }) }
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
}

export function getJobs(params?: { status?: string }) {
  const query = params?.status ? `?status=${params.status}` : "";
  return request<Job[]>(`/api/jobs${query}`);
}

export function cancelJob(id: number) {
  return request<{ message: string }>(`/api/jobs/${id}`, { method: "DELETE" });
}

// --- Plugins ---

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  supportedFeatures: Record<string, boolean>;
}

export function getPlugins() {
  return request<PluginInfo[]>("/api/plugins");
}

// --- Accounts ---

export interface Account {
  id: number;
  pluginId: string;
  label: string | null;
  isActive: boolean;
  credentials: string;
}

export function getAccounts() {
  return request<Account[]>("/api/accounts");
}

export function createAccount(params: { pluginId: string; label?: string; credentials: Record<string, string> }) {
  return request<Account>("/api/accounts", {
    method: "POST",
    body: JSON.stringify(params),
  });
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

// --- Health ---

export function healthCheck() {
  return request<{ status: string; timestamp: string }>("/api/health");
}
