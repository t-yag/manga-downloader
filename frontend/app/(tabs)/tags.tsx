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
  type TagRule,
  type TagDiscoverItem,
  type TagItemEntry,
} from "../../src/api/client";
import { useRouter } from "expo-router";
import { PLUGIN_LABELS } from "../../src/constants";

type Tab = "rules" | "unset";
type Action = "show" | "map" | "hide";

export default function TagsScreen() {
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

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["tag-rules"] });
    queryClient.invalidateQueries({ queryKey: ["tags-discover"] });
    queryClient.invalidateQueries({ queryKey: ["library"] });
  };

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
    <View style={st.container}>
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
          <Ionicons name="search" size={14} color="#64748b" />
          <TextInput
            style={st.searchInput}
            placeholder="タグを検索..."
            placeholderTextColor="#475569"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={14} color="#475569" />
            </TouchableOpacity>
          )}
        </View>
        {tab === "rules" && (
          <>
            <TouchableOpacity style={st.iconBtn} onPress={() => setShowAddModal(true)}>
              <Ionicons name="add" size={18} color="#60a5fa" />
            </TouchableOpacity>
            <TouchableOpacity style={st.iconBtn} onPress={() => setShowImportModal(true)}>
              <Ionicons name="download-outline" size={16} color="#60a5fa" />
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={st.iconBtn}
          onPress={() => rebuildMut.mutate()}
          disabled={rebuildMut.isPending}
        >
          {rebuildMut.isPending ? (
            <ActivityIndicator color="#60a5fa" size="small" />
          ) : (
            <Ionicons name="refresh" size={16} color="#60a5fa" />
          )}
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#60a5fa" />
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
    { key: "map", label: "変換", color: "#4ade80", items: mapRules },
    { key: "hide", label: "非表示", color: "#f87171", items: hideRules },
    { key: "show", label: "表示", color: "#60a5fa", items: showRules },
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
                size={13} color="#475569" style={{ marginLeft: "auto" }}
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
                  <Ionicons name="trash-outline" size={14} color="#475569" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        );
      })}

      {total === 0 && (
        <View style={st.empty}>
          <Ionicons name="pricetag-outline" size={40} color="#334155" />
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
}: {
  tags: TagDiscoverItem[];
  onSelect: (t: TagDiscoverItem) => void;
  search: string;
}) {
  return (
    <ScrollView style={st.list}>
      {tags.length === 0 ? (
        <View style={st.empty}>
          <Ionicons name="checkmark-circle-outline" size={40} color="#4ade80" />
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
              <Ionicons name="close" size={22} color="#64748b" />
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
              <Ionicons name="close" size={22} color="#64748b" />
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
                placeholderTextColor="#475569"
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
              <Ionicons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <Text style={st.label}>モード</Text>
          <View style={st.actionRow}>
            <TouchableOpacity
              style={[st.actionBtn, mode === "merge" && { borderColor: "#60a5fa", backgroundColor: "#60a5fa15" }]}
              onPress={() => setMode("merge")}
            >
              <Text style={[st.actionBtnText, mode === "merge" && { color: "#60a5fa", fontWeight: "700" }]}>
                マージ
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.actionBtn, mode === "replace" && { borderColor: "#f87171", backgroundColor: "#f8717115" }]}
              onPress={() => setMode("replace")}
            >
              <Text style={[st.actionBtnText, mode === "replace" && { color: "#f87171", fontWeight: "700" }]}>
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
            placeholderTextColor="#475569"
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
          出典: {plugins.map((p) => PLUGIN_LABELS[p] ?? p).join(", ")} · {count}件
        </Text>
        <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={12} color="#64748b" style={{ marginLeft: 4 }} />
      </TouchableOpacity>

      {expanded && (
        <ScrollView style={st.tagItemsContainer} nestedScrollEnabled>
          {loading && items.length === 0 ? (
            <ActivityIndicator size="small" color="#60a5fa" style={{ padding: 12 }} />
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
                  <Text style={st.tagItemPlugin}>{PLUGIN_LABELS[item.pluginId] ?? item.pluginId}</Text>
                </TouchableOpacity>
              ))}
              {items.length < total && (
                <TouchableOpacity onPress={handleLoadMore} disabled={loading} style={st.tagItemsMore}>
                  {loading ? (
                    <ActivityIndicator size="small" color="#60a5fa" />
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
    { key: "show", label: "表示", color: "#60a5fa" },
    { key: "map", label: "変換", color: "#4ade80" },
    { key: "hide", label: "非表示", color: "#f87171" },
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
        placeholderTextColor="#475569"
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
        <ActivityIndicator color="#fff" size="small" />
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
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Tabs
  tabBar: { flexDirection: "row", gap: 4, marginBottom: 12 },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
    backgroundColor: "#1e293b",
  },
  tabActive: { backgroundColor: "#172554", borderWidth: 1, borderColor: "#1e40af" },
  tabText: { color: "#64748b", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#60a5fa" },
  tabBadge: {
    backgroundColor: "#334155", borderRadius: 10,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  tabBadgeActive: { backgroundColor: "#1e40af" },
  tabBadgeText: { color: "#64748b", fontSize: 10, fontWeight: "700" },
  tabBadgeTextActive: { color: "#93c5fd" },

  // Top bar
  topBar: { flexDirection: "row", gap: 8, marginBottom: 10 },
  searchBox: {
    flex: 1, flexDirection: "row", alignItems: "center",
    backgroundColor: "#1e293b", borderRadius: 8, paddingHorizontal: 10, height: 36, gap: 6,
  },
  searchInput: {
    flex: 1, color: "#e2e8f0", fontSize: 13, paddingVertical: 0,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  iconBtn: {
    width: 36, height: 36, backgroundColor: "#1e293b",
    borderRadius: 8, alignItems: "center", justifyContent: "center",
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
  sectionCount: { color: "#475569", fontSize: 11 },

  // Row
  row: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#1e293b", borderRadius: 8, marginBottom: 2,
  },
  rowBody: { flex: 1, paddingLeft: 12, paddingVertical: 8, gap: 2 },
  nameLine: { flexDirection: "row", alignItems: "center" },
  tagName: { color: "#e2e8f0", fontSize: 13, fontWeight: "600", flexShrink: 1 },
  tagNameHidden: { color: "#64748b", textDecorationLine: "line-through" },
  arrow: { color: "#4ade80", fontSize: 11, marginHorizontal: 5 },
  mapped: { color: "#4ade80", fontSize: 12, fontWeight: "600", flexShrink: 1 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  sources: { color: "#475569", fontSize: 10, flexShrink: 1 },
  count: { color: "#475569", fontSize: 10, marginLeft: "auto" },
  quickBtn: { paddingHorizontal: 10, paddingVertical: 12 },

  // Empty
  empty: { alignItems: "center", marginTop: 60, gap: 10 },
  emptyText: { color: "#475569", fontSize: 13 },
  emptyHint: { color: "#334155", fontSize: 11 },

  // Tag items expandable
  tagItemsToggle: {
    flexDirection: "row", alignItems: "center",
    paddingBottom: 4,
  },
  tagItemsContainer: {
    backgroundColor: "#0f172a", borderRadius: 8,
    maxHeight: 200, overflow: "hidden",
    marginBottom: 4,
  },
  tagItemsEmpty: { color: "#475569", fontSize: 12, padding: 12, textAlign: "center" },
  tagItemRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#1e293b",
  },
  tagItemTitle: { color: "#e2e8f0", fontSize: 12, fontWeight: "600", flex: 1, marginRight: 8 },
  tagItemPlugin: { color: "#475569", fontSize: 10, flexShrink: 0 },
  tagItemsMore: { alignItems: "center", paddingVertical: 8 },
  tagItemsMoreText: { color: "#60a5fa", fontSize: 11 },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center", alignItems: "center", padding: 24,
  },
  modal: {
    backgroundColor: "#1e293b", borderRadius: 14, padding: 24,
    width: "100%", maxWidth: 420,
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  modalTitle: { color: "#94a3b8", fontSize: 14, fontWeight: "700" },
  modalTagName: { color: "#f1f5f9", fontSize: 20, fontWeight: "700", marginBottom: 4 },
  modalMeta: { color: "#64748b", fontSize: 12, marginBottom: 0 },

  // Label
  label: { color: "#94a3b8", fontSize: 11, fontWeight: "600", letterSpacing: 0.5, marginBottom: 8 },

  // Action
  actionRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  actionBtn: {
    flex: 1, alignItems: "center",
    paddingVertical: 10, borderRadius: 8,
    borderWidth: 1.5, borderColor: "#334155",
  },
  actionBtnText: { color: "#64748b", fontSize: 13, fontWeight: "600" },

  // Map
  mapRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#0f172a", borderRadius: 8,
    paddingHorizontal: 14, marginBottom: 16,
  },
  mapArrow: { color: "#4ade80", fontSize: 15, fontWeight: "700" },
  mapInput: {
    flex: 1, color: "#e2e8f0", fontSize: 15,
    paddingVertical: Platform.OS === "web" ? 12 : 14,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,

  // Text input
  textInput: {
    backgroundColor: "#0f172a", borderRadius: 8, color: "#e2e8f0",
    fontSize: 15, paddingHorizontal: 14, marginBottom: 16,
    paddingVertical: Platform.OS === "web" ? 12 : 14,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,

  // JSON input
  jsonInput: {
    backgroundColor: "#0f172a", borderRadius: 8, color: "#e2e8f0",
    fontSize: 12, fontFamily: Platform.OS === "web" ? "monospace" : undefined,
    paddingHorizontal: 14, paddingVertical: 12,
    minHeight: 120, textAlignVertical: "top", marginBottom: 4,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  hintText: { color: "#475569", fontSize: 10, marginBottom: 12 },
  warningText: { color: "#f87171", fontSize: 11, marginTop: -10, marginBottom: 12 },
  errorText: { color: "#f87171", fontSize: 12, marginBottom: 12 },

  // Save
  saveBtn: {
    backgroundColor: "#2563eb", borderRadius: 8,
    paddingVertical: 13, alignItems: "center",
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
