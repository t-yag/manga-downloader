import { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getLibraryTitle,
  refreshTitle,
  checkAvailability,
  downloadVolumes,
  getAccounts,
  type Volume,
} from "../../src/api/client";

const STATUS_CONFIG: Record<string, { bg: string; fg: string; label: string }> = {
  done:         { bg: "#166534", fg: "#4ade80", label: "取得済" },
  available:    { bg: "#1e3a5f", fg: "#60a5fa", label: "取得可" },
  unavailable:  { bg: "#44403c", fg: "#a8a29e", label: "未購入" },
  queued:       { bg: "#713f12", fg: "#facc15", label: "待機中" },
  downloading:  { bg: "#7c2d12", fg: "#fb923c", label: "取得中" },
  error:        { bg: "#7f1d1d", fg: "#f87171", label: "エラー" },
  unknown:      { bg: "#334155", fg: "#94a3b8", label: "不明" },
};

export default function TitleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data: title, isLoading } = useQuery({
    queryKey: ["library", id],
    queryFn: () => getLibraryTitle(Number(id)),
    refetchInterval: (query) => {
      const vols = query.state.data?.volumes;
      if (!vols) return false;
      const hasActive = vols.some((v) => v.status === "queued" || v.status === "downloading");
      return hasActive ? 3000 : false;
    },
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: getAccounts,
  });

  // Find the account for this plugin
  const accountId = title
    ? accounts?.find((a) => a.pluginId === title.pluginId)?.id
    : undefined;

  const refreshMutation = useMutation({
    mutationFn: () => refreshTitle(Number(id)),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      Alert.alert("更新完了", `全${data.totalVolumes}巻、新規${data.newVolumes}巻`);
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const checkMutation = useMutation({
    mutationFn: () => checkAvailability(Number(id), accountId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      const avail = data.results.filter((r) => r.available).length;
      Alert.alert("チェック完了", `${data.results.length}巻中${avail}巻が取得可能です。`);
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const downloadMutation = useMutation({
    mutationFn: (vols: number[] | "available" | "all") => downloadVolumes(Number(id), vols, accountId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      Alert.alert("ダウンロード開始", `${data.jobIds.length}巻のダウンロードをキューに追加しました。`);
      setSelected(new Set());
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const toggleSelect = (vol: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vol)) next.delete(vol);
      else next.add(vol);
      return next;
    });
  };

  const selectAllAvailable = () => {
    if (!title) return;
    const avail = title.volumes.filter((v) => v.status === "available").map((v) => v.volumeNum);
    setSelected(new Set(avail));
  };

  if (isLoading || !title) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" style={{ marginTop: 40 }} color="#60a5fa" />
      </View>
    );
  }

  const volumes = title.volumes.sort((a, b) => a.volumeNum - b.volumeNum);
  const downloaded = volumes.filter((v) => v.status === "done").length;
  const available = volumes.filter((v) => v.status === "available").length;

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <Text style={styles.title}>{title.title}</Text>
      <Text style={styles.meta}>
        {title.author ?? "著者不明"} &middot; {title.pluginId}
      </Text>

      {/* Summary */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{volumes.length}</Text>
          <Text style={styles.summaryLabel}>全巻</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: "#4ade80" }]}>{downloaded}</Text>
          <Text style={styles.summaryLabel}>取得済み</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: "#60a5fa" }]}>{available}</Text>
          <Text style={styles.summaryLabel}>取得可能</Text>
        </View>
      </View>

      {/* Actions */}
      <Text style={styles.sectionLabel}>操作</Text>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.actionIcon}>&#x21BB;</Text>
              <Text style={styles.actionText}>巻数を更新</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => checkMutation.mutate()}
          disabled={checkMutation.isPending}
        >
          {checkMutation.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.actionIcon}>&#x2714;</Text>
              <Text style={styles.actionText}>購入状況をチェック</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnGreen]}
          onPress={() => downloadMutation.mutate("available")}
          disabled={downloadMutation.isPending || available === 0}
        >
          {downloadMutation.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.actionIcon}>&#x2B07;</Text>
              <Text style={styles.actionText}>取得可能な巻をすべてダウンロード ({available}巻)</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Selection bar */}
      {selected.size > 0 && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionText}>{selected.size}巻を選択中</Text>
          <TouchableOpacity
            style={styles.selectionBtn}
            onPress={() => downloadMutation.mutate(Array.from(selected))}
          >
            <Text style={styles.selectionBtnText}>選択した巻をダウンロード</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Selection helpers */}
      <View style={styles.selectHelpers}>
        <TouchableOpacity onPress={selectAllAvailable}>
          <Text style={styles.linkText}>取得可能な巻をすべて選択</Text>
        </TouchableOpacity>
        {selected.size > 0 && (
          <TouchableOpacity onPress={() => setSelected(new Set())}>
            <Text style={styles.linkText}>選択を解除</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Volume Grid */}
      <Text style={styles.sectionLabel}>巻一覧</Text>
      <View style={styles.grid}>
        {volumes.map((vol) => {
          const cfg = STATUS_CONFIG[vol.status] ?? STATUS_CONFIG.unknown;
          const isSelected = selected.has(vol.volumeNum);
          return (
            <TouchableOpacity
              key={vol.id}
              style={[
                styles.volCell,
                { backgroundColor: cfg.bg },
                isSelected && styles.volSelected,
              ]}
              onPress={() => toggleSelect(vol.volumeNum)}
              activeOpacity={0.7}
            >
              <Text style={[styles.volNum, { color: cfg.fg }]}>{vol.volumeNum}</Text>
              <Text style={[styles.volStatus, { color: cfg.fg }]}>{cfg.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <View key={key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: cfg.fg }]} />
            <Text style={styles.legendText}>{cfg.label}</Text>
          </View>
        ))}
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Header
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  meta: { color: "#94a3b8", fontSize: 13, marginTop: 4 },

  // Summary
  summaryRow: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
  },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryValue: { color: "#e2e8f0", fontSize: 22, fontWeight: "700" },
  summaryLabel: { color: "#64748b", fontSize: 11, marginTop: 2 },

  // Section
  sectionLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },

  // Actions
  actions: { gap: 8 },
  actionBtn: {
    backgroundColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  actionBtnGreen: { backgroundColor: "#166534" },
  actionIcon: { color: "#fff", fontSize: 16 },
  actionText: { color: "#fff", fontSize: 14, fontWeight: "600" },

  // Selection
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1e3a5f",
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  selectionText: { color: "#93c5fd", fontSize: 14, fontWeight: "600" },
  selectionBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  selectionBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  // Select helpers
  selectHelpers: { flexDirection: "row", gap: 20, marginTop: 10 },
  linkText: { color: "#60a5fa", fontSize: 13 },

  // Volume grid
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  volCell: {
    width: 64,
    height: 52,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  volSelected: { borderWidth: 2, borderColor: "#93c5fd" },
  volNum: { fontSize: 16, fontWeight: "700" },
  volStatus: { fontSize: 9, marginTop: 1, fontWeight: "600" },

  // Legend
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 20 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: "#94a3b8", fontSize: 11 },
});
