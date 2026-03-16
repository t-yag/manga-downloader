import { useState, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Image,
  Pressable,
  ScrollView,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "../../src/toast";
import {
  getLibrary,
  getPlugins,
  parseUrl,
  addToLibrary,
  type LibraryTitle,
  type LibraryQuery,
} from "../../src/api/client";
import { PLUGIN_LABELS } from "../../src/constants";

const PAGE_SIZE = 50;

type SortOption = { key: LibraryQuery["sort"]; label: string };
const SORT_OPTIONS: SortOption[] = [
  { key: "lastAccessedAt", label: "最終アクセス順" },
  { key: "createdAt", label: "追加日順" },
  { key: "title", label: "タイトル順" },
];

/** Inline dropdown rendered as an absolutely-positioned overlay below the anchor. */
function Dropdown({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!visible) return null;
  return (
    <>
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose} />
      {/* Menu */}
      <View style={styles.dropdown}>
        <ScrollView style={{ maxHeight: 320 }} bounces={false}>
          {children}
        </ScrollView>
      </View>
    </>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");

  // Filter / sort state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedPlugin, setSelectedPlugin] = useState<string | undefined>();
  const [sort, setSort] = useState<LibraryQuery["sort"]>("lastAccessedAt");
  const [openMenu, setOpenMenu] = useState<"sort" | "plugin" | null>(null);

  // Debounce search input
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((text: string) => {
    setSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(text), 300);
  }, []);

  // Fetch plugins for filter dropdown
  const { data: plugins = [] } = useQuery({
    queryKey: ["plugins"],
    queryFn: getPlugins,
  });

  // Infinite query for library list
  const queryParams = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      pluginId: selectedPlugin,
      sort,
      limit: PAGE_SIZE,
    }),
    [debouncedSearch, selectedPlugin, sort]
  );

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: ["library", queryParams],
    queryFn: ({ pageParam = 0 }) =>
      getLibrary({ ...queryParams, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const titles = useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data]
  );
  const total = data?.pages[0]?.total ?? 0;

  // Refetch when screen regains focus (e.g. navigating back from detail)
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  // Add title mutations
  const addMutation = useMutation({
    mutationFn: (inputUrl: string) => addToLibrary({ url: inputUrl }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      setUrl("");
      router.push(`/library/${data.id}`);
      toast.success("ライブラリに追加しました", { description: data.title });
    },
    onError: (err: Error) =>
      toast.error("追加に失敗しました", { description: err.message }),
  });

  const parseMutation = useMutation({
    mutationFn: (inputUrl: string) => parseUrl(inputUrl),
    onSuccess: (data) => {
      const existing = titles.find(
        (t) =>
          t.pluginId === data.parsed.pluginId &&
          t.titleId === data.parsed.titleId
      );
      if (existing) {
        setUrl("");
        router.push(`/library/${existing.id}`);
        toast.info("登録済みのタイトルです", { description: existing.title });
        return;
      }
      addMutation.mutate(url.trim());
    },
    onError: (err: Error) =>
      toast.error("URL解析に失敗しました", { description: err.message }),
  });

  const handleAdd = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    parseMutation.mutate(trimmed);
  };

  const isPending = parseMutation.isPending || addMutation.isPending;

  const sortLabel =
    SORT_OPTIONS.find((o) => o.key === sort)?.label ?? "ソート";
  const pluginLabel = selectedPlugin
    ? PLUGIN_LABELS[selectedPlugin] ?? selectedPlugin
    : "ソース";

  const renderTitle = ({ item }: { item: LibraryTitle }) => {
    const { volumeSummary: vs } = item;
    const progress = vs.total > 0 ? `${vs.downloaded}/${vs.total}` : null;
    const isSeries = item.contentType === "series";

    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() => router.push(`/library/${item.id}`)}
        activeOpacity={0.7}
      >
        {/* Cover */}
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.cover} />
        ) : (
          <View style={styles.coverEmpty}>
            <Ionicons name="book" size={16} color="#475569" />
          </View>
        )}

        {/* Content */}
        <View style={styles.rowContent}>
          <View style={styles.rowTopLine}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {progress && <Text style={styles.rowProgress}>{progress}</Text>}
          </View>
          <View style={styles.rowBadges}>
            <View style={styles.pluginBadge}>
              <Text style={styles.pluginBadgeText}>
                {PLUGIN_LABELS[item.pluginId] ?? item.pluginId}
              </Text>
            </View>
            <View
              style={[
                styles.typeBadge,
                isSeries ? styles.typeBadgeSeries : styles.typeBadgeStandalone,
              ]}
            >
              <Ionicons
                name={isSeries ? "library-outline" : "document-outline"}
                size={9}
                color={isSeries ? "#a78bfa" : "#fbbf24"}
              />
              <Text
                style={[
                  styles.typeBadgeText,
                  isSeries
                    ? styles.typeBadgeSeriesText
                    : styles.typeBadgeStandaloneText,
                ]}
              >
                {isSeries ? "シリーズ" : "単巻"}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
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

      {/* Filter / Sort bar */}
      <View style={styles.filterRow}>
        <View style={styles.searchBox}>
          <Ionicons
            name="search"
            size={14}
            color="#64748b"
            style={{ marginRight: 6 }}
          />
          <TextInput
            style={styles.searchInput}
            placeholder="タイトル検索..."
            placeholderTextColor="#475569"
            value={search}
            onChangeText={handleSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setSearch("");
                setDebouncedSearch("");
              }}
            >
              <Ionicons name="close-circle" size={14} color="#475569" />
            </TouchableOpacity>
          )}
        </View>

        {/* Plugin filter button + dropdown */}
        <View style={{ position: "relative" }}>
          <TouchableOpacity
            style={[styles.filterBtn, selectedPlugin && styles.filterBtnActive]}
            onPress={() =>
              setOpenMenu((m) => (m === "plugin" ? null : "plugin"))
            }
          >
            <Ionicons name="funnel-outline" size={13} color={selectedPlugin ? "#60a5fa" : "#94a3b8"} />
            <Text
              style={[styles.filterBtnText, selectedPlugin && styles.filterBtnTextActive]}
              numberOfLines={1}
            >
              {pluginLabel}
            </Text>
          </TouchableOpacity>
          <Dropdown
            visible={openMenu === "plugin"}
            onClose={() => setOpenMenu(null)}
          >
            <DropdownItem
              label="すべて"
              selected={!selectedPlugin}
              onPress={() => {
                setSelectedPlugin(undefined);
                setOpenMenu(null);
              }}
            />
            {plugins.map((p) => (
              <DropdownItem
                key={p.id}
                label={PLUGIN_LABELS[p.id] ?? p.name}
                selected={selectedPlugin === p.id}
                onPress={() => {
                  setSelectedPlugin(p.id);
                  setOpenMenu(null);
                }}
              />
            ))}
          </Dropdown>
        </View>

        {/* Sort button + dropdown */}
        <View style={{ position: "relative" }}>
          <TouchableOpacity
            style={styles.filterBtn}
            onPress={() =>
              setOpenMenu((m) => (m === "sort" ? null : "sort"))
            }
          >
            <Ionicons name="swap-vertical-outline" size={13} color="#94a3b8" />
            <Text style={styles.filterBtnText} numberOfLines={1}>
              {sortLabel}
            </Text>
          </TouchableOpacity>
          <Dropdown
            visible={openMenu === "sort"}
            onClose={() => setOpenMenu(null)}
          >
            {SORT_OPTIONS.map((opt) => (
              <DropdownItem
                key={opt.key}
                label={opt.label}
                selected={sort === opt.key}
                onPress={() => {
                  setSort(opt.key);
                  setOpenMenu(null);
                }}
              />
            ))}
          </Dropdown>
        </View>
      </View>

      {/* Result count */}
      {!isLoading && (
        <Text style={styles.resultCount}>{total}件</Text>
      )}

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
          contentContainerStyle={{ paddingBottom: 20 }}
          onEndReached={handleEndReached}
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
            isFetchingNextPage ? (
              <ActivityIndicator
                style={{ paddingVertical: 16 }}
                color="#60a5fa"
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons
                name="library-outline"
                size={48}
                color="#334155"
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.emptyTitle}>
                {debouncedSearch || selectedPlugin
                  ? "該当するタイトルがありません"
                  : "ライブラリは空です"}
              </Text>
              {!debouncedSearch && !selectedPlugin && (
                <Text style={styles.emptyHint}>
                  上のURLフィールドから作品を追加して始めましょう
                </Text>
              )}
            </View>
          }
        />
      )}
    </View>
  );
}

function DropdownItem({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.dropdownItem, selected && styles.dropdownItemActive]}
      onPress={onPress}
    >
      <Text
        style={[
          styles.dropdownItemText,
          selected && styles.dropdownItemTextActive,
        ]}
      >
        {label}
      </Text>
      {selected && (
        <Ionicons name="checkmark" size={15} color="#60a5fa" />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Add row
  addRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
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

  // Filter row
  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 6,
    alignItems: "center",
    zIndex: 10,
  },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 34,
  },
  searchInput: {
    flex: 1,
    color: "#e2e8f0",
    fontSize: 13,
    paddingVertical: 0,
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 34,
  },
  filterBtnActive: {
    backgroundColor: "#1e3a5f",
  },
  filterBtnText: {
    color: "#94a3b8",
    fontSize: 12,
  },
  filterBtnTextActive: {
    color: "#60a5fa",
  },

  // Dropdown
  backdrop: {
    position: "absolute",
    top: -1000,
    left: -1000,
    right: -1000,
    bottom: -1000,
    zIndex: 99,
  },
  dropdown: {
    position: "absolute",
    top: 38,
    right: 0,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#334155",
    minWidth: 180,
    zIndex: 100,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  dropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dropdownItemActive: {
    backgroundColor: "#334155",
  },
  dropdownItemText: {
    color: "#94a3b8",
    fontSize: 13,
  },
  dropdownItemTextActive: {
    color: "#f1f5f9",
    fontWeight: "600",
  },

  // Result count
  resultCount: {
    color: "#475569",
    fontSize: 11,
    marginBottom: 4,
  },

  // Compact row
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
    gap: 10,
  },
  cover: {
    width: 32,
    height: 44,
    borderRadius: 4,
    backgroundColor: "#0f172a",
  },
  coverEmpty: {
    width: 32,
    height: 44,
    backgroundColor: "#0f172a",
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    gap: 4,
  },
  rowTopLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowTitle: {
    flex: 1,
    color: "#f1f5f9",
    fontSize: 14,
    fontWeight: "600",
  },
  rowProgress: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  rowBadges: {
    flexDirection: "row",
    gap: 5,
  },
  pluginBadge: {
    backgroundColor: "#334155",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  pluginBadgeText: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "600",
  },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  typeBadgeSeries: { backgroundColor: "#2e1065" },
  typeBadgeStandalone: { backgroundColor: "#422006" },
  typeBadgeText: { fontSize: 10, fontWeight: "600" },
  typeBadgeSeriesText: { color: "#a78bfa" },
  typeBadgeStandaloneText: { color: "#fbbf24" },

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
