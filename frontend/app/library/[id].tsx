import { useState, useCallback, useEffect, useRef } from "react";
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
  Modal,
  Linking,
  TextInput,
  ImageBackground,
} from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter, useFocusEffect, useIsFocused, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { colors, spacing, radius, coverShadow } from "../../src/theme";

const STATUS_CONFIG: Record<
  string,
  {
    bg: string;
    fg: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }
> = {
  done: { bg: colors.successBg, fg: colors.success, label: "取得済", icon: "checkmark-circle" },
  available: { bg: colors.infoBg, fg: colors.accentLight, label: "取得可", icon: "cloud-download-outline" },
  unavailable: { bg: colors.neutralBg, fg: colors.neutral, label: "未購入", icon: "lock-closed-outline" },
  queued: { bg: colors.warningBg, fg: colors.yellow, label: "待機中", icon: "time-outline" },
  downloading: { bg: colors.orangeBg, fg: colors.orange, label: "取得中", icon: "arrow-down-circle" },
  error: { bg: colors.errorBg, fg: colors.error, label: "エラー", icon: "alert-circle" },
  unknown: { bg: colors.bgElevated, fg: colors.textSecondary, label: "不明", icon: "help-circle-outline" },
};

type StatusFilter = "all" | "done" | "available" | "unavailable" | "other";

import { SOURCE_LABELS, SOURCE_COLORS, DEFAULT_SOURCE_COLOR } from "../../src/constants";

const REASON_LABELS: Record<string, string> = {
  purchased: "購入済み",
  not_purchased: "未購入",
  free: "無料公開",
  waitfree_read: "閲覧中（期限あり）",
  wait_free: "待てば¥0",
  subscription: "読み放題対象",
  rate_limited: "レート制限",
  unknown: "不明",
};

/** Check if a freeUntil date has expired (date is exclusive end: expired when today > freeUntil) */
function isFreeExpired(freeUntil: string | null): boolean {
  if (!freeUntil) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(freeUntil + "T23:59:59");
  return today > expiry;
}

function formatFreeUntil(freeUntil: string): string {
  const [, m, d] = freeUntil.split("-");
  return `${parseInt(m)}/${parseInt(d)}まで無料`;
}

/** Is this volume downloadable considering free expiry? */
function isDownloadable(vol: { status: string; availabilityReason: string | null; freeUntil: string | null }): boolean {
  if (vol.status === "done" || vol.status === "error") return true;
  if (vol.status !== "available") return false;
  // If reason is "free", check expiry
  if (vol.availabilityReason === "free" && isFreeExpired(vol.freeUntil)) return false;
  return true;
}

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
    case "piccoma":
      return `https://piccoma.com/web/product/${titleId}`;
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
  const { id, autoSync } = useLocalSearchParams<{ id: string; autoSync?: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [unitTab, setUnitTab] = useState<"ep" | "vol">("ep");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setSelected(new Set());
    }, [])
  );

  // Clear selection when switching unit tab
  const switchUnitTab = (tab: "ep" | "vol") => {
    setUnitTab(tab);
    setSelected(new Set());
    setFilter("all");
  };

  const { data: title, isLoading } = useQuery({
    queryKey: ["library", id],
    queryFn: () => getLibraryTitle(Number(id)),
    refetchInterval: (query) => {
      if (!isFocused) return false;
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
      const source = SOURCE_LABELS[title?.pluginId ?? ""] ?? title?.pluginId ?? "";
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

  // Auto-sync when navigated from library add
  const autoSyncFired = useRef(false);
  useEffect(() => {
    if (autoSync === "true" && !autoSyncFired.current && title && accountId !== undefined) {
      autoSyncFired.current = true;
      syncMutation.mutate(undefined);
    }
  }, [autoSync, title, accountId]);

  const downloadMutation = useMutation({
    mutationFn: ({ vols, unit }: { vols: number[] | "available" | "all" | "error"; unit?: string }) =>
      downloadVolumes(Number(id), vols, accountId, unit),
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
    mutationFn: (params: { title?: string; author?: string }) => updateLibraryTitle(Number(id), params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library", id] });
      queryClient.invalidateQueries({ queryKey: ["library"] });
      setIsEditingTitle(false);
      toast.success("更新しました");
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

  const insets = useSafeAreaInsets();

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
      <View style={[styles.wrapper, { paddingTop: insets.top, justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator
          size="large"
          color={colors.accentLight}
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
  const allVolumes = title.volumes.sort((a, b) => a.volumeNum - b.volumeNum);

  // Detect which units are present
  const hasEp = allVolumes.some((v) => (v.unit ?? "vol") === "ep");
  const hasVol = allVolumes.some((v) => (v.unit ?? "vol") === "vol");
  const hasBothUnits = hasEp && hasVol;
  const activeUnit = hasBothUnits ? unitTab : (hasEp ? "ep" : "vol");

  // Filter by active unit tab
  const volumes = hasBothUnits
    ? allVolumes.filter((v) => (v.unit ?? "vol") === activeUnit)
    : allVolumes;

  // Piccoma episode thumbnail fallback: use the nearest preceding episode's thumbnail
  const epThumbFallback = new Map<number, string>();
  if (title.pluginId === "piccoma" && activeUnit === "ep") {
    let lastThumb: string | null = null;
    for (const v of volumes) {
      if (v.thumbnailUrl) lastThumb = v.thumbnailUrl;
      else if (lastThumb) epThumbFallback.set(v.volumeNum, lastThumb);
    }
  }

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

  const isWeb = Platform.OS === "web";

  const renderTitleInfo = () => (
    <>
      {isEditingTitle ? (
        <View style={styles.titleTextRow}>
          <View style={styles.editFieldsContainer}>
            <View style={styles.editTitleRow}>
              <TextInput
                style={[styles.editTitleInput, isWeb && { outlineStyle: "none" } as any]}
                value={editTitle}
                onChangeText={setEditTitle}
                autoFocus
                selectTextOnFocus
                placeholder="タイトル"
                placeholderTextColor={colors.textDim}
              />
            </View>
            <View style={styles.editTitleRow}>
              <TextInput
                style={[styles.editAuthorInput, isWeb && { outlineStyle: "none" } as any]}
                value={editAuthor}
                onChangeText={setEditAuthor}
                placeholder="著者"
                placeholderTextColor={colors.textDim}
              />
            </View>
            <View style={styles.editButtonRow}>
              <TouchableOpacity
                onPress={() => {
                  const trimmedTitle = editTitle.trim();
                  const trimmedAuthor = editAuthor.trim();
                  const params: { title?: string; author?: string } = {};
                  if (trimmedTitle && trimmedTitle !== title.title) params.title = trimmedTitle;
                  if (trimmedAuthor !== (title.author ?? "")) params.author = trimmedAuthor;
                  if (Object.keys(params).length > 0) {
                    updateTitleMutation.mutate(params);
                  } else {
                    setIsEditingTitle(false);
                  }
                }}
                hitSlop={8}
                disabled={updateTitleMutation.isPending}
              >
                {updateTitleMutation.isPending ? (
                  <ActivityIndicator color={colors.success} size="small" />
                ) : (
                  <Ionicons name="checkmark" size={18} color={colors.success} />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setIsEditingTitle(false)} hitSlop={8}>
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.titleText}>{title.title}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaText}>{title.author ?? "著者不明"}</Text>
            <TouchableOpacity
              onPress={() => {
                setEditTitle(title.title);
                setEditAuthor(title.author ?? "");
                setIsEditingTitle(true);
              }}
              hitSlop={8}
            >
              <Ionicons name="pencil-outline" size={13} color="rgba(255,255,255,0.3)" />
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.pluginBadge, { backgroundColor: (SOURCE_COLORS[title.pluginId] ?? DEFAULT_SOURCE_COLOR).bg, alignSelf: "flex-start", marginTop: 6 }]}
            onPress={() => {
              const extUrl = getExternalUrl(title.pluginId, title.titleId);
              if (extUrl) {
                isWeb ? Linking.openURL(extUrl) : WebBrowser.openBrowserAsync(extUrl);
              }
            }}
          >
            <Text style={[styles.pluginBadgeText, { color: (SOURCE_COLORS[title.pluginId] ?? DEFAULT_SOURCE_COLOR).text }]}>
              {SOURCE_LABELS[title.pluginId] ?? title.pluginId}
            </Text>
            <Ionicons name="open-outline" size={11} color={(SOURCE_COLORS[title.pluginId] ?? DEFAULT_SOURCE_COLOR).text} />
          </TouchableOpacity>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.heroActionBtnWide}
              onPress={() =>
                confirmAction(
                  "購入状態を同期",
                  `全巻の購入状態をサイトと同期しますか？`,
                  () => syncMutation.mutate(undefined)
                )
              }
              disabled={syncMutation.isPending}
            >
              {syncMutation.isPending ? (
                <ActivityIndicator color={colors.accentLight} size="small" />
              ) : (
                <>
                  <Ionicons name="sync" size={18} color={colors.accentLight} />
                  <Text style={styles.heroActionBtnText}>同期</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.heroActionBtn}
              onPress={() =>
                confirmAction(
                  "タイトルを削除",
                  `「${title.title}」をライブラリから削除しますか？`,
                  () => deleteMutation.mutate()
                )
              }
            >
              <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </>
      )}
    </>
  );

  return (
    <View style={styles.wrapper}>
      {/* Hide default Stack header — we render our own back button */}
      <Stack.Screen options={{ headerShown: false }} />

      {/* Hero header — full-bleed on all platforms */}
      <View style={styles.heroSection}>
        {title.coverUrl ? (
          <ImageBackground
            source={{ uri: title.coverUrl }}
            style={styles.heroBg}
            blurRadius={isWeb ? 30 : 0}
            resizeMode="cover"
          >
            {!isWeb ? (
              <BlurView intensity={80} tint="dark" style={styles.heroOverlay}>
                <LinearGradient
                  colors={["transparent", "rgba(10,15,26,0.4)", colors.bg]}
                  locations={[0, 0.5, 1]}
                  style={StyleSheet.absoluteFillObject}
                />
              </BlurView>
            ) : (
              <View style={[styles.heroOverlay, { backgroundColor: "rgba(10,15,26,0.65)" }]}>
                <LinearGradient
                  colors={["transparent", colors.bg]}
                  style={styles.heroGradient}
                />
              </View>
            )}
          </ImageBackground>
        ) : (
          <LinearGradient
            colors={["#1a1a2e", "#16213e", colors.bg]}
            style={styles.heroBgFallback}
          />
        )}

        {/* Back button overlay (mobile only) */}
        {!isWeb && (
          <TouchableOpacity
            style={[styles.heroBackBtn, { top: insets.top }]}
            onPress={() => router.canGoBack() ? router.back() : router.replace("/")}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={28} color={colors.white} />
          </TouchableOpacity>
        )}

        <View style={[styles.heroContent, { paddingTop: insets.top + (isWeb ? 16 : 54) }]}>
          {title.coverUrl && (
            <TouchableOpacity onPress={() => setPreviewImage(title.coverUrl!)} activeOpacity={0.8}>
              <View style={styles.heroCoverWrap}>
                <Image source={{ uri: title.coverUrl }} style={styles.heroCover} />
              </View>
            </TouchableOpacity>
          )}
          <View style={styles.heroInfo}>
            {renderTitleInfo()}
          </View>
        </View>
      </View>

      {/* Content below hero */}
      <View style={styles.contentArea}>
        {/* Genre tags (shown for both standalone and series) */}
        {((title.displayGenres ?? title.genres).length > 0) && (
          <View style={[styles.saTagRow, styles.contentPadding]}>
            {(title.displayGenres ?? title.genres).map((tag) => (
              <View key={tag} style={styles.saTag}>
                <Text style={styles.saTagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Standalone: status + actions (in ScrollView since content is short) */}
        {isStandalone && saVol && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.contentPadding}>

            <View style={styles.saStatusCard}>
              <View style={[styles.listStatusBadge, { backgroundColor: saCfg.bg, alignSelf: "flex-start" }]}>
                <Ionicons name={saCfg.icon} size={10} color={saCfg.fg} />
                <Text style={[styles.listStatusText, { color: saCfg.fg }]}>
                  {saCfg.label}
                </Text>
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
                  <Ionicons name="documents-outline" size={12} color={colors.accentLight} />
                  <Text style={styles.volPageCountText}>{saVol.jobMessage}ページ DL済</Text>
                </View>
              )}

              {saVol.status === "done" && saVol.filePath && (
                <View style={styles.filePathRow}>
                  <Ionicons name="folder-outline" size={12} color={colors.textMuted} style={{ marginTop: 2 }} />
                  <Text style={styles.saFilePath} numberOfLines={2} selectable>{saVol.filePath}</Text>
                  <TouchableOpacity onPress={() => copyToClipboard(saVol.filePath!)} hitSlop={8} style={styles.copyBtn}>
                    <Ionicons name="copy-outline" size={13} color={colors.textMuted} />
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
                  style={styles.saActionBtn}
                  onPress={() => downloadMutation.mutate({ vols: [1] })}
                  disabled={saIsBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color={colors.accentLight} size="small" />
                  ) : (
                    <>
                      <Ionicons name="cloud-download" size={18} color={colors.accentLight} />
                      <Text style={styles.saActionBtnText}>
                        {saVol.status === "done" ? "再ダウンロード" : "ダウンロード"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
              {saVol.status === "error" && (
                <TouchableOpacity
                  style={styles.saActionBtn}
                  onPress={() => downloadMutation.mutate({ vols: [1] })}
                  disabled={saIsBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color={colors.accentLight} size="small" />
                  ) : (
                    <>
                      <Ionicons name="refresh" size={18} color={colors.accentLight} />
                      <Text style={styles.saActionBtnText}>再試行</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        )}

        {/* Series controls (fixed, not scrollable) */}
        {!isStandalone && (<>
        {/* Series: Error retry banner */}
        {counts.other > 0 && volumes.some((v) => v.status === "error") && (
          <TouchableOpacity
            style={[styles.retryBanner, { marginHorizontal: 16 }]}
            onPress={() => downloadMutation.mutate({ vols: "error", unit: hasBothUnits ? activeUnit : undefined })}
            disabled={downloadMutation.isPending}
          >
            {downloadMutation.isPending ? (
              <ActivityIndicator color={colors.error} size="small" />
            ) : (
              <>
                <Ionicons name="refresh" size={14} color={colors.error} />
                <Text style={styles.retryBannerText}>
                  エラー {volumes.filter((v) => v.status === "error").length}{activeUnit === "ep" ? "話" : "巻"}を再試行
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {/* Series: Unit tabs (話読み / 巻読み) */}
        {hasBothUnits && (
          <View style={styles.contentPadding}>
            <View style={styles.unitTabRow}>
              <TouchableOpacity
                style={[styles.unitTab, activeUnit === "ep" && styles.unitTabActive]}
                onPress={() => switchUnitTab("ep")}
              >
                <Text style={[styles.unitTabText, activeUnit === "ep" && styles.unitTabTextActive]}>
                  話読み {allVolumes.filter((v) => (v.unit ?? "vol") === "ep").length}話
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.unitTab, activeUnit === "vol" && styles.unitTabActive]}
                onPress={() => switchUnitTab("vol")}
              >
                <Text style={[styles.unitTabText, activeUnit === "vol" && styles.unitTabTextActive]}>
                  巻読み {allVolumes.filter((v) => (v.unit ?? "vol") === "vol").length}巻
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Series: Filter chips + select all */}
        <View style={[styles.filterSection, styles.contentPadding]}>
          <TouchableOpacity
            style={styles.selectAllBtn}
            onPress={toggleSelectAll}
          >
            <Ionicons
              name={allFilteredSelected ? "checkbox" : "square-outline"}
              size={16}
              color={allFilteredSelected ? colors.accentLight : colors.textMuted}
            />
            <Text style={[styles.selectAllText, allFilteredSelected && { color: colors.accentLight }]}>
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

        {/* Series: Volume list (scrollable) */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.contentPadding, { paddingBottom: selected.size > 0 ? 80 : 40 }]}>
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
                    color={isSelected ? colors.accentLight : colors.textDim}
                  />
                </View>

                {/* Thumbnail */}
                {(vol.thumbnailUrl || epThumbFallback.has(vol.volumeNum)) ? (
                  <TouchableOpacity onPress={() => setPreviewImage((vol.thumbnailUrl ?? epThumbFallback.get(vol.volumeNum))!)} activeOpacity={0.8}>
                    <Image source={{ uri: (vol.thumbnailUrl ?? epThumbFallback.get(vol.volumeNum))! }} style={styles.listThumb} />
                  </TouchableOpacity>
                ) : (
                  <View style={styles.listThumbFallback}>
                    <Text style={styles.listThumbNum}>
                      {vol.volumeNum}
                    </Text>
                  </View>
                )}

                {/* Main content */}
                <View style={styles.listMain}>
                  {/* Top row: volume label + status */}
                  <View style={styles.listTopRow}>
                    <Text style={styles.listVolNum}>第{vol.volumeNum}{(vol.unit ?? "vol") === "ep" ? "話" : "巻"}</Text>
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
                      <Ionicons name="documents-outline" size={11} color={colors.accentLight} />
                      <Text style={styles.volPageCountText}>{vol.jobMessage}ページ DL済</Text>
                    </View>
                  )}

                  {/* File path */}
                  {vol.status === "done" && vol.filePath && (
                    <View style={styles.filePathRow}>
                      <Ionicons name="folder-outline" size={11} color={colors.textMuted} style={{ marginTop: 1 }} />
                      <Text style={styles.listFilePath} numberOfLines={2} selectable>
                        {vol.filePath}
                      </Text>
                      <TouchableOpacity onPress={() => copyToClipboard(vol.filePath!)} hitSlop={8} style={styles.copyBtn}>
                        <Ionicons name="copy-outline" size={12} color={colors.textMuted} />
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
                      <Text style={[
                        styles.listMetaReason,
                        vol.availabilityReason === "free" && !isFreeExpired(vol.freeUntil) && styles.listMetaFree,
                        vol.availabilityReason === "free" && isFreeExpired(vol.freeUntil) && styles.listMetaExpired,
                      ]} numberOfLines={1}>
                        {vol.availabilityReason === "free" && vol.freeUntil
                          ? (isFreeExpired(vol.freeUntil) ? `無料期間終了 (${formatFreeUntil(vol.freeUntil)})` : formatFreeUntil(vol.freeUntil))
                          : (REASON_LABELS[vol.availabilityReason] ?? vol.availabilityReason)}
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
        </ScrollView>
        </>)}
      </View>

      {/* Image preview modal */}
      <Modal
        visible={!!previewImage}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewImage(null)}
      >
        <TouchableOpacity
          style={styles.previewOverlay}
          activeOpacity={1}
          onPress={() => setPreviewImage(null)}
        >
          {previewImage && (
            <Image
              source={{ uri: previewImage }}
              style={styles.previewImage}
              resizeMode="contain"
            />
          )}
        </TouchableOpacity>
      </Modal>

      {/* Floating selection bar */}
      {!isStandalone && selected.size > 0 && (() => {
        const selectedVols = volumes.filter((v) => selected.has(v.volumeNum));
        const downloadable = selectedVols.filter((v) => isDownloadable(v));
        const retryable = selectedVols.filter((v) => v.status === "error");
        const deletable = selectedVols.filter((v) => v.status === "done");
        const isBusy = syncMutation.isPending || downloadMutation.isPending || deleteVolumesMutation.isPending;
        const unitLabel = activeUnit === "ep" ? "話" : "巻";
        return (
          <View style={styles.selectionBar}>
            <View style={styles.selectionBadge}>
              <Text style={styles.selectionBadgeText}>{selected.size}</Text>
            </View>

            <View style={styles.selectionActions}>
              {/* Sync */}
              <TouchableOpacity
                style={styles.selBarBtn}
                onPress={() =>
                  confirmAction(
                    "購入状態を同期",
                    `選択した${selected.size}${unitLabel}の購入状態をサイトと同期しますか？`,
                    () => syncMutation.mutate(Array.from(selected))
                  )
                }
                disabled={isBusy}
              >
                {syncMutation.isPending ? (
                  <ActivityIndicator color={colors.accentLight} size="small" />
                ) : (
                  <>
                    <Ionicons name="sync" size={18} color={colors.accentLight} />
                    <Text style={styles.selBarBtnText}>同期</Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Download */}
              {downloadable.length > 0 && (
                <TouchableOpacity
                  style={styles.selBarBtn}
                  onPress={() => downloadMutation.mutate({ vols: Array.from(selected), unit: hasBothUnits ? activeUnit : undefined })}
                  disabled={isBusy}
                >
                  {downloadMutation.isPending ? (
                    <ActivityIndicator color={colors.accentLight} size="small" />
                  ) : (
                    <>
                      <Ionicons name="cloud-download" size={18} color={colors.accentLight} />
                      <Text style={styles.selBarBtnText}>ダウンロード</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}

              {/* Delete files */}
              {deletable.length > 0 && (
                <TouchableOpacity
                  style={styles.heroActionBtn}
                  onPress={() =>
                    confirmAction(
                      "ファイルを削除",
                      `${deletable.length}${unitLabel}のダウンロード済みファイルを削除しますか？`,
                      () => deleteVolumesMutation.mutate(deletable.map((v) => v.volumeNum))
                    )
                  }
                  disabled={isBusy}
                >
                  {deleteVolumesMutation.isPending ? (
                    <ActivityIndicator color={colors.textMuted} size="small" />
                  ) : (
                    <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
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
  wrapper: { flex: 1, backgroundColor: colors.bg },
  contentArea: { flex: 1 },
  contentPadding: { paddingHorizontal: 16 },

  // Hero section — full-bleed, extends behind status bar
  heroSection: {
    position: "relative",
    marginBottom: 8,
    paddingBottom: 16,
  },
  heroBg: {
    ...StyleSheet.absoluteFillObject,
  },
  heroBgFallback: {
    ...StyleSheet.absoluteFillObject,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  heroGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  heroBackBtn: {
    position: "absolute",
    left: 14,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroContent: {
    flexDirection: "row",
    gap: 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  heroCoverWrap: {
    ...coverShadow,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  heroCover: {
    width: 100,
    height: 142,
    borderRadius: radius.sm,
  },
  heroInfo: { flex: 1, paddingTop: 0 },
  titleTextRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, flex: 1 },
  editFieldsContainer: {
    flex: 1,
    gap: 6,
  },
  editTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  editButtonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  editTitleInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    backgroundColor: "rgba(30,41,59,0.8)",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  editAuthorInput: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    backgroundColor: "rgba(30,41,59,0.8)",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  titleText: { color: colors.textPrimary, fontSize: 19, fontWeight: "800", letterSpacing: -0.3, lineHeight: 24 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  metaText: { color: colors.textSecondary, fontSize: 13 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: "auto",
    paddingTop: 10,
    flexWrap: "wrap",
  },
  heroActionBtn: {
    padding: 8,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  heroActionBtnWide: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  heroActionBtnText: { color: colors.accentLight, fontSize: 13, fontWeight: "600" },
  pluginBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pluginBadgeText: { fontSize: 11, fontWeight: "600" },

  // Unit tabs
  unitTabRow: {
    flexDirection: "row",
    gap: 0,
    marginBottom: 12,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  unitTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  unitTabActive: {
    backgroundColor: colors.accentDim,
  },
  unitTabText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
  },
  unitTabTextActive: {
    color: colors.textPrimary,
  },

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
    borderRadius: radius.xl,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: "transparent",
  },
  filterChipActive: {
    backgroundColor: colors.accentDim,
    borderColor: "rgba(59,130,246,0.3)",
  },
  filterChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  filterChipTextActive: {
    color: colors.textPrimary,
  },
  selectAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selectAllText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },

  // List row
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listRowSelected: {
    backgroundColor: colors.infoBg,
    borderRadius: radius.sm,
  },
  listCheckbox: {
    width: 32,
    alignItems: "center",
  },
  listThumb: {
    width: 36,
    height: 50,
    borderRadius: 4,
    backgroundColor: colors.bgElevated,
  },
  listThumbFallback: {
    width: 36,
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgElevated,
  },
  listThumbNum: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.textMuted,
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
    color: colors.textLight,
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
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  listMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  listMetaItem: {
    color: colors.textMuted,
    fontSize: 11,
  },
  listMetaReason: {
    color: colors.textMuted,
    fontSize: 11,
    flex: 1,
  },
  listMetaFree: {
    color: colors.success,
  },
  listMetaExpired: {
    color: colors.error,
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
    backgroundColor: colors.borderAccent,
    borderRadius: 2,
    overflow: "hidden",
  },
  volProgressFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  volProgressText: {
    color: colors.textSecondary,
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
    color: colors.accentLight,
    fontSize: 10,
    fontWeight: "600",
  },

  // Empty state
  emptyState: {
    paddingVertical: 32,
    alignItems: "center",
  },
  emptyText: {
    color: colors.textDim,
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
    gap: 12,
    backgroundColor: colors.bgCard,
    paddingLeft: 20,
    paddingRight: 24,
    paddingVertical: 10,
    paddingBottom: Platform.OS === "ios" ? 28 : 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  selectionBadge: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    minWidth: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  selectionBadgeText: { color: colors.white, fontSize: 13, fontWeight: "700" },
  selectionActions: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 12 },
  selBarBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  selBarBtnText: { color: colors.accentLight, fontSize: 13, fontWeight: "600" },

  // Retry banner
  retryBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.errorBg,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  retryBannerText: {
    color: colors.error,
    fontSize: 13,
    fontWeight: "600",
  },

  // Standalone layout
  saTagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
    marginBottom: 6,
  },
  saTag: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.xl,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saTagText: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  saStatusCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: 14,
    marginTop: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  saFilePath: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  saMetaItem: {
    color: colors.textMuted,
    fontSize: 12,
  },
  // Image preview modal
  previewOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    justifyContent: "center",
    alignItems: "center",
  },
  previewImage: {
    width: "45%",
    height: "40%",
  },

  saActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
  },
  saActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  saActionBtnText: { color: colors.accentLight, fontSize: 14, fontWeight: "600" },
});
