import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Image,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner-native";
import { getLibrary, parseUrl, addToLibrary, type LibraryTitle } from "../../src/api/client";
import { PLUGIN_LABELS } from "../../src/constants";

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: "キャンセル", style: "cancel" },
      { text: "追加", onPress: onConfirm },
    ]);
  }
}

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");

  const { data: titles = [], isLoading, refetch } = useQuery({
    queryKey: ["library"],
    queryFn: getLibrary,
  });

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const addMutation = useMutation({
    mutationFn: (inputUrl: string) => addToLibrary({ url: inputUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      setUrl("");
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const parseMutation = useMutation({
    mutationFn: (inputUrl: string) => parseUrl(inputUrl),
    onSuccess: (data) => {
      const existing = titles.find(
        (t) => t.pluginId === data.parsed.pluginId && t.titleId === data.parsed.titleId
      );
      if (existing) {
        if (Platform.OS === "web") {
          if (window.confirm(`「${existing.title}」はすでに登録されています。\nライブラリに移動しますか？`)) {
            router.push(`/library/${existing.id}`);
          }
        } else {
          Alert.alert(
            "すでに登録されています",
            `「${existing.title}」はすでにライブラリに登録されています。`,
            [
              { text: "閉じる", style: "cancel" },
              { text: "移動する", onPress: () => router.push(`/library/${existing.id}`) },
            ]
          );
        }
        setUrl("");
        return;
      }

      const info = data.titleInfo;
      if (info) {
        const msg = `${info.seriesTitle}\n${info.author} / 全${info.totalVolumes}巻`;
        confirmAction("ライブラリに追加しますか？", msg, () =>
          addMutation.mutate(url.trim())
        );
      } else {
        confirmAction("タイトル情報を取得できませんでした", "そのまま追加しますか？", () =>
          addMutation.mutate(url.trim())
        );
      }
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const handleAdd = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    parseMutation.mutate(trimmed);
  };

  const isPending = parseMutation.isPending || addMutation.isPending;

  const renderTitle = ({ item }: { item: LibraryTitle }) => {
    const s = item.volumeSummary;

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push(`/library/${item.id}`)}
        activeOpacity={0.7}
      >
        <View style={styles.cardTop}>
          {/* Cover */}
          {item.coverUrl ? (
            <Image source={{ uri: item.coverUrl }} style={styles.coverImage} />
          ) : (
            <View style={styles.coverPlaceholder}>
              <Ionicons name="book" size={24} color="#475569" />
            </View>
          )}

          <View style={styles.cardInfo}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle} numberOfLines={2}>
                {item.title}
              </Text>
            </View>

            {item.author && (
              <Text style={styles.cardAuthor} numberOfLines={1}>
                {item.author}
              </Text>
            )}

            <View style={styles.cardMeta}>
              <View style={styles.pluginBadge}>
                <Text style={styles.pluginBadgeText}>{PLUGIN_LABELS[item.pluginId] ?? item.pluginId}</Text>
              </View>
              {s.available > 0 && (
                <View style={styles.availableBadge}>
                  <Text style={styles.availableBadgeText}>
                    {s.available}巻 取得可能
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>

      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Add title */}
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="作品のURLを貼り付け..."
          placeholderTextColor="#64748b"
          value={url}
          onChangeText={setUrl}
          onSubmitEditing={handleAdd}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
        />
        <TouchableOpacity
          style={[styles.addBtn, !url.trim() && styles.addBtnDisabled]}
          onPress={handleAdd}
          disabled={isPending || !url.trim()}
        >
          {isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="add" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      {/* Library List */}
      {isLoading ? (
        <ActivityIndicator
          style={{ marginTop: 40 }}
          size="large"
          color="#60a5fa"
        />
      ) : (
        <FlatList
          data={titles}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderTitle}
          contentContainerStyle={{ paddingBottom: 20, paddingTop: 4 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#60a5fa"
              colors={["#60a5fa"]}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons
                name="library-outline"
                size={48}
                color="#334155"
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.emptyTitle}>ライブラリは空です</Text>
              <Text style={styles.emptyHint}>
                上の「タイトルを追加」から作品URLを貼り付けて始めましょう
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

  // Add row
  addRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  addInput: {
    flex: 1,
    backgroundColor: "#1e293b",
    color: "#f1f5f9",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#334155",
  },
  addBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnDisabled: { opacity: 0.35 },

  // Card
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  cardTop: { flexDirection: "row", gap: 12 },
  coverImage: {
    width: 48,
    height: 64,
    borderRadius: 6,
    backgroundColor: "#0f172a",
  },
  coverPlaceholder: {
    width: 48,
    height: 64,
    backgroundColor: "#0f172a",
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: { flex: 1 },
  cardTitleRow: { flexDirection: "row", alignItems: "flex-start" },
  cardTitle: { color: "#f1f5f9", fontSize: 15, fontWeight: "700", flex: 1 },
  cardAuthor: { color: "#64748b", fontSize: 13, marginTop: 2 },
  cardMeta: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" },
  pluginBadge: {
    backgroundColor: "#334155",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pluginBadgeText: { color: "#94a3b8", fontSize: 10, fontWeight: "600" },
  availableBadge: {
    backgroundColor: "#172554",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  availableBadgeText: { color: "#60a5fa", fontSize: 10, fontWeight: "600" },

  // Empty
  emptyContainer: { alignItems: "center", marginTop: 80 },
  emptyTitle: { color: "#94a3b8", fontSize: 16, fontWeight: "600" },
  emptyHint: {
    color: "#64748b",
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
    paddingHorizontal: 40,
    lineHeight: 20,
  },
});
