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
  Dimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useFocusEffect, Link } from "expo-router";
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
import { colors, spacing, radius, typography, coverShadow } from "../../src/theme";

const PAGE_SIZE = 50;

// --- View mode ---

type ViewMode = "grid" | "list";

// --- Filter/Sort persistence ---

const STORAGE_KEY = "manga-dl:library-filters";
const VIEW_MODE_KEY = "manga-dl:view-mode";

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

function loadViewMode(): ViewMode {
  if (Platform.OS === "web") {
    try {
      return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || "grid";
    } catch {}
  }
  return "grid";
}

function saveViewMode(mode: ViewMode) {
  if (Platform.OS === "web") {
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
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
          color={selected ? colors.accentLight : colors.textDim}
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
          <Ionicons name="checkmark" size={15} color={colors.accentLight} />
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
        <Ionicons name="close" size={12} color={colors.accentPale} />
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

  const selectedInList = allTagsFull.filter((t) => selectedTags.includes(t.name));
  const unselected = allTags.filter((t) => !selectedTags.includes(t.name));

  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.dropdown, styles.tagDropdown, { left: 0 }]}>
        <View style={styles.tagSearchBox}>
          <Ionicons name="search" size={12} color={colors.textDim} />
          <TextInput
            style={styles.tagSearchInput}
            placeholder="タグ検索..."
            placeholderTextColor={colors.textDim}
            value={tagSearch}
            onChangeText={onTagSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {tagSearch.length > 0 && (
            <TouchableOpacity onPress={() => onTagSearchChange("")}>
              <Ionicons name="close-circle" size={12} color={colors.textDim} />
            </TouchableOpacity>
          )}
        </View>

        <ScrollView style={{ maxHeight: 400 }} bounces={false} keyboardShouldPersistTaps="handled">
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
                    <Ionicons name="close" size={10} color={colors.accentPale} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

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

// --- Helper ---

function toggleArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

// --- Cover placeholder with gradient ---

function CoverPlaceholder({ title, index, size }: { title: string; index: number; size: "grid" | "list" }) {
  const gradient = colors.gradients[index % colors.gradients.length];
  const isGrid = size === "grid";
  return (
    <LinearGradient
      colors={gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={isGrid ? styles.gridCoverPlaceholder : styles.listCoverPlaceholder}
    >
      <Ionicons name="book" size={isGrid ? 24 : 14} color="rgba(255,255,255,0.2)" style={{ marginBottom: isGrid ? 4 : 0 }} />
      {isGrid && (
        <Text style={styles.gridPlaceholderText} numberOfLines={2}>{title}</Text>
      )}
    </LinearGradient>
  );
}

// --- Grid item ---

function GridItem({ item, index, onPress, columnWidth }: { item: LibraryTitle; index: number; onPress: () => void; columnWidth: number }) {
  const { volumeSummary: vs } = item;
  const progress = vs.total > 0 ? vs.downloaded / vs.total : 0;
  const hasProgress = vs.total > 0;
  const coverHeight = columnWidth * 1.42;

  return (
    <TouchableOpacity
      style={[styles.gridItem, { width: columnWidth }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={[styles.gridCoverWrap, { height: coverHeight }]}>
        {item.coverUrl ? (
          <Image
            source={{ uri: item.coverUrl }}
            style={[styles.gridCover, { height: coverHeight }]}
          />
        ) : (
          <CoverPlaceholder title={item.title} index={index} size="grid" />
        )}

        {/* Download count badge */}
        {hasProgress && (
          <View style={styles.gridCountBadge}>
            <Text style={styles.gridCountText}>{vs.downloaded}/{vs.total}</Text>
          </View>
        )}

        {/* Source badge */}
        <View style={[styles.gridSourceBadge, { backgroundColor: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).bg + "dd" }]}>
          <Text style={[styles.gridSourceText, { color: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).text }]}>
            {SOURCE_LABELS[item.pluginId] ?? item.pluginId}
          </Text>
        </View>
      </View>

      <Text style={styles.gridTitle} numberOfLines={2}>{item.title}</Text>
    </TouchableOpacity>
  );
}

// --- List item ---

function ListItem({ item, index, onPress }: { item: LibraryTitle; index: number; onPress: () => void }) {
  const { volumeSummary: vs } = item;
  const progress = vs.total > 0 ? `${vs.downloaded}/${vs.total}` : null;
  const isSeries = item.contentType === "series";

  return (
    <TouchableOpacity
      style={styles.listRow}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {item.coverUrl ? (
        <Image source={{ uri: item.coverUrl }} style={styles.listCover} />
      ) : (
        <CoverPlaceholder title={item.title} index={index} size="list" />
      )}

      <View style={styles.listRowContent}>
        <View style={styles.listRowTopLine}>
          <Text style={styles.listRowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {progress && <Text style={styles.listRowProgress}>{progress}</Text>}
        </View>
        <View style={styles.listRowBadges}>
          <View style={[styles.listPluginBadge, { backgroundColor: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).bg }]}>
            <Text style={[styles.listPluginBadgeText, { color: (SOURCE_COLORS[item.pluginId] ?? DEFAULT_SOURCE_COLOR).text }]}>
              {SOURCE_LABELS[item.pluginId] ?? item.pluginId}
            </Text>
          </View>
          <View style={styles.listTypeBadge}>
            <Ionicons
              name={isSeries ? "library-outline" : "document-outline"}
              size={9}
              color={colors.textMuted}
            />
            <Text style={styles.listTypeBadgeText}>
              {isSeries ? "シリーズ" : "単巻"}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// --- Main screen ---

export default function LibraryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

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

  // Filter / sort state
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((text: string) => {
    setSearch(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(text), 300);
  }, []);

  const { data: plugins = [] } = useQuery({
    queryKey: ["plugins"],
    queryFn: getPlugins,
  });

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
    isError,
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
      } catch {}
      if (!trimmed) return;
      setUrl(trimmed);
    }
    parseMutation.mutate(trimmed);
  };

  const isPending = parseMutation.isPending || addMutation.isPending;

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

  const toggleViewMode = () => {
    const next = viewMode === "grid" ? "list" : "grid";
    setViewMode(next);
    saveViewMode(next);
  };

  // Grid: target item width ~110px, auto-calculate column count (like CSS auto-fill minmax)
  const gridGap = spacing.sm;
  const TARGET_ITEM_WIDTH = 130;
  const MIN_COLUMNS = 3;

  const calcColumns = (w: number) =>
    Math.max(MIN_COLUMNS, Math.floor((w + gridGap) / (TARGET_ITEM_WIDTH + gridGap)));

  // Use measured width if available; hide grid until measured to avoid resize flicker
  const measured = containerWidth != null;
  const effectiveWidth = containerWidth ?? 0;
  const numColumns = viewMode === "grid" ? calcColumns(effectiveWidth) : 1;
  const columnWidth = viewMode === "grid" && effectiveWidth > 0
    ? (effectiveWidth - gridGap * (numColumns - 1)) / numColumns
    : TARGET_ITEM_WIDTH;

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  // Prevent double-tap navigation
  const navigatingRef = useRef(false);
  useFocusEffect(useCallback(() => { navigatingRef.current = false; }, []));
  const navigateTo = useCallback((id: number) => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    router.push(`/library/${id}`);
  }, [router]);

  const renderGridItem = ({ item, index }: { item: LibraryTitle; index: number }) => (
    <GridItem
      item={item}
      index={index}
      onPress={() => navigateTo(item.id)}
      columnWidth={columnWidth}
    />
  );

  const renderListItem = ({ item, index }: { item: LibraryTitle; index: number }) => (
    <ListItem
      item={item}
      index={index}
      onPress={() => navigateTo(item.id)}
    />
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + TAB_CONTENT_PADDING }, keyboardOffset > 0 && { paddingBottom: keyboardOffset }]}>
      <View
        style={{ flex: 1 }}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setContainerWidth((prev) => {
            // Ignore transient small values during Stack screen transitions
            if (prev !== null && w < prev * 0.5) return prev;
            return w;
          });
        }}
      >
        {/* Search + Sort + View toggle */}
        <View style={styles.filterRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={14} color={colors.textMuted} style={{ marginRight: 6 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="タイトル検索..."
              placeholderTextColor={colors.textDim}
              value={search}
              onChangeText={handleSearchChange}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => { setSearch(""); setDebouncedSearch(""); }}>
                <Ionicons name="close-circle" size={14} color={colors.textDim} />
              </TouchableOpacity>
            )}
          </View>

          {/* View mode toggle */}
          <TouchableOpacity style={styles.viewToggle} onPress={toggleViewMode}>
            <Ionicons
              name={viewMode === "grid" ? "grid" : "list"}
              size={16}
              color={colors.accentLight}
            />
          </TouchableOpacity>

          {/* Sort button + dropdown */}
          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={styles.filterBtn}
              onPress={() => setOpenMenu((m) => (m === "sort" ? null : "sort"))}
            >
              <Ionicons name="swap-vertical-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.filterBtnText} numberOfLines={1}>{sortLabel}</Text>
              <Ionicons name={order === "asc" ? "arrow-up" : "arrow-down"} size={10} color={colors.textMuted} />
            </TouchableOpacity>
            <Dropdown visible={openMenu === "sort"} onClose={() => setOpenMenu(null)} style={{ right: 0 }}>
              {SORT_OPTIONS.map((opt) => (
                <DropdownItem
                  key={opt.key}
                  label={opt.label}
                  selected={sort === opt.key}
                  onPress={() => handleSortSelect(opt.key)}
                  suffix={
                    sort === opt.key ? (
                      <Ionicons name={order === "asc" ? "arrow-up" : "arrow-down"} size={12} color={colors.accentLight} />
                    ) : null
                  }
                />
              ))}
            </Dropdown>
          </View>
        </View>

        {/* Filter buttons row */}
        <View style={styles.filterRow2}>
          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, pluginIds.length > 0 && styles.filterBtn2Active]}
              onPress={() => setOpenMenu((m) => (m === "plugin" ? null : "plugin"))}
            >
              <Ionicons name="layers-outline" size={12} color={pluginIds.length > 0 ? colors.accentLight : colors.textMuted} />
              <Text style={[styles.filterBtn2Text, pluginIds.length > 0 && styles.filterBtn2TextActive]}>
                データソース
              </Text>
            </TouchableOpacity>
            <Dropdown visible={openMenu === "plugin"} onClose={() => setOpenMenu(null)} style={{ left: 0 }}>
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

          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, contentTypes.length > 0 && styles.filterBtn2Active]}
              onPress={() => setOpenMenu((m) => (m === "type" ? null : "type"))}
            >
              <Ionicons name="albums-outline" size={12} color={contentTypes.length > 0 ? colors.accentLight : colors.textMuted} />
              <Text style={[styles.filterBtn2Text, contentTypes.length > 0 && styles.filterBtn2TextActive]}>
                タイプ
              </Text>
            </TouchableOpacity>
            <Dropdown visible={openMenu === "type"} onClose={() => setOpenMenu(null)} style={{ left: 0 }}>
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

          <View style={{ position: "relative" }}>
            <TouchableOpacity
              style={[styles.filterBtn2, selectedTags.length > 0 && styles.filterBtn2Active]}
              onPress={() => { setTagSearch(""); setOpenMenu((m) => (m === "tag" ? null : "tag")); }}
            >
              <Ionicons name="pricetag-outline" size={12} color={selectedTags.length > 0 ? colors.accentLight : colors.textMuted} />
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

        {/* Library List / Grid */}
        {isLoading || !measured ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : (
          <FlatList
            key={`${viewMode}-${numColumns}`}
            data={titles}
            keyExtractor={(item) => String(item.id)}
            renderItem={viewMode === "grid" ? renderGridItem : renderListItem}
            numColumns={viewMode === "grid" ? numColumns : 1}
            columnWrapperStyle={viewMode === "grid" ? styles.gridRow : undefined}
            contentContainerStyle={{ paddingBottom: 20 }}
            initialNumToRender={30}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.accent}
                colors={[colors.accent]}
              />
            }
            ListFooterComponent={
              isFetchingNextPage ? (
                <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.accent} />
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                {isError ? (
                  <>
                    <View style={styles.emptyIconWrap}>
                      <Ionicons name="cloud-offline-outline" size={48} color={colors.borderAccent} />
                    </View>
                    <Text style={styles.emptyTitle}>サーバーに接続できません</Text>
                    <Text style={styles.emptyHint}>
                      設定画面でサーバーURLを確認してください
                    </Text>
                    <Link href="/settings" asChild>
                      <TouchableOpacity style={styles.emptySettingsBtn}>
                        <Ionicons name="settings-outline" size={14} color={colors.accentLight} />
                        <Text style={styles.emptySettingsBtnText}>設定を開く</Text>
                      </TouchableOpacity>
                    </Link>
                  </>
                ) : (
                  <>
                    <View style={styles.emptyIconWrap}>
                      <Ionicons name="library-outline" size={48} color={colors.borderAccent} />
                    </View>
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
                  </>
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
          placeholder="URL (未入力ならクリップボードを使用)"
          placeholderTextColor={colors.textMuted}
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
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Ionicons name="add" size={20} color={colors.white} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },

  // Add row
  addRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  addInput: {
    flex: 1,
    backgroundColor: colors.bgCard,
    color: colors.textPrimary,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
    outlineStyle: "none",
  } as any,
  addBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    width: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnDisabled: { opacity: 0.35 },

  // Filter row
  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 4,
    alignItems: "center",
    zIndex: 11,
  },
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
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    height: 34,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 0,
    outlineStyle: "none",
  } as any,
  viewToggle: {
    width: 34,
    height: 34,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    height: 34,
  },
  filterBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  filterBtn2: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    height: 28,
  },
  filterBtn2Active: {
    backgroundColor: colors.accentDim,
  },
  filterBtn2Text: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  filterBtn2TextActive: {
    color: colors.accentLight,
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
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    minWidth: 180,
    zIndex: 100,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
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
    backgroundColor: colors.bgCardHover,
  },
  dropdownItemText: {
    color: colors.textSecondary,
    fontSize: 13,
    flex: 1,
  },
  dropdownItemTextActive: {
    color: colors.textPrimary,
    fontWeight: "600",
  },

  // Tag dropdown
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
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    height: 30,
  },
  tagSearchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    paddingVertical: 0,
    outlineStyle: "none",
  } as any,
  tagSection: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  tagSectionLabel: {
    color: colors.textDim,
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
    backgroundColor: colors.bg,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  tagPillSelected: {
    backgroundColor: colors.accentDim,
  },
  tagPillText: {
    color: colors.textSecondary,
    fontSize: 11,
    maxWidth: 140,
  },
  tagPillTextSelected: {
    color: colors.accentPale,
    fontSize: 11,
    maxWidth: 140,
  },
  tagPillCount: {
    color: colors.textDim,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  tagEmpty: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 12,
  },

  // Chips
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
    backgroundColor: colors.accentDim,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: {
    color: colors.accentPale,
    fontSize: 11,
    maxWidth: 120,
  },
  clearAllBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  clearAllText: {
    color: colors.textDim,
    fontSize: 11,
  },

  // Result count
  resultCount: {
    color: colors.textDim,
    fontSize: 11,
    marginBottom: 6,
  },

  // === Grid view ===
  gridRow: {
    gap: spacing.sm,
  },
  gridItem: {
    marginBottom: spacing.md,
  },
  gridCoverWrap: {
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.bgCard,
    ...coverShadow,
  },
  gridCover: {
    width: "100%",
    resizeMode: "cover",
  },
  gridCoverPlaceholder: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.sm,
  },
  gridPlaceholderText: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 10,
    fontWeight: "600",
    textAlign: "center",
  },
  gridCountBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  gridCountText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  gridSourceBadge: {
    position: "absolute",
    bottom: 4,
    left: 4,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  gridSourceText: {
    fontSize: 9,
    fontWeight: "700",
  },
  gridTitle: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 5,
    lineHeight: 14,
  },

  // === List view ===
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
    gap: 10,
  },
  listCover: {
    width: 36,
    height: 50,
    borderRadius: 4,
    backgroundColor: colors.bg,
  },
  listCoverPlaceholder: {
    width: 36,
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  listRowContent: {
    flex: 1,
    gap: 4,
  },
  listRowTopLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  listRowTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  listRowProgress: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  listRowBadges: {
    flexDirection: "row",
    gap: 5,
  },
  listPluginBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  listPluginBadgeText: {
    fontSize: 10,
    fontWeight: "600",
  },
  listTypeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  listTypeBadgeText: { fontSize: 10, fontWeight: "600", color: colors.textMuted },

  // Empty
  emptyContainer: { alignItems: "center", marginTop: 80 },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.bgCard,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle: { color: colors.textSecondary, fontSize: 16, fontWeight: "600" },
  emptyHint: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
    paddingHorizontal: 40,
    lineHeight: 20,
  },
  emptySettingsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 16,
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptySettingsBtnText: {
    color: colors.accentLight,
    fontSize: 14,
    fontWeight: "600",
  },
});
