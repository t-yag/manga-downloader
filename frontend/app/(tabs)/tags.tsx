import { useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toast } from "../../src/toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  discoverTags,
  getTagRules,
  createTagRule,
  updateTagRule,
  deleteTagRule,
  importTagRules,
  rebuildDisplayGenres,
  getTagItems,
  getSettings,
  updateSettings,
  type TagRule,
  type TagDiscoverItem,
  type TagItemEntry,
} from "../../src/api/client";
import { useRouter } from "expo-router";
import { SOURCE_LABELS, TAB_CONTENT_PADDING } from "../../src/constants";
import { colors, radius } from "../../src/theme";

type Tab = "rules" | "unset";
type Action = "show" | "map" | "hide";

export default function TagsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("rules");
  const [search, setSearch] = useState("");
  const [editingRule, setEditingRule] = useState<TagRule | null>(null);
  const [editingDiscover, setEditingDiscover] = useState<TagDiscoverItem | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const { data: rulesData = [], isLoading: rulesLoading } = useQuery({
    queryKey: ["tag-rules"],
    queryFn: getTagRules,
  });
  const { data: discoverData, isLoading: discoverLoading } = useQuery({
    queryKey: ["tags-discover"],
    queryFn: () => discoverTags(),
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });
  const unsetDefault = (settings?.["tags.unsetDefault"] as "show" | "hide") ?? "hide";

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["tag-rules"] });
    queryClient.invalidateQueries({ queryKey: ["tags-discover"] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
    queryClient.invalidateQueries({ queryKey: ["libraryTags"] });
  };

  const updateUnsetDefaultMut = useMutation({
    mutationFn: (value: "show" | "hide") =>
      updateSettings({ "tags.unsetDefault": value }).then(() => rebuildDisplayGenres()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      invalidateAll();
    },
  });

  const rebuildMut = useMutation({
    mutationFn: rebuildDisplayGenres,
    onSuccess: (d) => { invalidateAll(); toast.success(d.updated > 0 ? `${d.updated}件の表示タグを更新しました` : "変更はありませんでした"); },
  });

  // --- Rules tab data ---
  const filteredRules = useMemo(() => {
    if (!search) return rulesData;
    const lower = search.toLowerCase();
    return rulesData.filter(
      (r) =>
        r.original.toLowerCase().includes(lower) ||
        (r.mappedTo && r.mappedTo.toLowerCase().includes(lower))
    );
  }, [rulesData, search]);

  const sortByOriginal = (a: TagRule, b: TagRule) => a.original.localeCompare(b.original, "ja");
  const showRules = useMemo(() => filteredRules.filter((r) => r.action === "show").sort(sortByOriginal), [filteredRules]);
  const mapRules = useMemo(() => filteredRules.filter((r) => r.action === "map").sort(sortByOriginal), [filteredRules]);
  const hideRules = useMemo(() => filteredRules.filter((r) => r.action === "hide").sort(sortByOriginal), [filteredRules]);

  // Tag -> { plugins, count } lookup from discover data
  const tagInfoMap = useMemo(() => {
    const map = new Map<string, { plugins: string[]; count: number }>();
    for (const t of discoverData?.tags ?? []) {
      map.set(t.tag.toLowerCase(), { plugins: t.plugins, count: t.count });
    }
    return map;
  }, [discoverData]);

  // --- Unset tab data ---
  const unsetTags = useMemo(() => {
    const tags = discoverData?.tags ?? [];
    const unset = tags.filter((t) => t.rule === null);
    const filtered = search
      ? unset.filter((t) => t.tag.toLowerCase().includes(search.toLowerCase()))
      : unset;
    return filtered.sort((a, b) => a.tag.localeCompare(b.tag, "ja"));
  }, [discoverData, search]);

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const isLoading = tab === "rules" ? rulesLoading : discoverLoading;

  return (
    <View style={[st.container, Platform.OS === "ios" && { paddingTop: insets.top + TAB_CONTENT_PADDING }]}>
      {/* Tab bar */}
      <View style={st.tabBar}>
        <TouchableOpacity
          style={[st.tab, tab === "rules" && st.tabActive]}
          onPress={() => setTab("rules")}
        >
          <Text style={[st.tabText, tab === "rules" && st.tabTextActive]}>ルール</Text>
          {rulesData.length > 0 && (
            <View style={[st.tabBadge, tab === "rules" && st.tabBadgeActive]}>
              <Text style={[st.tabBadgeText, tab === "rules" && st.tabBadgeTextActive]}>
                {rulesData.length}
              </Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[st.tab, tab === "unset" && st.tabActive]}
          onPress={() => setTab("unset")}
        >
          <Text style={[st.tabText, tab === "unset" && st.tabTextActive]}>未設定タグ</Text>
          {unsetTags.length > 0 && (
            <View style={[st.tabBadge, tab === "unset" && st.tabBadgeActive]}>
              <Text style={[st.tabBadgeText, tab === "unset" && st.tabBadgeTextActive]}>{unsetTags.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Top bar */}
      <View style={st.topBar}>
        <View style={st.searchBox}>
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <TextInput
            style={st.searchInput}
            placeholder="タグを検索..."
            placeholderTextColor={colors.textDim}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={14} color={colors.textDim} />
            </TouchableOpacity>
          )}
        </View>
        {tab === "rules" && (
          <>
            <TouchableOpacity style={st.iconBtn} onPress={() => setShowAddModal(true)}>
              <Ionicons name="add" size={18} color={colors.accentLight} />
            </TouchableOpacity>
            <TouchableOpacity style={st.iconBtn} onPress={() => setShowImportModal(true)}>
              <Ionicons name="download-outline" size={16} color={colors.accentLight} />
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={st.iconBtn}
          onPress={() => rebuildMut.mutate()}
          disabled={rebuildMut.isPending}
        >
          {rebuildMut.isPending ? (
            <ActivityIndicator color={colors.accentLight} size="small" />
          ) : (
            <Ionicons name="refresh" size={16} color={colors.accentLight} />
          )}
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color={colors.accentLight} />
      ) : tab === "rules" ? (
        <RulesTab
          showRules={showRules}
          mapRules={mapRules}
          hideRules={hideRules}
          collapsedSections={collapsedSections}
          toggleSection={toggleSection}
          onEdit={setEditingRule}
          onDeleted={invalidateAll}
          search={search}
        />
      ) : (
        <UnsetTab
          tags={unsetTags}
          onSelect={setEditingDiscover}
          search={search}
          unsetDefault={unsetDefault}
          onUnsetDefaultChange={(v) => updateUnsetDefaultMut.mutate(v)}
          changePending={updateUnsetDefaultMut.isPending}
        />
      )}

      {/* Edit rule modal (from rules tab) */}
      {editingRule && (
        <EditRuleDialog
          rule={editingRule}
          tagInfo={tagInfoMap.get(editingRule.original.toLowerCase())}
          onClose={() => setEditingRule(null)}
          onSaved={() => { setEditingRule(null); invalidateAll(); }}
        />
      )}

      {/* Create rule modal (from unset tab or add button) */}
      {(editingDiscover || showAddModal) && (
        <CreateRuleDialog
          discoverItem={editingDiscover ?? undefined}
          onClose={() => { setEditingDiscover(null); setShowAddModal(false); }}
          onSaved={() => { setEditingDiscover(null); setShowAddModal(false); invalidateAll(); }}
        />
      )}

      {/* Import modal */}
      {showImportModal && (
        <ImportDialog
          onClose={() => setShowImportModal(false)}
          onDone={() => { setShowImportModal(false); invalidateAll(); }}
        />
      )}
    </View>
  );
}

// =============================================================================
// Rules Tab
// =============================================================================

function RulesTab({
  showRules,
  mapRules,
  hideRules,
  collapsedSections,
  toggleSection,
  onEdit,
  onDeleted,
  search,
}: {
  showRules: TagRule[];
  mapRules: TagRule[];
  hideRules: TagRule[];
  collapsedSections: Set<string>;
  toggleSection: (k: string) => void;
  onEdit: (r: TagRule) => void;
  onDeleted: () => void;
  search: string;
}) {
  const deleteMut = useMutation({
    mutationFn: deleteTagRule,
    onSuccess: () => onDeleted(),
  });

  const handleDelete = (rule: TagRule) => {
    deleteMut.mutate(rule.id);
  };

  const sections = [
    { key: "show", label: "表示", color: colors.accentLight, items: showRules },
    { key: "map", label: "変換", color: colors.success, items: mapRules },
    { key: "hide", label: "非表示", color: colors.error, items: hideRules },
  ];

  const total = showRules.length + mapRules.length + hideRules.length;

  return (
    <ScrollView style={st.list}>
      {sections.map(({ key, label, color, items }) => {
        if (items.length === 0) return null;
        const collapsed = collapsedSections.has(key);
        return (
          <View key={key} style={st.section}>
            <TouchableOpacity style={st.sectionHeader} onPress={() => toggleSection(key)} activeOpacity={0.7}>
              <View style={[st.sectionDot, { backgroundColor: color }]} />
              <Text style={[st.sectionLabel, { color }]}>{label}</Text>
              <Text style={st.sectionCount}>{items.length}</Text>
              <Ionicons
                name={collapsed ? "chevron-forward" : "chevron-down"}
                size={13} color={colors.textDim} style={{ marginLeft: "auto" }}
              />
            </TouchableOpacity>

            {!collapsed && items.map((rule) => (
              <View key={rule.id} style={st.row}>
                <TouchableOpacity style={st.rowBody} onPress={() => onEdit(rule)} activeOpacity={0.6}>
                  <View style={st.nameLine}>
                    <Text
                      style={[st.tagName, rule.action === "hide" && st.tagNameHidden]}
                      numberOfLines={1}
                    >
                      {rule.original}
                    </Text>
                    {rule.action === "map" && rule.mappedTo && (
                      <>
                        <Text style={st.arrow}>→</Text>
                        <Text style={st.mapped} numberOfLines={1}>{rule.mappedTo}</Text>
                      </>
                    )}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={st.quickBtn}
                  onPress={() => handleDelete(rule)}
                  disabled={deleteMut.isPending}
                  hitSlop={4}
                >
                  <Ionicons name="trash-outline" size={14} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        );
      })}

      {total === 0 && (
        <View style={st.empty}>
          <Ionicons name="pricetag-outline" size={40} color={colors.borderAccent} />
          <Text style={st.emptyText}>
            {search ? "該当するルールがありません" : "ルールがまだありません"}
          </Text>
          <Text style={st.emptyHint}>+ ボタンで追加するか、未設定タグから設定できます</Text>
        </View>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// =============================================================================
// Unset Tab
// =============================================================================

function UnsetTab({
  tags,
  onSelect,
  search,
  unsetDefault,
  onUnsetDefaultChange,
  changePending,
}: {
  tags: TagDiscoverItem[];
  onSelect: (t: TagDiscoverItem) => void;
  search: string;
  unsetDefault: "show" | "hide";
  onUnsetDefaultChange: (v: "show" | "hide") => void;
  changePending: boolean;
}) {
  return (
    <ScrollView style={st.list}>
      {/* Unset default toggle */}
      <View style={st.unsetDefaultBar}>
        <Text style={st.unsetDefaultLabel}>未設定タグの扱い</Text>
        <View style={st.unsetDefaultToggle}>
          {(["show", "hide"] as const).map((v) => {
            const active = unsetDefault === v;
            const color = v === "show" ? colors.accentLight : colors.error;
            return (
              <TouchableOpacity
                key={v}
                style={[st.unsetDefaultBtn, active && { borderColor: color, backgroundColor: `${color}15` }]}
                onPress={() => !active && onUnsetDefaultChange(v)}
                disabled={changePending}
              >
                {changePending && active ? (
                  <ActivityIndicator size={12} color={color} />
                ) : (
                  <Text style={[st.unsetDefaultBtnText, active && { color, fontWeight: "700" }]}>
                    {v === "show" ? "表示" : "非表示"}
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {tags.length === 0 ? (
        <View style={st.empty}>
          <Ionicons name="checkmark-circle-outline" size={40} color={colors.success} />
          <Text style={st.emptyText}>
            {search ? "該当するタグがありません" : "すべてのタグにルールが設定されています"}
          </Text>
        </View>
      ) : (
        tags.map((tag) => (
          <TouchableOpacity
            key={tag.tag}
            style={st.row}
            onPress={() => onSelect(tag)}
            activeOpacity={0.6}
          >
            <View style={st.rowBody}>
              <Text style={st.tagName} numberOfLines={1}>{tag.tag}</Text>
            </View>
          </TouchableOpacity>
        ))
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// =============================================================================
// Edit Rule Dialog (existing rule)
// =============================================================================

function EditRuleDialog({
  rule,
  tagInfo,
  onClose,
  onSaved,
}: {
  rule: TagRule;
  tagInfo?: { plugins: string[]; count: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<Action>(rule.action);
  const [mappedTo, setMappedTo] = useState(rule.mappedTo ?? "");

  const updateMut = useMutation({
    mutationFn: ({ id, ...p }: { id: number; action?: "show" | "map" | "hide"; mappedTo?: string | null }) =>
      updateTagRule(id, p),
  });
  const isBusy = updateMut.isPending;
  const canSave = action !== "map" || mappedTo.trim().length > 0;

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync({
        id: rule.id,
        action,
        mappedTo: action === "map" ? mappedTo.trim() : null,
      });
      toast.success("ルールを保存しました");
      onSaved();
    } catch (err: any) {
      toast.error("エラー", { description: err.message });
    }
  };

  return (
    <Modal transparent animationType="fade" visible>
      <Pressable style={st.modalOverlay} onPress={onClose}>
        <Pressable style={st.modal} onPress={(e) => e.stopPropagation()}>
          <View style={st.modalHeader}>
            <Text style={st.modalTagName}>{rule.original}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {tagInfo && (
            <TagItemsList tag={rule.original} plugins={tagInfo.plugins} count={tagInfo.count} onNavigate={onClose} />
          )}

          <Text style={st.label}>対処</Text>
          <ActionRow action={action} onSelect={setAction} />

          {action === "map" && (
            <MapInput value={mappedTo} onChange={setMappedTo} onSubmit={() => canSave && handleSave()} />
          )}

          <SaveButton onPress={handleSave} disabled={isBusy || !canSave} loading={isBusy} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// =============================================================================
// Create Rule Dialog (from unset tag or manual add)
// =============================================================================

function CreateRuleDialog({
  discoverItem,
  onClose,
  onSaved,
}: {
  discoverItem?: TagDiscoverItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [original, setOriginal] = useState(discoverItem?.tag ?? "");
  const [action, setAction] = useState<Action>("show");
  const [mappedTo, setMappedTo] = useState("");

  const createMut = useMutation({ mutationFn: createTagRule });
  const isBusy = createMut.isPending;
  const canSave =
    original.trim().length > 0 &&
    (action !== "map" || mappedTo.trim().length > 0);

  const handleSave = async () => {
    try {
      await createMut.mutateAsync({
        original: original.trim(),
        action,
        mappedTo: action === "map" ? mappedTo.trim() : undefined,
      });
      toast.success("ルールを作成しました");
      onSaved();
    } catch (err: any) {
      toast.error("エラー", { description: err.message });
    }
  };

  return (
    <Modal transparent animationType="fade" visible>
      <Pressable style={st.modalOverlay} onPress={onClose}>
        <Pressable style={st.modal} onPress={(e) => e.stopPropagation()}>
          <View style={st.modalHeader}>
            <Text style={st.modalTitle}>タグ設定</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Tag name input (editable if manual, fixed if from discover) */}
          {discoverItem ? (
            <>
              <Text style={st.modalTagName}>{discoverItem.tag}</Text>
              <TagItemsList tag={discoverItem.tag} plugins={discoverItem.plugins} count={discoverItem.count} onNavigate={onClose} />
            </>
          ) : (
            <>
              <Text style={st.label}>元タグ</Text>
              <TextInput
                style={st.textInput}
                value={original}
                onChangeText={setOriginal}
                placeholder="タグ名を入力"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoFocus
              />
            </>
          )}

          <Text style={st.label}>対処</Text>
          <ActionRow action={action} onSelect={setAction} />

          {action === "map" && (
            <MapInput value={mappedTo} onChange={setMappedTo} onSubmit={() => canSave && handleSave()} />
          )}

          <SaveButton onPress={handleSave} disabled={isBusy || !canSave} loading={isBusy} label="設定" />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// =============================================================================
// Import Dialog
// =============================================================================

function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState("");

  const importMut = useMutation({ mutationFn: importTagRules });

  const handleImport = async () => {
    setError("");
    let parsed: Record<string, string | null>;
    try {
      const raw = JSON.parse(jsonText);
      // Support nh-downloader format { "tag": { ... } }
      parsed = raw.tag ?? raw;
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid format");
      }
    } catch {
      setError("JSON の形式が正しくありません。{ \"tag\": \"変換先\", ... } の形式で入力してください。");
      return;
    }

    // Normalize: string values → map, null → hide
    const rules: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed)) {
      rules[k] = typeof v === "string" ? v : null;
    }

    try {
      const result = await importMut.mutateAsync({ mode, rules });
      toast.success(`インポート完了: ${result.created}件作成, ${result.updated}件更新`);
      onDone();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <Modal transparent animationType="fade" visible>
      <Pressable style={st.modalOverlay} onPress={onClose}>
        <Pressable style={st.modal} onPress={(e) => e.stopPropagation()}>
          <View style={st.modalHeader}>
            <Text style={st.modalTitle}>タグルール インポート</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={st.label}>モード</Text>
          <View style={st.actionRow}>
            <TouchableOpacity
              style={[st.actionBtn, mode === "merge" && { borderColor: colors.accentLight, backgroundColor: colors.accentGlow }]}
              onPress={() => setMode("merge")}
            >
              <Text style={[st.actionBtnText, mode === "merge" && { color: colors.accentLight, fontWeight: "700" }]}>
                マージ
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.actionBtn, mode === "replace" && { borderColor: colors.error, backgroundColor: `${colors.error}15` }]}
              onPress={() => setMode("replace")}
            >
              <Text style={[st.actionBtnText, mode === "replace" && { color: colors.error, fontWeight: "700" }]}>
                置換
              </Text>
            </TouchableOpacity>
          </View>
          {mode === "replace" && (
            <Text style={st.warningText}>既存のルールをすべて削除して入れ替えます</Text>
          )}

          <Text style={st.label}>JSON</Text>
          <TextInput
            style={st.jsonInput}
            value={jsonText}
            onChangeText={setJsonText}
            placeholder={'{ "lolicon": "ロリ", "SALE": null }'}
            placeholderTextColor={colors.textDim}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={st.hintText}>値が文字列 → 変換、null → 非表示</Text>

          {error ? <Text style={st.errorText}>{error}</Text> : null}

          <SaveButton
            onPress={handleImport}
            disabled={importMut.isPending || !jsonText.trim()}
            loading={importMut.isPending}
            label="インポート"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// =============================================================================
// Shared components
// =============================================================================

// =============================================================================
// Tag Items Expandable List
// =============================================================================

function TagItemsList({
  tag,
  plugins,
  count,
  onNavigate,
}: {
  tag: string;
  plugins: string[];
  count: number;
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<TagItemEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  const INITIAL_LIMIT = 10;

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (loaded) return;
    setLoading(true);
    try {
      const res = await getTagItems(tag, { limit: INITIAL_LIMIT });
      setItems(res.items);
      setTotal(res.total);
      setLoaded(true);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMore = async () => {
    setLoading(true);
    try {
      const res = await getTagItems(tag, { limit: INITIAL_LIMIT, offset: items.length });
      setItems((prev) => [...prev, ...res.items]);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const handleItemPress = (id: number) => {
    onNavigate();
    router.push(`/library/${id}`);
  };

  return (
    <View style={{ marginBottom: 8 }}>
      <TouchableOpacity onPress={handleExpand} activeOpacity={0.6} style={st.tagItemsToggle}>
        <Text style={st.modalMeta}>
          出典: {plugins.map((p) => SOURCE_LABELS[p] ?? p).join(", ")} · {count}件
        </Text>
        <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={12} color={colors.textMuted} style={{ marginLeft: 4 }} />
      </TouchableOpacity>

      {expanded && (
        <ScrollView style={st.tagItemsContainer} nestedScrollEnabled>
          {loading && items.length === 0 ? (
            <ActivityIndicator size="small" color={colors.accentLight} style={{ padding: 12 }} />
          ) : items.length === 0 && loaded ? (
            <Text style={st.tagItemsEmpty}>該当する作品がありません</Text>
          ) : (
            <>
              {items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={st.tagItemRow}
                  onPress={() => handleItemPress(item.id)}
                  activeOpacity={0.6}
                >
                  <Text style={st.tagItemTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={st.tagItemPlugin}>{SOURCE_LABELS[item.pluginId] ?? item.pluginId}</Text>
                </TouchableOpacity>
              ))}
              {items.length < total && (
                <TouchableOpacity onPress={handleLoadMore} disabled={loading} style={st.tagItemsMore}>
                  {loading ? (
                    <ActivityIndicator size="small" color={colors.accentLight} />
                  ) : (
                    <Text style={st.tagItemsMoreText}>
                      もっと見る (残り{total - items.length}件)
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function ActionRow({
  action,
  onSelect,
}: {
  action: Action;
  onSelect: (a: Action) => void;
}) {
  const actions: { key: Action; label: string; color: string }[] = [
    { key: "show", label: "表示", color: colors.accentLight },
    { key: "map", label: "変換", color: colors.success },
    { key: "hide", label: "非表示", color: colors.error },
  ];

  return (
    <View style={st.actionRow}>
      {actions.map(({ key, label, color }) => {
        const active = action === key;
        return (
          <TouchableOpacity
            key={key}
            style={[st.actionBtn, active && { borderColor: color, backgroundColor: `${color}15` }]}
            onPress={() => onSelect(key)}
          >
            <Text style={[st.actionBtnText, active && { color, fontWeight: "700" }]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MapInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View style={st.mapRow}>
      <Text style={st.mapArrow}>→</Text>
      <TextInput
        style={st.mapInput}
        value={value}
        onChangeText={onChange}
        placeholder="変換先タグ"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoFocus
        onSubmitEditing={onSubmit}
      />
    </View>
  );
}

function SaveButton({
  onPress,
  disabled,
  loading,
  label = "保存",
}: {
  onPress: () => void;
  disabled: boolean;
  loading: boolean;
  label?: string;
}) {
  return (
    <TouchableOpacity
      style={[st.saveBtn, disabled && st.saveBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {loading ? (
        <ActivityIndicator color={colors.white} size="small" />
      ) : (
        <Text style={st.saveBtnText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

// =============================================================================
// Styles
// =============================================================================

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16 },

  // Tabs
  tabBar: { flexDirection: "row", gap: 4, marginBottom: 12 },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.sm,
    backgroundColor: colors.bgCard,
  },
  tabActive: { backgroundColor: colors.infoBg, borderWidth: 1, borderColor: "rgba(59,130,246,0.3)" },
  tabText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: colors.accentLight },
  tabBadge: {
    backgroundColor: colors.borderAccent, borderRadius: 10,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  tabBadgeActive: { backgroundColor: "rgba(59,130,246,0.3)" },
  tabBadgeText: { color: colors.textMuted, fontSize: 10, fontWeight: "700" },
  tabBadgeTextActive: { color: colors.accentPale },

  // Top bar
  topBar: { flexDirection: "row", gap: 8, marginBottom: 10 },
  searchBox: {
    flex: 1, flexDirection: "row", alignItems: "center",
    backgroundColor: colors.bgCard, borderRadius: radius.sm, paddingHorizontal: 10, height: 36, gap: 6,
  },
  searchInput: {
    flex: 1, color: colors.textLight, fontSize: 13, paddingVertical: 0,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  iconBtn: {
    width: 36, height: 36, backgroundColor: colors.bgCard,
    borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
  },

  // List
  list: { flex: 1 },
  section: { marginBottom: 10 },
  sectionHeader: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingVertical: 5, paddingHorizontal: 2,
  },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionLabel: { fontSize: 12, fontWeight: "700" },
  sectionCount: { color: colors.textDim, fontSize: 11 },

  // Row
  row: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.bgCard, borderRadius: radius.sm, marginBottom: 2,
  },
  rowBody: { flex: 1, paddingLeft: 12, paddingVertical: 8, gap: 2 },
  nameLine: { flexDirection: "row", alignItems: "center" },
  tagName: { color: colors.textLight, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  tagNameHidden: { color: colors.textMuted },
  arrow: { color: colors.success, fontSize: 11, marginHorizontal: 5 },
  mapped: { color: colors.success, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  sources: { color: colors.textDim, fontSize: 10, flexShrink: 1 },
  count: { color: colors.textDim, fontSize: 10, marginLeft: "auto" },
  quickBtn: { paddingHorizontal: 10, paddingVertical: 12 },

  // Unset default toggle
  unsetDefaultBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: colors.bgCard, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 10,
  },
  unsetDefaultLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  unsetDefaultToggle: { flexDirection: "row", gap: 6 },
  unsetDefaultBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6,
    borderWidth: 1.5, borderColor: colors.borderAccent, minWidth: 52, alignItems: "center",
  },
  unsetDefaultBtnText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },

  // Empty
  empty: { alignItems: "center", marginTop: 60, gap: 10 },
  emptyText: { color: colors.textDim, fontSize: 13 },
  emptyHint: { color: colors.borderAccent, fontSize: 11 },

  // Tag items expandable
  tagItemsToggle: {
    flexDirection: "row", alignItems: "center",
    paddingBottom: 4,
  },
  tagItemsContainer: {
    backgroundColor: colors.bg, borderRadius: radius.sm,
    maxHeight: 200, overflow: "hidden",
    marginBottom: 4,
  },
  tagItemsEmpty: { color: colors.textDim, fontSize: 12, padding: 12, textAlign: "center" },
  tagItemRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  tagItemTitle: { color: colors.textLight, fontSize: 12, fontWeight: "600", flex: 1, marginRight: 8 },
  tagItemPlugin: { color: colors.textDim, fontSize: 10, flexShrink: 0 },
  tagItemsMore: { alignItems: "center", paddingVertical: 8 },
  tagItemsMoreText: { color: colors.accentLight, fontSize: 11 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center", alignItems: "center", padding: 24,
  },
  modal: {
    backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: 24,
    width: "100%", maxWidth: 420,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  modalTitle: { color: colors.textSecondary, fontSize: 14, fontWeight: "700" },
  modalTagName: { color: colors.textPrimary, fontSize: 20, fontWeight: "700", marginBottom: 4 },
  modalMeta: { color: colors.textMuted, fontSize: 12, marginBottom: 0 },

  // Label
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: "600", letterSpacing: 0.5, marginBottom: 8 },

  // Action
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  actionBtn: {
    flex: 1, alignItems: "center",
    paddingVertical: 10, borderRadius: 8,
    borderWidth: 1.5, borderColor: colors.borderAccent,
  },
  actionBtnText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },

  // Map
  mapRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: colors.bg, borderRadius: radius.sm,
    paddingHorizontal: 14, marginBottom: 16,
  },
  mapArrow: { color: colors.success, fontSize: 15, fontWeight: "700" },
  mapInput: {
    flex: 1, color: colors.textLight, fontSize: 15,
    paddingVertical: Platform.OS === "web" ? 12 : 14,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,

  // Text input
  textInput: {
    backgroundColor: colors.bg, borderRadius: radius.sm, color: colors.textLight,
    fontSize: 15, paddingHorizontal: 14, marginBottom: 16,
    paddingVertical: Platform.OS === "web" ? 12 : 14,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,

  // JSON input
  jsonInput: {
    backgroundColor: colors.bg, borderRadius: radius.sm, color: colors.textLight,
    fontSize: 12, fontFamily: Platform.OS === "web" ? "monospace" : undefined,
    paddingHorizontal: 14, paddingVertical: 12,
    minHeight: 120, textAlignVertical: "top", marginBottom: 4,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  hintText: { color: colors.textDim, fontSize: 10, marginBottom: 12 },
  warningText: { color: colors.error, fontSize: 11, marginTop: -10, marginBottom: 12 },
  errorText: { color: colors.error, fontSize: 12, marginBottom: 12 },

  // Save
  saveBtn: {
    backgroundColor: colors.accent, borderRadius: radius.sm,
    paddingVertical: 13, alignItems: "center",
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: colors.white, fontWeight: "700", fontSize: 15 },
});
