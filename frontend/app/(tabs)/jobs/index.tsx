import { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from "react-native";
import { toast } from "../../../src/toast";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getJobs, cancelJob, type Job } from "../../../src/api/client";
import { TAB_CONTENT_PADDING } from "../../../src/constants";

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: "いいえ", style: "cancel" },
      { text: "OK", style: "destructive", onPress: onConfirm },
    ]);
  }
}

type StatusFilter = "all" | "active" | "done" | "error";

const STATUS_CONFIG: Record<
  string,
  { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }
> = {
  pending: { icon: "time-outline", color: "#94a3b8", label: "待機" },
  running: { icon: "arrow-down-circle", color: "#fb923c", label: "実行中" },
  done: { icon: "checkmark-circle", color: "#4ade80", label: "完了" },
  error: { icon: "alert-circle", color: "#f87171", label: "エラー" },
  cancelled: { icon: "close-circle", color: "#a8a29e", label: "中止" },
};

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "active", label: "実行中" },
  { key: "done", label: "完了" },
  { key: "error", label: "エラー" },
];

const PAGE_SIZE = 30;

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return `${min}分${remainSec}秒`;
}

export default function JobsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const isFocused = useIsFocused();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [extraJobs, setExtraJobs] = useState<Job[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const loadingMore = useRef(false);

  const { data: firstPage = [], isLoading, refetch } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJobs({ limit: PAGE_SIZE, offset: 0 }),
    staleTime: 0,
    refetchInterval: isFocused ? 3000 : false,
  });

  const allJobs = hasMore && extraJobs.length > 0
    ? (() => {
        const ids = new Set(firstPage.map((j) => j.id));
        return [...firstPage, ...extraJobs.filter((j) => !ids.has(j.id))];
      })()
    : firstPage;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const more = await getJobs({ limit: PAGE_SIZE, offset: allJobs.length });
      if (more.length < PAGE_SIZE) setHasMore(false);
      if (more.length > 0) {
        setExtraJobs((prev) => {
          const ids = new Set(prev.map((j) => j.id));
          return [...prev, ...more.filter((j) => !ids.has(j.id))];
        });
      }
    } finally {
      loadingMore.current = false;
    }
  }, [hasMore, allJobs.length]);

  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  const filteredJobs = allJobs.filter((j) => {
    if (filter === "active") return j.status === "running" || j.status === "pending";
    if (filter === "done") return j.status === "done";
    if (filter === "error") return j.status === "error" || j.status === "cancelled";
    return true;
  });

  const activeCount = allJobs.filter(
    (j) => j.status === "running" || j.status === "pending"
  ).length;

  const renderJob = ({ item }: { item: Job }) => {
    const cfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.pending;
    const isRunning = item.status === "running";
    const progressPct = Math.round(item.progress * 100);
    const isPending = item.status === "pending";
    const label = item.titleName
      ? item.volumeNum != null
        ? `${item.titleName} ${item.volumeNum}巻`
        : item.titleName
      : item.pluginId;

    return (
      <View style={styles.row}>
        <Ionicons name={cfg.icon} size={16} color={cfg.color} style={styles.rowIcon} />
        <View style={styles.rowBody}>
          <View style={styles.rowMain}>
            <View style={styles.rowTitleRow}>
              <Text style={styles.dlTag}>DL</Text>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {label}
              </Text>
            </View>
            <Text style={styles.rowTime}>{formatTime(item.createdAt)}</Text>
          </View>
          {isRunning && progressPct > 0 && (
            <View style={styles.progressRow}>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
              </View>
              <Text style={styles.progressText}>{progressPct}%</Text>
            </View>
          )}
          {isRunning && progressPct === 0 && item.message && /^\d+$/.test(item.message) && (
            <View style={styles.pageCountRow}>
              <Ionicons name="documents-outline" size={12} color="#60a5fa" />
              <Text style={styles.pageCountText}>{item.message}ページ DL済</Text>
            </View>
          )}
          {item.error && (
            <Text style={styles.errorText} numberOfLines={1}>{item.error}</Text>
          )}
          {!isRunning && !item.error && item.startedAt && (item.status === "done" || item.status === "error") && (
            <Text style={styles.durationText}>
              {formatDuration(item.startedAt, item.finishedAt)}
            </Text>
          )}
        </View>
        {(isPending || isRunning) && (
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() =>
              confirmAction(
                "キャンセル",
                isRunning
                  ? "実行中のジョブをキャンセルしますか？\nダウンロード済みのファイルは削除されます。"
                  : "このジョブをキャンセルしますか？",
                () => cancelMutation.mutate(item.id)
              )
            }
          >
            <Ionicons name="close" size={14} color="#fca5a5" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, Platform.OS === "ios" && { paddingTop: insets.top + TAB_CONTENT_PADDING }]}>
      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[
              styles.filterTab,
              filter === f.key && styles.filterTabActive,
            ]}
            onPress={() => setFilter(f.key)}
          >
            <Text
              style={[
                styles.filterText,
                filter === f.key && styles.filterTextActive,
              ]}
            >
              {f.label}
            </Text>
            {f.key === "active" && activeCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Job list */}
      {isLoading ? (
        <ActivityIndicator
          size="large"
          style={{ marginTop: 40 }}
          color="#60a5fa"
        />
      ) : (
        <FlatList
          data={filteredJobs}
          keyExtractor={(item) => `job-${item.id}`}
          renderItem={renderJob}
          contentContainerStyle={{ paddingBottom: 20 }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#60a5fa"
              colors={["#60a5fa"]}
            />
          }
          ListFooterComponent={
            hasMore && allJobs.length > 0 ? (
              <ActivityIndicator size="small" color="#64748b" style={{ marginVertical: 12 }} />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons
                name="download-outline"
                size={48}
                color="#334155"
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.emptyTitle}>
                {filter === "all"
                  ? "ジョブはありません"
                  : "該当するジョブがありません"}
              </Text>
              <Text style={styles.emptyHint}>
                ライブラリからダウンロードを開始するとここに表示されます
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Filters
  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 12,
  },
  filterTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterTabActive: {
    backgroundColor: "#1e3a5f",
  },
  filterText: { color: "#64748b", fontSize: 13, fontWeight: "600" },
  filterTextActive: { color: "#60a5fa" },
  filterBadge: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  filterBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },

  // Row (compact)
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
  },
  rowIcon: {
    marginRight: 10,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  dlTag: {
    color: "#60a5fa",
    fontSize: 10,
    fontWeight: "700",
    backgroundColor: "#1e3a5f",
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: "hidden",
  },
  rowTitle: {
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  rowTime: {
    color: "#64748b",
    fontSize: 11,
    flexShrink: 0,
  },

  // Progress (inline)
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  progressBar: {
    flex: 1,
    height: 4,
    backgroundColor: "#334155",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#3b82f6",
    borderRadius: 2,
  },
  progressText: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
    width: 32,
    textAlign: "right",
  },

  // Sub-info
  pageCountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 3,
  },
  pageCountText: { color: "#60a5fa", fontSize: 11, fontWeight: "600" },
  durationText: { color: "#64748b", fontSize: 11, marginTop: 2 },
  errorText: { color: "#f87171", fontSize: 11, marginTop: 2 },

  // Cancel
  cancelBtn: {
    marginLeft: 8,
    backgroundColor: "#7f1d1d",
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },

  // Empty
  emptyContainer: { alignItems: "center", marginTop: 60 },
  emptyTitle: { color: "#94a3b8", fontSize: 16, fontWeight: "600" },
  emptyHint: {
    color: "#64748b",
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
    paddingHorizontal: 20,
  },
});
