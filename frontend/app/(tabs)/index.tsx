import { useState, useCallback, useMemo, useRef, useEffect } from "react";
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
  Keyboard,
  Platform,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
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
  getLibraryTags,
  parseUrl,
  addToLibrary,
  type LibraryTitle,
  type LibraryQuery,
} from "../../src/api/client";
import { SOURCE_LABELS, SOURCE_COLORS, DEFAULT_SOURCE_COLOR, TAB_CONTENT_PADDING } from "../../src/constants";

const PAGE_SIZE = 50;

// --- Filter/Sort persistence ---

const STORAGE_KEY = "manga-dl:library-filters";

interface PersistedFilters {
  sort: LibraryQuery["sort"];
  order: "asc" | "desc";
  pluginIds: string[];
  contentTypes: ("series" | "standalone")[];
  tags: string[];
}

const DEFAULT_FILTERS: PersistedFilters = {
  sort: "createdAt",
  order: "desc",
  pluginIds: [],
  contentTypes: [],
  tags: [],
};

function loadFilters(): PersistedFilters {
  if (Platform.OS === "web") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
    } catch {}
  }
  return DEFAULT_FILTERS;
}

function saveFilters(filters: PersistedFilters) {
  if (Platform.OS === "web") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {}
  }
}

// --- Sort options ---

type SortOption = { key: NonNullable<LibraryQuery["sort"]>; label: string; defaultOrder: "asc" | "desc" };
const SORT_OPTIONS: SortOption[] = [
  { key: "createdAt", label: "追加日順", defaultOrder: "desc" },
  { key: "lastAccessedAt", label: "最終アクセス順", defaultOrder: "desc" },
  { key: "updatedAt", label: "更新日順", defaultOrder: "desc" },
  { key: "title", label: "タイトル順", defaultOrder: "asc" },
];

// --- Content type options ---

const CONTENT_TYPE_OPTIONS: { key: "series" | "standalone"; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "series", label: "シリーズ", icon: "library-outline" },
  { key: "standalone", label: "単巻", icon: "document-outline" },
];

// --- Dropdown ---

function Dropdown({
  visible,
  onClose,
  children,
  style,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  style?: object;
}) {
  if (!visible) return null;
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.dropdown, style]}>
        <ScrollView style={{ maxHeight: 320 }} bounces={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </>
  );
}

function DropdownItem({
  label,
  selected,
  onPress,
  suffix,
  multi,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  suffix?: React.ReactNode;
  multi?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.dropdownItem, selected && styles.dropdownItemActive]}
      onPress={onPress}
    >
      {multi && (
        <Ionicons
          name={selected ? "checkbox" : "square-outline"}
          size={16}
          color={selected ? "#60a5fa" : "#475569"}
          style={{ marginRight: 8 }}
        />
      )}
      <Text
        style={[
          styles.dropdownItemText,
          selected && styles.dropdownItemTextActive,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {suffix}
        {!multi && selected && (
          <Ionicons name="checkmark" size={15} color="#60a5fa" />
        )}
      </View>
    </TouchableOpacity>
  );
}

// --- Active filter chip ---

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
      <TouchableOpacity onPress={onRemove} hitSlop={8}>
        <Ionicons name="close" size={12} color="#93c5fd" />
      </TouchableOpacity>
    </View>
  );
}

// --- Tag dropdown (chip grid) ---

function TagDropdown({
  visible,
  onClose,
  tagSearch,
  onTagSearchChange,
  allTags,
  allTagsFull,
  selectedTags,
  onToggleTag,
}: {
  visible: boolean;
  onClose: () => void;
  tagSearch: string;
  onTagSearchChange: (text: string) => void;
  allTags: { name: string; count: number }[];
  allTagsFull: { name: string; count: number }[];
  selectedTags: string[];
  onToggleTag: (name: string) => void;
}) {
  if (!visible) return null;

  // Selected tags always from full list (not affected by search)
  const selectedInList = allTagsFull.filter((t) => selectedTags.includes(t.name));
  const unselected = allTags.filter((t) => !selectedTags.includes(t.name));

  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.dropdown, styles.tagDropdown, { left: 0 }]}>
        {/* Search */}
        <View style={styles.tagSearchBox}>
          <Ionicons name="search" size={12} color="#475569" />
          <TextInput
            style={styles.tagSearchInput}
            placeholder="タグ検索..."
            placeholderTextColor="#475569"
            value={tagSearch}
            onChangeText={onTagSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {tagSearch.length > 0 && (
            <TouchableOpacity onPress={() => onTagSearchChange("")}>
              <Ionicons name="close-circle" size={12} color="#475569" />
            </TouchableOpacity>
          )}
        </View>

        <ScrollView style={{ maxHeight: 400 }} bounces={false} keyboardShouldPersistTaps="handled">
          {/* Selected tags pinned at top */}
          {selectedInList.length > 0 && (
            <View style={styles.tagSection}>
              <Text style={styles.tagSectionLabel}>選択中</Text>
              <View style={styles.tagGrid}>
                {selectedInList.map((t) => (
                  <TouchableOpacity
                    key={t.name}
                    style={[styles.tagPill, styles.tagPillSelected]}
                    onPress={() => onToggleTag(t.name)}
                  >
                    <Text style={styles.tagPillTextSelected} numberOfLines={1}>{t.name}</Text>
                    <Ionicons name="close" size={10} color="#93c5fd" />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* All / unselected tags */}
          <View style={styles.tagSection}>
            {selectedInList.length > 0 && unselected.length > 0 && (
              <Text style={styles.tagSectionLabel}>すべて</Text>
            )}
            <View style={styles.tagGrid}>
              {unselected.map((t) => (
                <TouchableOpacity
                  key={t.name}
                  style={styles.tagPill}
                  onPress={() => onToggleTag(t.name)}
                >
                  <Text style={styles.tagPillText} numberOfLines={1}>{t.name}</Text>
                  <Text style={styles.tagPillCount}>{t.count}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {allTags.length === 0 && (
              <Text style={styles.tagEmpty}>該当なし</Text>
            )}
          </View>
        </ScrollView>
      </View>
    </>
  );
}

// --- Helper: toggle value in array ---

function toggleArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

// --- Main screen ---

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    const tabBarHeight = 56;
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardOffset(e.endCoordinates.height - tabBarHeight)
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardOffset(0)
    );
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Filter / sort state (initialized from persistence)
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [persisted, setPersisted] = useState<PersistedFilters>(loadFilters);
  const [openMenu, setOpenMenu] = useState<"sort" | "plugin" | "type" | "tag" | null>(null);
  const [tagSearch, setTagSearch] = useState("");

  const { sort, order, pluginIds, contentTypes, tags: selectedTags } = persisted;

  const updateFilters = useCallback((patch: Partial<PersistedFilters>) => {
    setPersisted((prev) => {
      const next = { ...prev, ...patch };
      saveFilters(next);
      return next;
    });
  }, []);

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

  // Fetch available tags
  const { data: tagsData } = useQuery({
    queryKey: ["library-tags"],
    queryFn: getLibraryTags,
  });
  const allTags = tagsData?.tags ?? [];

  const filteredTags = useMemo(() => {
    if (!tagSearch) return allTags;
    const q = tagSearch.toLowerCase();
    return allTags.filter((g) => g.name.toLowerCase().includes(q));
  }, [allTags, tagSearch]);

  // Infinite query for library list
  const queryParams = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      pluginIds: pluginIds.length > 0 ? pluginIds : undefined,
      contentTypes: contentTypes.length > 0 ? contentTypes : undefined,
      tags: selectedTags.length > 0 ? selectedTags : undefined,
      sort,
      order,
      limit: PAGE_SIZE,
    }),
    [debouncedSearch, pluginIds, contentTypes, selectedTags, sort, order]
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
      router.push(`/library/${data.id}?autoSync=true`);
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

  const handleAdd = async () => {
    let trimmed = url.trim();
    if (!trimmed) {
      try {
        const clip = await Clipboard.getStringAsync();
        trimmed = clip?.trim() ?? "";
      } catch {
        // clipboard access denied
      }
      if (!trimmed) return;
      setUrl(trimmed);
    }
    parseMutation.mutate(trimmed);
  };

  const isPending = parseMutation.isPending || addMutation.isPending;

  // Labels (fixed text to prevent layout shift when selecting)
  const sortOption = SORT_OPTIONS.find((o) => o.key === sort) ?? SORT_OPTIONS[0];
  const sortLabel = sortOption.label;

  // Active filters for chips
  const hasFilters = pluginIds.length > 0 || contentTypes.length > 0 || selectedTags.length > 0;
  const activeChips: { key: string; label: string; onRemove: () => void }[] = [];
  for (const pid of pluginIds) {
    activeChips.push({
      key: `plugin:${pid}`,
      label: SOURCE_LABELS[pid] ?? pid,
      onRemove: () => updateFilters({ pluginIds: pluginIds.filter((id) => id !== pid) }),
    });
  }
  for (const ct of contentTypes) {
    activeChips.push({
      key: `type:${ct}`,
      label: ct === "series" ? "シリーズ" : "単巻",
      onRemove: () => updateFilters({ contentTypes: contentTypes.filter((t) => t !== ct) }),
    });
  }
  for (const tag of selectedTags) {
    activeChips.push({
      key: `tag:${tag}`,
      label: tag,
      onRemove: () => updateFilters({ tags: selectedTags.filter((t) => t !== tag) }),
    });
  }

  const handleSortSelect = (key: NonNullable<LibraryQuery["sort"]>) => {
    if (sort === key) {
      updateFilters({ order: order === "asc" ? "desc" : "asc" });
    } else {
      const opt = SORT_OPTIONS.find((o) => o.key === key)!;
      updateFilters({ sort: key, order: opt.defaultOrder });
    }
    setOpenMenu(null);
  };

  const clearAllFilters = () => {
    updateFilters({ pluginIds: [], contentTypes: [], tags: [] });
  };

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
        {item.coverUrl ? (
          <Image source={{ uri: item.coverUrl }} style={styles.cover} />
        ) : (
          <View style={styles.coverEmpty}>
            <Ionicons name="book" size={16} color="#475569" />
          </View>
        )}

        <View style={styles.rowContent}>
          <View style={styles.rowTopLine}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {progress && <Text style={styles.rowProgress}>{progress}</Text>}
          </View>
          <View style={styles.rowBadges}>
            <View style={[styles.pluginBadge, { backgroundColor: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).bg }]}>
              <Text style={[styles.pluginBadgeText, { color: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).text }]}>
                {SOURCE_LABELS[item.pluginId] ?? item.pluginId}
              </Text>
            </View>
            <View style={styles.typeBadge}>
              <Ionicons
                name={isSeries ? "library-outline" : "document-outline"}
                size={9}
                color="#64748b"
              />
              <Text style={styles.typeBadgeText}>
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
    <View style={[styles.container, { paddingTop: insets.top + TAB_CONTENT_PADDING }, keyboardOffset > 0 && { paddingBottom: keyboardOffset }]}>
      <View style={{ flex: 1 }}>
        {/* Search + Sort bar */}
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
              <Ionicons
                name={order === "asc" ? "arrow-up" : "arrow-down"}
                size={10}
                color="#64748b"
              />
            </TouchableOpacity>
            <Dropdown
              visible={openMenu === "sort"}
              onClose={() => setOpenMenu(null)}
              style={{ right: 0 }}
            >
              {SORT_OPTIONS.map((opt) => (
                <DropdownItem
                  key={opt.key}
                  label={opt.label}
                  selected={sort === opt.key}
                  onPress={() => handleSortSelect(opt.key)}
                  suffix={
                    sort === opt.key ? (
                      <Ionicons
                        name={order === "asc" ? "arrow-up" : "arrow-down"}
                        size={12}
                        color="#60a5fa"
                      />
                    ) : null
                  }
                />
              ))}
            </Dropdown>
          </View>
        </View>

        {/* Filter buttons row */}
        <View style={styles.filterRow2}>
          {/* Plugin filter (multi) */}
          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, pluginIds.length > 0 && styles.filterBtn2Active]}
              onPress={() =>
                setOpenMenu((m) => (m === "plugin" ? null : "plugin"))
              }
            >
              <Ionicons name="layers-outline" size={12} color={pluginIds.length > 0 ? "#60a5fa" : "#64748b"} />
              <Text style={[styles.filterBtn2Text, pluginIds.length > 0 && styles.filterBtn2TextActive]}>
                データソース
              </Text>
            </TouchableOpacity>
            <Dropdown
              visible={openMenu === "plugin"}
              onClose={() => setOpenMenu(null)}
              style={{ left: 0 }}
            >
              {plugins.map((p) => (
                <DropdownItem
                  key={p.id}
                  label={SOURCE_LABELS[p.id] ?? p.name}
                  selected={pluginIds.includes(p.id)}
                  onPress={() => updateFilters({ pluginIds: toggleArray(pluginIds, p.id) })}
                  multi
                />
              ))}
            </Dropdown>
          </View>

          {/* Content type filter (multi) */}
          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, contentTypes.length > 0 && styles.filterBtn2Active]}
              onPress={() =>
                setOpenMenu((m) => (m === "type" ? null : "type"))
              }
            >
              <Ionicons name="albums-outline" size={12} color={contentTypes.length > 0 ? "#60a5fa" : "#64748b"} />
              <Text style={[styles.filterBtn2Text, contentTypes.length > 0 && styles.filterBtn2TextActive]}>
                タイプ
              </Text>
            </TouchableOpacity>
            <Dropdown
              visible={openMenu === "type"}
              onClose={() => setOpenMenu(null)}
              style={{ left: 0 }}
            >
              {CONTENT_TYPE_OPTIONS.map((opt) => (
                <DropdownItem
                  key={opt.key}
                  label={opt.label}
                  selected={contentTypes.includes(opt.key)}
                  onPress={() => updateFilters({ contentTypes: toggleArray(contentTypes, opt.key) })}
                  multi
                />
              ))}
            </Dropdown>
          </View>

          {/* Tag filter (multi) */}
          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, selectedTags.length > 0 && styles.filterBtn2Active]}
              onPress={() => {
                setTagSearch("");
                setOpenMenu((m) => (m === "tag" ? null : "tag"));
              }}
            >
              <Ionicons name="pricetag-outline" size={12} color={selectedTags.length > 0 ? "#60a5fa" : "#64748b"} />
              <Text style={[styles.filterBtn2Text, selectedTags.length > 0 && styles.filterBtn2TextActive]}>
                タグ
              </Text>
            </TouchableOpacity>
            <TagDropdown
              visible={openMenu === "tag"}
              onClose={() => setOpenMenu(null)}
              tagSearch={tagSearch}
              onTagSearchChange={setTagSearch}
              allTags={filteredTags}
              allTagsFull={allTags}
              selectedTags={selectedTags}
              onToggleTag={(name) => updateFilters({ tags: toggleArray(selectedTags, name) })}
            />
          </View>
        </View>

        {/* Active filter chips */}
        {hasFilters && (
          <View style={styles.chipRow}>
            {activeChips.map((c) => (
              <FilterChip key={c.key} label={c.label} onRemove={c.onRemove} />
            ))}
            {activeChips.length >= 2 && (
              <TouchableOpacity onPress={clearAllFilters} style={styles.clearAllBtn}>
                <Text style={styles.clearAllText}>すべて解除</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

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
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
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
                  {debouncedSearch || hasFilters
                    ? "該当するタイトルがありません"
                    : "ライブラリは空です"}
                </Text>
                {!debouncedSearch && !hasFilters && (
                  <Text style={styles.emptyHint}>
                    下のURLフィールドから作品を追加して始めましょう
                  </Text>
                )}
              </View>
            }
          />
        )}
      </View>

      {/* Bottom: Add URL bar */}
      <View style={[styles.addRow, { paddingBottom: insets.bottom }]}>
        <TextInput
          style={styles.addInput}
          placeholder="URLを入力 (空なら📋から読み取り)"
          placeholderTextColor="#64748b"
          value={url}
          onChangeText={setUrl}
          onSubmitEditing={handleAdd}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
        />
        <TouchableOpacity
          style={[styles.addBtn, isPending && styles.addBtnDisabled]}
          onPress={handleAdd}
          disabled={isPending}
        >
          {isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="add" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Add row (bottom-fixed)
  addRow: {
    flexDirection: "row",
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
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
    outlineStyle: "none",
  } as any,
  addBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnDisabled: { opacity: 0.35 },

  // Filter row (search + sort)
  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 4,
    alignItems: "center",
    zIndex: 11,
  },
  // Filter row 2 (plugin, type, tag)
  filterRow2: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 4,
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
    outlineStyle: "none",
  } as any,
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1e293b",
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 34,
  },
  filterBtnText: {
    color: "#94a3b8",
    fontSize: 12,
  },
  // Compact filter buttons (second row)
  filterBtn2: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1e293b",
    borderRadius: 6,
    paddingHorizontal: 8,
    height: 28,
  },
  filterBtn2Active: {
    backgroundColor: "#1e3a5f",
  },
  filterBtn2Text: {
    color: "#94a3b8",
    fontSize: 11,
  },
  filterBtn2TextActive: {
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
    top: 32,
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
    flex: 1,
  },
  dropdownItemTextActive: {
    color: "#f1f5f9",
    fontWeight: "600",
  },

  // Tag dropdown (wider, chip grid)
  tagDropdown: {
    minWidth: 280,
    maxWidth: 360,
  },
  tagSearchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    margin: 8,
    marginBottom: 4,
    backgroundColor: "#0f172a",
    borderRadius: 6,
    paddingHorizontal: 8,
    height: 30,
  },
  tagSearchInput: {
    flex: 1,
    color: "#e2e8f0",
    fontSize: 12,
    paddingVertical: 0,
    outlineStyle: "none",
  } as any,
  tagSection: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  tagSectionLabel: {
    color: "#475569",
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tagGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  tagPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#0f172a",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tagPillSelected: {
    backgroundColor: "#1e3a5f",
  },
  tagPillText: {
    color: "#94a3b8",
    fontSize: 11,
    maxWidth: 140,
  },
  tagPillTextSelected: {
    color: "#93c5fd",
    fontSize: 11,
    maxWidth: 140,
  },
  tagPillCount: {
    color: "#475569",
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  tagEmpty: {
    color: "#475569",
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 12,
  },

  // Active filter chips
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 4,
    alignItems: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#1e3a5f",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    color: "#93c5fd",
    fontSize: 11,
    maxWidth: 120,
  },
  clearAllBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  clearAllText: {
    color: "#475569",
    fontSize: 11,
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
  typeBadgeText: { fontSize: 10, fontWeight: "600", color: "#64748b" },

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
