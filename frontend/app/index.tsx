import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getLibrary, parseUrl, addToLibrary, type LibraryTitle } from "../src/api/client";

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<{ pluginId: string; titleId: string; title: string; author: string; totalVolumes: number } | null>(null);

  const { data: titles = [], isLoading } = useQuery({
    queryKey: ["library"],
    queryFn: getLibrary,
  });

  const parseMutation = useMutation({
    mutationFn: (inputUrl: string) => parseUrl(inputUrl),
    onSuccess: (data) => {
      if (data.titleInfo) {
        setPreview({
          pluginId: data.parsed.pluginId,
          titleId: data.parsed.titleId,
          title: data.titleInfo.title,
          author: data.titleInfo.author,
          totalVolumes: data.titleInfo.totalVolumes,
        });
        setShowPreview(true);
      }
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const addMutation = useMutation({
    mutationFn: () => addToLibrary({ url }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      setUrl("");
      setShowPreview(false);
      setPreview(null);
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const handleParse = () => {
    if (!url.trim()) return;
    parseMutation.mutate(url.trim());
  };

  const renderTitle = ({ item }: { item: LibraryTitle }) => {
    const s = item.volumeSummary;
    const progressRatio = s.total > 0 ? s.downloaded / s.total : 0;
    const progressPct = Math.round(progressRatio * 100);

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push(`/library/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
          <View style={styles.pluginBadge}>
            <Text style={styles.pluginBadgeText}>{item.pluginId}</Text>
          </View>
        </View>

        {item.author && (
          <Text style={styles.cardAuthor}>{item.author}</Text>
        )}

        {/* Progress bar */}
        <View style={styles.progressContainer}>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
          </View>
          <Text style={styles.progressLabel}>{progressPct}%</Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{s.downloaded}</Text>
            <Text style={styles.statLabel}>取得済み</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={[styles.statValue, s.available > 0 && styles.statValueHighlight]}>{s.available}</Text>
            <Text style={styles.statLabel}>取得可能</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{s.total}</Text>
            <Text style={styles.statLabel}>全巻</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* URL Input */}
      <View style={styles.inputSection}>
        <Text style={styles.inputLabel}>タイトルを追加</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="作品のURLを貼り付け..."
            placeholderTextColor="#64748b"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.parseBtn, !url.trim() && styles.parseBtnDisabled]}
            onPress={handleParse}
            disabled={parseMutation.isPending || !url.trim()}
          >
            {parseMutation.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.parseBtnText}>解析</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Preview */}
      {showPreview && preview && (
        <View style={styles.preview}>
          <Text style={styles.previewTitle}>{preview.title}</Text>
          <Text style={styles.previewMeta}>
            {preview.author} &middot; 全{preview.totalVolumes}巻 &middot; {preview.pluginId}
          </Text>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => addMutation.mutate()}
            disabled={addMutation.isPending}
          >
            {addMutation.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.addBtnText}>ライブラリに追加</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Library List */}
      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#60a5fa" />
      ) : (
        <FlatList
          data={titles}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderTitle}
          contentContainerStyle={{ paddingBottom: 20, paddingTop: 4 }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyTitle}>タイトルがありません</Text>
              <Text style={styles.emptyHint}>上のフォームに作品URLを貼り付けて追加しましょう。</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Input section
  inputSection: { marginBottom: 12 },
  inputLabel: { color: "#94a3b8", fontSize: 12, fontWeight: "600", marginBottom: 6 },
  inputRow: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    backgroundColor: "#1e293b",
    color: "#fff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#334155",
  },
  parseBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  parseBtnDisabled: { opacity: 0.5 },
  parseBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  // Preview
  preview: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#2563eb",
  },
  previewTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  previewMeta: { color: "#94a3b8", fontSize: 13, marginTop: 4 },
  addBtn: {
    backgroundColor: "#16a34a",
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 12,
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  // Card
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  cardTitle: { color: "#fff", fontSize: 15, fontWeight: "700", flex: 1 },
  pluginBadge: {
    backgroundColor: "#334155",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pluginBadgeText: { color: "#94a3b8", fontSize: 10, fontWeight: "600" },
  cardAuthor: { color: "#64748b", fontSize: 13, marginTop: 2 },

  // Progress
  progressContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  progressBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: "#334155",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#4ade80",
    borderRadius: 3,
  },
  progressLabel: { color: "#94a3b8", fontSize: 12, fontWeight: "600", width: 36, textAlign: "right" },

  // Stats
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
  },
  statItem: { flex: 1, alignItems: "center" },
  statValue: { color: "#e2e8f0", fontSize: 16, fontWeight: "700" },
  statValueHighlight: { color: "#60a5fa" },
  statLabel: { color: "#64748b", fontSize: 10, marginTop: 1 },
  statDivider: { width: 1, height: 20, backgroundColor: "#334155" },

  // Empty
  emptyContainer: { alignItems: "center", marginTop: 60 },
  emptyTitle: { color: "#94a3b8", fontSize: 16, fontWeight: "600" },
  emptyHint: { color: "#64748b", fontSize: 14, marginTop: 4, textAlign: "center" },
});
