import { useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
  Image,
  Linking,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { toast } from "../../src/toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getLibraryTitle,
  updateLibraryTitle,
  syncTitle,
  downloadVolumes,
  deleteVolumes,
  deleteFromLibrary,
  getAccounts,
  type Volume,
} from "../../src/api/client";

const STATUS_CONFIG: Record<
  string,
  {
    bg: string;
    fg: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }
> = {
  done: { bg: "#052e16", fg: "#4ade80", label: "取得済", icon: "checkmark-circle" },
  available: { bg: "#172554", fg: "#60a5fa", label: "取得可", icon: "cloud-download-outline" },
  unavailable: { bg: "#292524", fg: "#a8a29e", label: "未購入", icon: "lock-closed-outline" },
  queued: { bg: "#422006", fg: "#facc15", label: "待機中", icon: "time-outline" },
  downloading: { bg: "#431407", fg: "#fb923c", label: "取得中", icon: "arrow-down-circle" },
  error: { bg: "#450a0a", fg: "#f87171", label: "エラー", icon: "alert-circle" },
  unknown: { bg: "#1e293b", fg: "#94a3b8", label: "不明", icon: "help-circle-outline" },
};

type StatusFilter = "all" | "done" | "available" | "unavailable" | "other";

import { PLUGIN_LABELS } from "../../src/constants";

const REASON_LABELS: Record<string, string> = {
  purchased: "購入済み",
  not_purchased: "未購入",
  free: "無料公開",
  subscription: "読み放題対象",
  rate_limited: "レート制限",
  unknown: "不明",
};

function getExternalUrl(pluginId: string, titleId: string): string | null {
  switch (pluginId) {
    case "cmoa":
      return `https://www.cmoa.jp/title/${titleId}/`;
    case "booklive":
      return `https://booklive.jp/product/index/title_id/${titleId}`;
    case "momonga":
      return `https://momon-ga.com/manga/mo${titleId}/`;
    case "nhentai":
      return `https://nhentai.net/g/${titleId}/`;
    default:
      return null;
  }
}

async function copyToClipboard(text: string) {
  try {
    await Clipboard.setStringAsync(text);
    toast.success("コピーしました");
  } catch {
    toast.error("コピーに失敗しました");
  }
}

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: "キャンセル", style: "cancel" },
      { text: "OK", style: "destructive", onPress: onConfirm },
    ]);
  }
}


function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${h}:${min}`;
}

export default function TitleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");

  useFocusEffect(
    useCallback(() => {
      setSelected(new Set());
    }, [])
  );

  const { data: title, isLoading } = useQuery({
    queryKey: ["library", id],
    queryFn: () => getLibraryTitle(Number(id)),
    refetchInterval: (query) => {
      const vols = query.state.data?.volumes;
      if (!vols) return false;
      const hasActive = vols.some(
        (v) => v.status === "queued" || v.status === "downloading"
      );
      return hasActive ? 2000 : false;
    },
  });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: getAccounts,
  });

  const accountId = title
    ? accounts?.find((a) => a.pluginId === title.pluginId)?.id
    : undefined;

  const syncMutation = useMutation({
    mutationFn: (volumes: number[] | undefined) => syncTitle(Number(id), accountId, volumes),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      const source = PLUGIN_LABELS[title?.pluginId ?? ""] ?? title?.pluginId ?? "";
      const parts: string[] = [];
      if (data.totalVolumes != null) {
        parts.push(`${source}からタイトル情報を更新`);
      }
      if (data.newVolumes > 0) parts.push(`新刊${data.newVolumes}巻を追加`);
      if (data.checkedVolumes > 0) {
        parts.push(`${source}と同期しました`);
      }
      toast.success("同期完了", {
        description: parts.length > 0 ? parts.join("、") : undefined,
      });
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const downloadMutation = useMutation({
    mutationFn: (vols: number[] | "available" | "all" | "error") =>
      downloadVolumes(Number(id), vols, accountId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      toast.success("ダウンロード開始", { description: `${data.jobIds.length}巻のダウンロードをキューに追加しました。` });
      setSelected(new Set());
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteFromLibrary(Number(id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library"] });
      router.back();
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const updateTitleMutation = useMutation({
    mutationFn: (newTitle: string) => updateLibraryTitle(Number(id), { title: newTitle }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
      setIsEditingTitle(false);
      toast.success("タイトルを更新しました");
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const deleteVolumesMutation = useMutation({
    mutationFn: (vols: number[]) => deleteVolumes(Number(id), vols),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      toast.success("削除完了", {
        description: `${data.deletedCount}巻を削除${data.errors.length > 0 ? `（エラー: ${data.errors.join(", ")}）` : ""}`,
      });
      setSelected(new Set());
    },
    onError: (err: Error) => toast.error("エラー", { description: err.message }),
  });

  const toggleSelect = (vol: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(vol)) next.delete(vol);
      else next.add(vol);
      return next;
    });
  };

  if (isLoading || !title) {
    return (
      <View style={styles.container}>
        <ActivityIndicator
          size="large"
          style={{ marginTop: 40 }}
          color="#60a5fa"
        />
      </View>
    );
  }

  const isStandalone = title.contentType === "standalone";

  // Standalone helpers
  const saVol = isStandalone ? title.volumes[0] : null;
  const saCfg = saVol ? (STATUS_CONFIG[saVol.status] ?? STATUS_CONFIG.unknown) : STATUS_CONFIG.unknown;
  const saIsActive = saVol?.status === "queued" || saVol?.status === "downloading";
  const saIsBusy = downloadMutation.isPending || deleteVolumesMutation.isPending;

  // --- Series layout helpers ---
  const volumes = title.volumes.sort((a, b) => a.volumeNum - b.volumeNum);

  const counts: Record<StatusFilter, number> = {
    all: volumes.length,
    done: volumes.filter((v) => v.status === "done").length,
    available: volumes.filter((v) => v.status === "available").length,
    unavailable: volumes.filter((v) => v.status === "unavailable").length,
    other: volumes.filter((v) =>
      !["done", "available", "unavailable"].includes(v.status)
    ).length,
  };

  const filteredVolumes = volumes.filter((v) => {
    if (filter === "all") return true;
    if (filter === "other") return !["done", "available", "unavailable"].includes(v.status);
    return v.status === filter;
  });

  const filterChips: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "全て" },
    { key: "done", label: "取得済" },
    { key: "available", label: "取得可" },
    { key: "unavailable", label: "未購入" },
    { key: "other", label: "その他" },
  ];

  const allFilteredSelected = filteredVolumes.length > 0 &&
    filteredVolumes.every((v) => selected.has(v.volumeNum));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredVolumes.forEach((v) => next.delete(v.volumeNum));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredVolumes.forEach((v) => next.add(v.volumeNum));
        return next;
      });
    }
  };

  return (
    <View style={styles.wrapper}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Title info */}
        <View style={styles.titleSection}>
          <View style={styles.titleRow}>
            {title.coverUrl && (
              <Image source={{ uri: title.coverUrl }} style={styles.coverImage} />
            )}
            <View style={styles.titleInfo}>
              <View style={styles.titleTextRow}>
                {isEditingTitle ? (
                  <View style={styles.editTitleRow}>
                    <TextInput
                      style={styles.editTitleInput}
                      value={editTitle}
                      onChangeText={setEditTitle}
                      autoFocus
                      selectTextOnFocus
                      onSubmitEditing={() => {
                        const trimmed = editTitle.trim();
                        if (trimmed && trimmed !== title.title) {
                          updateTitleMutation.mutate(trimmed);
                        } else {
                          setIsEditingTitle(false);
                        }
                      }}
                    />
                    <TouchableOpacity
                      onPress={() => {
                        const trimmed = editTitle.trim();
                        if (trimmed && trimmed !== title.title) {
                          updateTitleMutation.mutate(trimmed);
                        } else {
                          setIsEditingTitle(false);
                        }
                      }}
                      hitSlop={8}
                      disabled={updateTitleMutation.isPending}
                    >
                      {updateTitleMutation.isPending ? (
                        <ActivityIndicator color="#4ade80" size="small" />
                      ) : (
                        <Ionicons name="checkmark" size={18} color="#4ade80" />
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setIsEditingTitle(false)}
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={18} color="#64748b" />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <Text style={[styles.titleText, { flex: 1 }]}>{title.title}</Text>
                    <TouchableOpacity
                      onPress={() => {
                        setEditTitle(title.title);
                        setIsEditingTitle(true);
                      }}
                      hitSlop={8}
                    >
                      <Ionicons name="pencil" size={14} color="#64748b" />
                    </TouchableOpacity>
                  </>
                )}
              </View>
              <Text style={styles.metaText}>
                {title.author ?? "著者不明"}
              </Text>
              <View style={styles.pluginRow}>
                <View style={styles.pluginBadge}>
                  <Text style={styles.pluginBadgeText}>{PLUGIN_LABELS[title.pluginId] ?? title.pluginId}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    const url = getExternalUrl(title.pluginId, title.titleId);
                    if (url) {
                      Platform.OS === "web" ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url);
                    }
                  }}
                  hitSlop={8}
                  style={styles.sourceLinkBtn}
                >
                  <Ionicons name="open-outline" size={13} color="#60a5fa" />
                </TouchableOpacity>
              </View>

              <View style={styles.titleActions}>
                <TouchableOpacity
                  style={styles.syncBtn}
                  onPress={() => syncMutation.mutate(undefined)}
                  disabled={syncMutation.isPending}
                >
                  {syncMutation.isPending ? (
                    <ActivityIndicator color="#60a5fa" size="small" />
                  ) : (
                    <>
                      <Ionicons name="sync" size={14} color="#60a5fa" />
                      <Text style={styles.syncBtnText}>同期</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    confirmAction(
                      "タイトルを削除",
                      `「${title.title}」をライブラリから削除しますか？`,
                      () => deleteMutation.mutate()
                    )
                  }
                  hitSlop={8}
                  style={styles.deleteBtn}
                >
                  <Ionicons name="trash-outline" size={14} color="#64748b" />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>

        {/* Genre tags (shown for both standalone and series) */}
        {title.genres.length > 0 && (
          <View style={styles.saTagRow}>
            {title.genres.map((tag) => (
              <View key={tag} style={styles.saTag}>
                <Text style={styles.saTagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Standalone: status + actions */}
        {isStandalone && saVol && (
          <>

            <View style={styles.saStatusCard}>
              <View style={styles.saStatusRow}>
                <View style={[styles.listStatusBadge, { backgroundColor: saCfg.bg }]}>
                  <Ionicons name={saCfg.icon} size={12} color={saCfg.fg} />
                  <Text style={[styles.listStatusText, { color: saCfg.fg, fontSize: 12 }]}>
                    {saCfg.label}
                  </Text>
                </View>
                {saIsActive && <ActivityIndicator color="#fb923c" size="small" />}
              </View>

              {saVol.status === "downloading" && saVol.jobProgress != null && saVol.jobProgress > 0 && (
                <View style={styles.volProgressRow}>
                  <View style={styles.volProgressBar}>
                    <View style={[styles.volProgressFill, { width: `${Math.round(saVol.jobProgress * 100)}%` }]} />
                  </View>
                  <Text style={styles.volProgressText}>{Math.round(saVol.jobProgress * 100)}%</Text>
                </View>
              )}
              {saVol.status === "downloading" && (saVol.jobProgress == null || saVol.jobProgress === 0) && saVol.jobMessage && /^\d+$/.test(saVol.jobMessage) && (
                <View style={styles.volPageCountRow}>
                  <Ionicons name="documents-outline" size={12} color="#60a5fa" />
                  <Text style={styles.volPageCountText}>{saVol.jobMessage}ページ DL済</Text>
                </View>
              )}

              {saVol.status === "done" && saVol.filePath && (
                <View style={styles.filePathRow}>
                  <Ionicons name="folder-outline" size={12} color="#64748b" style={{ marginTop: 2 }} />
                  <Text style={styles.saFilePath} numberOfLines={2} selectable>{saVol.filePath}</Text>
                  <TouchableOpacity onPress={() => copyToClipboard(saVol.filePath!)} hitSlop={8} style={styles.copyBtn}>
                    <Ionicons name="copy-outline" size={13} color="#64748b" />
                  </TouchableOpacity>
                </View>
              )}
              {saVol.downloadedAt && (
                <Text style={styles.saMetaItem}>{formatDate(saVol.downloadedAt)}</Text>
              )}
              {saVol.pageCount != null && (
                <Text style={styles.saMetaItem}>{saVol.pageCount}ページ</Text>
              )}
            </View>

            <View style={styles.saActions}>
              {(saVol.status === "available" || saVol.status === "done") && (
                <TouchableOpacity
                  style={styles.actionBtnPrimary}
                  onPress={() => downloadMutation.mutate([1])}
                  disabled={saIsBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="cloud-download" size={16} color="#fff" />
                      <Text style={styles.actionBtnPrimaryText}>
                        {saVol.status === "done" ? "再ダウンロード" : "ダウンロード"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
              {saVol.status === "error" && (
                <TouchableOpacity
                  style={styles.actionBtnPrimary}
                  onPress={() => downloadMutation.mutate([1])}
                  disabled={saIsBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="refresh" size={16} color="#fff" />
                      <Text style={styles.actionBtnPrimaryText}>再試行</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* Series: Error retry banner */}
        {!isStandalone && counts.other > 0 && volumes.some((v) => v.status === "error") && (
          <TouchableOpacity
            style={styles.retryBanner}
            onPress={() => downloadMutation.mutate("error")}
            disabled={downloadMutation.isPending}
          >
            {downloadMutation.isPending ? (
              <ActivityIndicator color="#f87171" size="small" />
            ) : (
              <>
                <Ionicons name="refresh" size={14} color="#f87171" />
                <Text style={styles.retryBannerText}>
                  エラー {volumes.filter((v) => v.status === "error").length}巻を再試行
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Series: Filter chips + select all */}
        {!isStandalone && (<>
        <View style={styles.filterSection}>
          <TouchableOpacity
            style={styles.selectAllBtn}
            onPress={toggleSelectAll}
          >
            <Ionicons
              name={allFilteredSelected ? "checkbox" : "square-outline"}
              size={16}
              color={allFilteredSelected ? "#60a5fa" : "#64748b"}
            />
            <Text style={[styles.selectAllText, allFilteredSelected && { color: "#60a5fa" }]}>
              全選択
            </Text>
          </TouchableOpacity>
          <View style={styles.filterRow}>
            {filterChips.map((chip) => {
              if (counts[chip.key] === 0 && chip.key !== "all") return null;
              const active = filter === chip.key;
              return (
                <TouchableOpacity
                  key={chip.key}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setFilter(chip.key)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      active && styles.filterChipTextActive,
                    ]}
                  >
                    {chip.label}
                    {chip.key !== "all" ? ` ${counts[chip.key]}` : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Volume list */}
        {filteredVolumes.map((vol) => {
          const cfg = STATUS_CONFIG[vol.status] ?? STATUS_CONFIG.unknown;
          const isSelected = selected.has(vol.volumeNum);

          return (
            <TouchableOpacity
              key={vol.id}
              style={[styles.listRow, isSelected && styles.listRowSelected]}
              onPress={() => toggleSelect(vol.volumeNum)}
              activeOpacity={0.7}
            >
              {/* Checkbox */}
              <View style={styles.listCheckbox}>
                <Ionicons
                  name={isSelected ? "checkbox" : "square-outline"}
                  size={18}
                  color={isSelected ? "#60a5fa" : "#475569"}
                />
              </View>

              {/* Thumbnail */}
              {vol.thumbnailUrl ? (
                <Image source={{ uri: vol.thumbnailUrl }} style={styles.listThumb} />
              ) : (
                <View style={[styles.listThumbFallback, { backgroundColor: cfg.bg }]}>
                  <Text style={[styles.listThumbNum, { color: cfg.fg }]}>
                    {vol.volumeNum}
                  </Text>
                </View>
              )}

              {/* Main content */}
              <View style={styles.listMain}>
                {/* Top row: volume label + status */}
                <View style={styles.listTopRow}>
                  <Text style={styles.listVolNum}>第{vol.volumeNum}巻</Text>
                  <View style={[styles.listStatusBadge, { backgroundColor: cfg.bg }]}>
                    <Ionicons name={cfg.icon} size={10} color={cfg.fg} />
                    <Text style={[styles.listStatusText, { color: cfg.fg }]}>
                      {cfg.label}
                    </Text>
                  </View>
                </View>

                {/* Download progress */}
                {vol.status === "downloading" && vol.jobProgress != null && vol.jobProgress > 0 && (
                  <View style={styles.volProgressRow}>
                    <View style={styles.volProgressBar}>
                      <View style={[styles.volProgressFill, { width: `${Math.round(vol.jobProgress * 100)}%` }]} />
                    </View>
                    <Text style={styles.volProgressText}>{Math.round(vol.jobProgress * 100)}%</Text>
                  </View>
                )}
                {vol.status === "downloading" && (vol.jobProgress == null || vol.jobProgress === 0) && vol.jobMessage && /^\d+$/.test(vol.jobMessage) && (
                  <View style={styles.volPageCountRow}>
                    <Ionicons name="documents-outline" size={11} color="#60a5fa" />
                    <Text style={styles.volPageCountText}>{vol.jobMessage}ページ DL済</Text>
                  </View>
                )}

                {/* File path */}
                {vol.status === "done" && vol.filePath && (
                  <View style={styles.filePathRow}>
                    <Ionicons name="folder-outline" size={11} color="#64748b" style={{ marginTop: 1 }} />
                    <Text style={styles.listFilePath} numberOfLines={2} selectable>
                      {vol.filePath}
                    </Text>
                    <TouchableOpacity onPress={() => copyToClipboard(vol.filePath!)} hitSlop={8} style={styles.copyBtn}>
                      <Ionicons name="copy-outline" size={12} color="#64748b" />
                    </TouchableOpacity>
                  </View>
                )}

                {/* Meta row */}
                <View style={styles.listMeta}>
                  {vol.pageCount != null && (
                    <Text style={styles.listMetaItem}>{vol.pageCount}p</Text>
                  )}
                  {vol.downloadedAt && (
                    <Text style={styles.listMetaItem}>
                      {formatDate(vol.downloadedAt)}
                    </Text>
                  )}
                  {vol.availabilityReason && vol.status !== "done" && (
                    <Text style={styles.listMetaReason} numberOfLines={1}>
                      {REASON_LABELS[vol.availabilityReason] ?? vol.availabilityReason}
                    </Text>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        {filteredVolumes.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>該当する巻がありません</Text>
          </View>
        )}

        {/* Bottom padding for selection bar */}
        <View style={{ height: selected.size > 0 ? 80 : 40 }} />
        </>)}

      </ScrollView>

      {/* Floating selection bar */}
      {!isStandalone && selected.size > 0 && (() => {
        const selectedVols = volumes.filter((v) => selected.has(v.volumeNum));
        const downloadable = selectedVols.filter((v) => v.status === "available" || v.status === "done" || v.status === "error");
        const retryable = selectedVols.filter((v) => v.status === "error");
        const deletable = selectedVols.filter((v) => v.status === "done");
        const isBusy = syncMutation.isPending || downloadMutation.isPending || deleteVolumesMutation.isPending;
        return (
          <View style={styles.selectionBar}>
            <Text style={styles.selectionText}>{selected.size}巻を選択中</Text>
            <View style={styles.selectionActions}>
              {/* Sync - always available */}
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => syncMutation.mutate(Array.from(selected))}
                disabled={isBusy}
              >
                {syncMutation.isPending ? (
                  <ActivityIndicator color="#60a5fa" size="small" />
                ) : (
                  <>
                    <Ionicons name="sync" size={15} color="#60a5fa" />
                    <Text style={styles.actionBtnText}>同期</Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Download */}
              {downloadable.length > 0 && (
                <TouchableOpacity
                  style={styles.actionBtnPrimary}
                  onPress={() => downloadMutation.mutate(Array.from(selected))}
                  disabled={isBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="cloud-download" size={15} color="#fff" />
                      <Text style={styles.actionBtnPrimaryText}>ダウンロード</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}

              {/* Delete files */}
              {deletable.length > 0 && (
                <TouchableOpacity
                  style={styles.actionBtnDanger}
                  onPress={() =>
                    confirmAction(
                      "ファイルを削除",
                      `${deletable.length}巻のダウンロード済みファイルを削除しますか？`,
                      () => deleteVolumesMutation.mutate(deletable.map((v) => v.volumeNum))
                    )
                  }
                  disabled={isBusy}
                >
                  {deleteVolumesMutation.isPending ? (
                    <ActivityIndicator color="#f87171" size="small" />
                  ) : (
                    <>
                      <Ionicons name="trash" size={15} color="#f87171" />
                      <Text style={styles.actionBtnDangerText}>削除</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: "#0f172a" },
  container: { flex: 1 },
  content: { padding: 16 },

  // Title section
  titleSection: { marginBottom: 16 },
  titleRow: { flexDirection: "row", gap: 14 },
  coverImage: {
    width: 72,
    height: 100,
    borderRadius: 6,
    backgroundColor: "#0f172a",
  },
  titleInfo: { flex: 1 },
  titleTextRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, flex: 1 },
  editTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  editTitleInput: {
    flex: 1,
    color: "#f1f5f9",
    fontSize: 18,
    fontWeight: "700",
    backgroundColor: "#1e293b",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#334155",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sourceLinkBtn: { padding: 2 },
  titleText: { color: "#f1f5f9", fontSize: 20, fontWeight: "700" },
  metaText: { color: "#94a3b8", fontSize: 13, marginTop: 4 },
  pluginRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  pluginBadge: {
    backgroundColor: "#334155",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pluginBadgeText: { color: "#94a3b8", fontSize: 10, fontWeight: "600" },
  // Title actions
  titleActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  syncBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#1e293b",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  syncBtnText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },
  deleteBtn: { padding: 6 },

  // Filter section
  filterSection: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  filterRow: {
    flexDirection: "row",
    gap: 6,
    flex: 1,
    justifyContent: "flex-end",
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "#1e293b",
  },
  filterChipActive: {
    backgroundColor: "#334155",
  },
  filterChipText: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
  },
  filterChipTextActive: {
    color: "#e2e8f0",
  },
  selectAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selectAllText: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "600",
  },

  // List row
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  listRowSelected: {
    backgroundColor: "#172554",
  },
  listCheckbox: {
    width: 32,
    alignItems: "center",
  },
  listThumb: {
    width: 36,
    height: 50,
    borderRadius: 4,
    backgroundColor: "#1e293b",
  },
  listThumbFallback: {
    width: 36,
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  listThumbNum: {
    fontSize: 14,
    fontWeight: "700",
  },
  listMain: {
    flex: 1,
    marginLeft: 10,
    gap: 2,
  },
  listTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  listVolNum: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },
  listStatusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  listStatusText: {
    fontSize: 10,
    fontWeight: "600",
  },
  filePathRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
    marginTop: 2,
  },
  copyBtn: {
    padding: 2,
  },
  listFilePath: {
    flex: 1,
    color: "#94a3b8",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  listMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  listMetaItem: {
    color: "#64748b",
    fontSize: 11,
  },
  listMetaReason: {
    color: "#64748b",
    fontSize: 11,
    flex: 1,
  },

  // Volume progress
  volProgressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 3,
  },
  volProgressBar: {
    flex: 1,
    height: 3,
    backgroundColor: "#334155",
    borderRadius: 2,
    overflow: "hidden",
  },
  volProgressFill: {
    height: "100%",
    backgroundColor: "#3b82f6",
    borderRadius: 2,
  },
  volProgressText: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "600",
    width: 28,
    textAlign: "right",
  },
  volPageCountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 3,
  },
  volPageCountText: {
    color: "#60a5fa",
    fontSize: 10,
    fontWeight: "600",
  },

  // Empty state
  emptyState: {
    paddingVertical: 32,
    alignItems: "center",
  },
  emptyText: {
    color: "#475569",
    fontSize: 13,
  },

  // Floating selection bar
  selectionBar: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#172554",
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: Platform.OS === "ios" ? 28 : 12,
    borderTopWidth: 1,
    borderTopColor: "#1e3a5f",
  },
  selectionText: { color: "#93c5fd", fontSize: 14, fontWeight: "600" },
  selectionActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionBtnText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },
  actionBtnPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionBtnPrimaryText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  actionBtnDanger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#451a1a",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionBtnDangerText: { color: "#f87171", fontSize: 13, fontWeight: "600" },

  // Retry banner
  retryBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#450a0a",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  retryBannerText: {
    color: "#f87171",
    fontSize: 13,
    fontWeight: "600",
  },

  // Standalone layout
  saTagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  saTag: {
    backgroundColor: "#1e293b",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  saTagText: {
    color: "#94a3b8",
    fontSize: 11,
  },
  saStatusCard: {
    backgroundColor: "#1e293b",
    borderRadius: 8,
    padding: 14,
    marginTop: 16,
    gap: 6,
  },
  saStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  saFilePath: {
    flex: 1,
    color: "#94a3b8",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  saMetaItem: {
    color: "#64748b",
    fontSize: 12,
  },
  saActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
  },
});
