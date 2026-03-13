import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getJobs, cancelJob, type Job } from "../../src/api/client";

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  pending:   { bg: "#334155", fg: "#94a3b8", label: "待機中" },
  running:   { bg: "#7c2d12", fg: "#fb923c", label: "実行中" },
  done:      { bg: "#166534", fg: "#4ade80", label: "完了" },
  error:     { bg: "#7f1d1d", fg: "#f87171", label: "エラー" },
  cancelled: { bg: "#44403c", fg: "#a8a29e", label: "キャンセル済" },
};

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function JobsScreen() {
  const queryClient = useQueryClient();

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJobs(),
    refetchInterval: 3000,
  });

  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "pending");
  const finishedJobs = jobs.filter((j) => j.status !== "running" && j.status !== "pending");

  const renderJob = ({ item }: { item: Job }) => {
    const s = STATUS_STYLES[item.status] ?? STATUS_STYLES.pending;
    const progressPct = Math.round(item.progress * 100);

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <View style={[styles.statusDot, { backgroundColor: s.fg }]} />
            <Text style={[styles.statusLabel, { color: s.fg }]}>{s.label}</Text>
          </View>
          <Text style={styles.jobTime}>{formatTime(item.createdAt)}</Text>
        </View>

        <View style={styles.cardBody}>
          <Text style={styles.jobPlugin}>{item.pluginId}</Text>
          {item.message && (
            <Text style={styles.jobMessage} numberOfLines={2}>{item.message}</Text>
          )}
        </View>

        {item.status === "running" && (
          <View style={styles.progressContainer}>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
            </View>
            <Text style={styles.progressText}>{progressPct}%</Text>
          </View>
        )}

        {item.error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{item.error}</Text>
          </View>
        )}

        {item.status === "pending" && (
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() =>
              Alert.alert("ジョブをキャンセル", "このジョブをキャンセルしますか？", [
                { text: "いいえ", style: "cancel" },
                { text: "キャンセルする", style: "destructive", onPress: () => cancelMutation.mutate(item.id) },
              ])
            }
          >
            <Text style={styles.cancelText}>キャンセル</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const renderSectionHeader = (title: string, count: number) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
  );

  const allJobs = [
    ...(activeJobs.length > 0 ? [{ type: "header" as const, title: "実行中・待機中", count: activeJobs.length }] : []),
    ...activeJobs.map((j) => ({ type: "job" as const, job: j })),
    ...(finishedJobs.length > 0 ? [{ type: "header" as const, title: "履歴", count: finishedJobs.length }] : []),
    ...finishedJobs.map((j) => ({ type: "job" as const, job: j })),
  ];

  return (
    <View style={styles.container}>
      {isLoading ? (
        <ActivityIndicator size="large" style={{ marginTop: 40 }} color="#60a5fa" />
      ) : (
        <FlatList
          data={allJobs}
          keyExtractor={(item, i) => item.type === "header" ? `header-${item.title}` : `job-${item.job.id}`}
          renderItem={({ item }) => {
            if (item.type === "header") {
              return renderSectionHeader(item.title, item.count);
            }
            return renderJob({ item: item.job });
          }}
          contentContainerStyle={{ paddingBottom: 20 }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyTitle}>ジョブはありません</Text>
              <Text style={styles.emptyHint}>ダウンロードを開始すると、ここにジョブが表示されます。</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Section headers
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  sectionCount: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
  },

  // Card
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontSize: 13, fontWeight: "700" },
  jobTime: { color: "#64748b", fontSize: 11 },
  cardBody: { marginTop: 8 },
  jobPlugin: { color: "#cbd5e1", fontSize: 14, fontWeight: "500" },
  jobMessage: { color: "#94a3b8", fontSize: 13, marginTop: 2 },

  // Progress
  progressContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  progressBar: {
    flex: 1,
    height: 8,
    backgroundColor: "#334155",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#2563eb",
    borderRadius: 4,
  },
  progressText: { color: "#94a3b8", fontSize: 12, fontWeight: "600", width: 36, textAlign: "right" },

  // Error
  errorBox: {
    backgroundColor: "#450a0a",
    borderRadius: 6,
    padding: 8,
    marginTop: 8,
  },
  errorText: { color: "#fca5a5", fontSize: 12 },

  // Cancel
  cancelBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#7f1d1d",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 10,
  },
  cancelText: { color: "#fca5a5", fontSize: 13, fontWeight: "600" },

  // Empty
  emptyContainer: { alignItems: "center", marginTop: 60 },
  emptyTitle: { color: "#94a3b8", fontSize: 16, fontWeight: "600" },
  emptyHint: { color: "#64748b", fontSize: 14, marginTop: 4, textAlign: "center", paddingHorizontal: 20 },
});
