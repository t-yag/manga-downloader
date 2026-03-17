import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { toast } from "../../src/toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  updateSettings,
  getAccounts,
  createAccount,
  updateAccount,
  loginAccount,
  clearAccountSession,
  getPlugins,
  healthCheck,
  getBaseUrl,
  setBaseUrl,
  type Account,
  type PluginInfo,
} from "../../src/api/client";
import { SOURCE_COLORS, DEFAULT_SOURCE_COLOR } from "../../src/constants";

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [connected, setConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null);
  const [newAccEmail, setNewAccEmail] = useState("");
  const [newAccPassword, setNewAccPassword] = useState("");

  const [basePath, setBasePath] = useState("");
  const [pathTemplate, setPathTemplate] = useState("");
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  useEffect(() => {
    if (settings) {
      setBasePath((settings["download.basePath"] as string) ?? "./data/downloads");
      setPathTemplate((settings["download.pathTemplate"] as string) ?? "{title}/[{author}] {title} 第{volume:2}{unit_ja} - ({tags})");
    }
  }, [settings]);

  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: getAccounts,
  });

  const { data: plugins = [] } = useQuery({
    queryKey: ["plugins"],
    queryFn: getPlugins,
  });

  const testConnection = async () => {
    setTesting(true);
    setBaseUrl(apiUrl);
    try {
      await healthCheck();
      setConnected(true);
      queryClient.invalidateQueries();
    } catch {
      setConnected(false);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    testConnection();
  }, []);

  const updateDownloadSettingsMutation = useMutation({
    mutationFn: () =>
      updateSettings({
        "download.basePath": basePath,
        "download.pathTemplate": pathTemplate,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("ダウンロード設定を保存しました。");
    },
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  const addAccountMutation = useMutation({
    mutationFn: (pluginId: string) =>
      createAccount({
        pluginId,
        label: newAccEmail,
        credentials: { email: newAccEmail, password: newAccPassword },
      }),
    onSuccess: async (account) => {
      setNewAccEmail("");
      setNewAccPassword("");
      setExpandedPluginId(null);
      toast.success("アカウントを追加しました。ログイン中...");
      try {
        await loginAccount(account.id);
        toast.success("ログインしました。");
      } catch (err: any) {
        toast.error("ログイン失敗", { description: err.message });
      }
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  const updateAccountMutation = useMutation({
    mutationFn: (accountId: number) =>
      updateAccount(accountId, {
        label: newAccEmail,
        credentials: { email: newAccEmail, password: newAccPassword },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setNewAccEmail("");
      setNewAccPassword("");
      setExpandedPluginId(null);
      toast.success("アカウント情報を更新しました。");
    },
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  const loginMutation = useMutation({
    mutationFn: (accountId: number) => loginAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("ログインしました。");
    },
    onError: (err: Error) => {
      toast.error("ログイン失敗", { description: err.message });
    },
  });

  const clearSessionMutation = useMutation({
    mutationFn: (accountId: number) => clearAccountSession(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("セッションを破棄しました。");
    },
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  return (
    <ScrollView style={styles.container}>
      {/* Server Connection */}
      <View style={[styles.sectionHeaderRow, { marginTop: 0 }]}>
        <Ionicons name="server-outline" size={16} color="#94a3b8" />
        <Text style={styles.sectionLabel}>サーバー接続</Text>
      </View>
      <View style={styles.section}>
        <Text style={[styles.fieldLabel, { marginTop: 0 }]}>サーバーURL</Text>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="http://192.168.1.x:3000"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        <View style={styles.connectionRow}>
          <TouchableOpacity
            style={styles.btn}
            onPress={testConnection}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>接続テスト</Text>
            )}
          </TouchableOpacity>
          {connected !== null && (
            <View
              style={[
                styles.connectionStatus,
                connected ? styles.connectionOk : styles.connectionErr,
              ]}
            >
              <Ionicons
                name={connected ? "checkmark-circle" : "close-circle"}
                size={16}
                color={connected ? "#4ade80" : "#f87171"}
              />
              <Text style={connected ? styles.statusOk : styles.statusErr}>
                {connected ? "接続OK" : "接続失敗"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Download Settings */}
      <View style={styles.sectionHeaderRow}>
        <Ionicons name="download-outline" size={16} color="#94a3b8" />
        <Text style={styles.sectionLabel}>ダウンロード設定</Text>
      </View>
      <View style={styles.section}>
        <Text style={[styles.fieldLabel, { marginTop: 0 }]}>ベースディレクトリ</Text>
        <TextInput
          style={styles.input}
          value={basePath}
          onChangeText={setBasePath}
          placeholder="./data/downloads"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        <View style={styles.fieldLabelRow}>
          <Text style={[styles.fieldLabel, { marginTop: 0, marginBottom: 0 }]}>パステンプレート</Text>
          <TouchableOpacity
            onPress={() => setShowTemplateInfo((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={showTemplateInfo ? "information-circle" : "information-circle-outline"}
              size={16}
              color={showTemplateInfo ? "#60a5fa" : "#64748b"}
            />
          </TouchableOpacity>
        </View>
        {showTemplateInfo && (
          <View style={styles.templateInfoBox}>
            <Text style={styles.templateInfoTitle}>テンプレート変数</Text>
            {[
              ["{plugin}", "データソースID（例: cmoa, piccoma）"],
              ["{title}", "作品タイトル"],
              ["{unit}", "巻・話の種別（vol, ep）"],
              ["{unit_ja}", "日本語の種別（巻, 話）"],
              ["{volume}", "巻・話の番号（例: 1, 12）"],
              ["{volume:N}", "N桁ゼロ埋め（例: {volume:2}→01, {volume:3}→001）"],
              ["{author}", "著者名"],
              ["{tags}", "タグを半角スペースで結合（例: タグ1 タグ2）"],
              ["{tags_comma}", "タグをカンマ区切り（例: タグ1,タグ2）"],
            ].map(([variable, desc]) => (
              <View key={variable} style={styles.templateInfoRow}>
                <Text style={styles.templateInfoVar}>{variable}</Text>
                <Text style={styles.templateInfoDesc}>{desc}</Text>
              </View>
            ))}
          </View>
        )}
        <TextInput
          style={styles.input}
          value={pathTemplate}
          onChangeText={setPathTemplate}
          placeholder="{title}/[{author}] {title} 第{volume:2}{unit_ja} - ({tags})"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        <Text style={styles.templatePreview}>
          例: {basePath}/{pathTemplate
            .replace(/\{plugin\}/g, "cmoa")
            .replace(/\{title\}/g, "タイトル名")
            .replace(/\{volume:(\d+)\}/g, (_, d: string) => "1".padStart(Number(d), "0"))
            .replace(/\{volume\}/g, "1")
            .replace(/\{unit_ja\}/g, "巻")
            .replace(/\{unit\}/g, "vol")
            .replace(/\{author\}/g, "著者名")
            .replace(/\{tags\}/g, "タグ1 タグ2")
            .replace(/\{tags_comma\}/g, "タグ1,タグ2")}.zip
        </Text>
        <TouchableOpacity
          style={[styles.btn, { marginTop: 4 }]}
          onPress={() => updateDownloadSettingsMutation.mutate()}
          disabled={updateDownloadSettingsMutation.isPending}
        >
          {updateDownloadSettingsMutation.isPending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.btnText}>保存</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Plugins */}
      <View style={styles.sectionHeaderRow}>
        <Ionicons name="layers-outline" size={16} color="#94a3b8" />
        <Text style={styles.sectionLabel}>データソース</Text>
      </View>
      <View style={[styles.section, { paddingVertical: 6 }]}>
        {plugins.length === 0 ? (
          <View style={styles.emptyHint}>
            <Text style={styles.hintText}>データソースがありません</Text>
          </View>
        ) : (
          [...plugins].sort((a: PluginInfo, b: PluginInfo) => {
            const order = (p: PluginInfo) => {
              const isSeries = p.contentType === "series" ? 0 : 1;
              const hasAuth = p.supportedFeatures.auth ? 0 : 1;
              return isSeries * 2 + hasAuth;
            };
            return order(a) - order(b) || a.name.localeCompare(b.name);
          }).map((p: PluginInfo, i: number) => {
            const pluginAccount = accounts.find(
              (acc: Account) => acc.pluginId === p.id
            );
            const needsAuth = p.supportedFeatures.auth;
            const isExpanded = expandedPluginId === p.id;

            return (
              <View
                key={p.id}
                style={[
                  styles.pluginCard,
                  i === plugins.length - 1 && styles.lastRow,
                ]}
              >
                {/* Plugin header */}
                <View style={styles.pluginHeader}>
                  <View style={styles.pluginNameRow}>
                    <View style={[styles.sourceColorDot, { backgroundColor: (SOURCE_COLORS[p.id] ?? DEFAULT_SOURCE_COLOR).text }]} />
                    <Text style={styles.pluginName}>{p.name}</Text>
                  </View>
                  <View style={styles.contentTypeBadge}>
                    <Ionicons
                      name={
                        p.contentType === "series"
                          ? "library-outline"
                          : "document-outline"
                      }
                      size={11}
                      color="#64748b"
                    />
                    <Text style={styles.contentTypeBadgeText}>
                      {p.contentType === "series" ? "シリーズ" : "単巻"}
                    </Text>
                  </View>
                </View>

                {/* Account status for auth plugins */}
                {needsAuth && pluginAccount && !isExpanded && (
                  <View>
                    <TouchableOpacity
                      style={styles.pluginAccountRow}
                      onPress={() => {
                        setExpandedPluginId(p.id);
                        setNewAccEmail("");
                        setNewAccPassword("");
                      }}
                    >
                      <Ionicons name="person" size={13} color="#94a3b8" />
                      <Text style={styles.pluginAccountEmail}>
                        {pluginAccount.label ?? pluginAccount.pluginId}
                      </Text>
                      <Ionicons name="create-outline" size={14} color="#64748b" />
                    </TouchableOpacity>

                    {/* Session status & actions */}
                    <View style={styles.sessionRow}>
                      {(() => {
                        const s = pluginAccount.session;
                        const expired = s?.expiresAt && new Date(s.expiresAt) < new Date();
                        const status = !s?.hasCookies ? "none" : expired ? "expired" : "active";
                        return (
                          <View style={[
                            styles.sessionBadge,
                            status === "active" ? styles.sessionActive
                              : status === "expired" ? styles.sessionExpired
                              : styles.sessionInactive,
                          ]}>
                            <View style={[styles.sessionDot, {
                              backgroundColor: status === "active" ? "#4ade80"
                                : status === "expired" ? "#fbbf24"
                                : "#64748b",
                            }]} />
                            <Text style={
                              status === "active" ? styles.sessionTextActive
                                : status === "expired" ? styles.sessionTextExpired
                                : styles.sessionTextInactive
                            }>
                              {status === "active"
                                ? `ログイン済み (~${new Date(s!.expiresAt!).toLocaleDateString("ja-JP")})`
                                : status === "expired"
                                ? "期限切れ"
                                : "未ログイン"}
                            </Text>
                          </View>
                        );
                      })()}

                      <View style={styles.sessionActions}>
                        <TouchableOpacity
                          style={styles.sessionTextBtn}
                          onPress={() => loginMutation.mutate(pluginAccount.id)}
                          disabled={loginMutation.isPending}
                        >
                          {loginMutation.isPending && loginMutation.variables === pluginAccount.id ? (
                            <ActivityIndicator color="#60a5fa" size="small" />
                          ) : (
                            <Text style={styles.sessionTextBtnLabel}>
                              {pluginAccount.session?.hasCookies ? "再ログイン" : "ログイン"}
                            </Text>
                          )}
                        </TouchableOpacity>
                        {pluginAccount.session?.hasCookies && (
                          <TouchableOpacity
                            style={styles.sessionTextBtn}
                            onPress={() => clearSessionMutation.mutate(pluginAccount.id)}
                            disabled={clearSessionMutation.isPending}
                          >
                            <Text style={styles.sessionTextBtnLabelDanger}>破棄</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </View>
                )}

                {needsAuth && !pluginAccount && !isExpanded && (
                  <TouchableOpacity
                    style={styles.loginBtn}
                    onPress={() => {
                      setExpandedPluginId(p.id);
                      setNewAccEmail("");
                      setNewAccPassword("");
                    }}
                  >
                    <Ionicons name="log-in-outline" size={14} color="#60a5fa" />
                    <Text style={styles.loginBtnText}>ログイン</Text>
                  </TouchableOpacity>
                )}

                {needsAuth && isExpanded && (
                  <View style={styles.loginForm}>
                    <TextInput
                      style={styles.input}
                      placeholder="メールアドレス"
                      placeholderTextColor="#64748b"
                      value={newAccEmail}
                      onChangeText={setNewAccEmail}
                      autoCapitalize="none"
                      keyboardType="email-address"
                    />
                    <TextInput
                      style={styles.input}
                      placeholder="パスワード"
                      placeholderTextColor="#64748b"
                      value={newAccPassword}
                      onChangeText={setNewAccPassword}
                      secureTextEntry
                    />
                    <View style={styles.loginFormButtons}>
                      <TouchableOpacity
                        style={styles.cancelBtn}
                        onPress={() => setExpandedPluginId(null)}
                      >
                        <Text style={styles.cancelBtnText}>キャンセル</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btn, styles.btnGreen, { flex: 1 }]}
                        onPress={() =>
                          pluginAccount
                            ? updateAccountMutation.mutate(pluginAccount.id)
                            : addAccountMutation.mutate(p.id)
                        }
                        disabled={
                          addAccountMutation.isPending ||
                          updateAccountMutation.isPending ||
                          !newAccEmail ||
                          !newAccPassword
                        }
                      >
                        {addAccountMutation.isPending ||
                        updateAccountMutation.isPending ? (
                          <ActivityIndicator color="#fff" size="small" />
                        ) : (
                          <Text style={styles.btnText}>
                            {pluginAccount ? "更新" : "ログイン"}
                          </Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {!needsAuth && (
                  <Text style={styles.noAuthHint}>ログイン不要</Text>
                )}
              </View>
            );
          })
        )}
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Section
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 20,
    marginBottom: 8,
  },
  sectionLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  section: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
  },

  // Fields
  fieldLabel: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 4,
    marginTop: 8,
  },
  input: {
    backgroundColor: "#0f172a",
    color: "#fff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },

  // Connection
  connectionRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  connectionStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  connectionOk: { backgroundColor: "#052e16" },
  connectionErr: { backgroundColor: "#450a0a" },

  // Buttons
  btn: {
    backgroundColor: "#2563eb",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
  },
  btnGreen: { backgroundColor: "#16a34a", marginTop: 8 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  statusOk: { color: "#4ade80", fontSize: 13, fontWeight: "600" },
  statusErr: { color: "#f87171", fontSize: 13, fontWeight: "600" },

  // Empty hint
  emptyHint: { flexDirection: "row", alignItems: "center", gap: 6 },
  hintText: { color: "#64748b", fontSize: 13, flex: 1 },

  // Plugins
  pluginCard: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  lastRow: { borderBottomWidth: 0 },
  pluginHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pluginNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sourceColorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pluginName: { color: "#fff", fontSize: 14, fontWeight: "600" },
  contentTypeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  contentTypeBadgeText: { fontSize: 11, fontWeight: "600", color: "#64748b" },

  // Plugin account
  pluginAccountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  pluginAccountEmail: { color: "#cbd5e1", fontSize: 13, flex: 1 },
  activeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  activeBadgeOn: { backgroundColor: "#052e16" },
  activeBadgeOff: { backgroundColor: "#292524" },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
  activeTextOn: { color: "#4ade80", fontSize: 11, fontWeight: "600" },
  activeTextOff: { color: "#a8a29e", fontSize: 11, fontWeight: "600" },
  loginBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 8,
  },
  loginBtnText: { color: "#60a5fa", fontSize: 13, fontWeight: "600" },
  loginForm: { marginTop: 10 },
  loginFormButtons: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelBtnText: { color: "#94a3b8", fontSize: 14, fontWeight: "600" },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
  },
  sessionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  sessionActive: { backgroundColor: "#052e16" },
  sessionExpired: { backgroundColor: "#422006" },
  sessionInactive: { backgroundColor: "#1c1917" },
  sessionDot: { width: 6, height: 6, borderRadius: 3 },
  sessionTextActive: { color: "#4ade80", fontSize: 11, fontWeight: "600" },
  sessionTextExpired: { color: "#fbbf24", fontSize: 11, fontWeight: "600" },
  sessionTextInactive: { color: "#64748b", fontSize: 11, fontWeight: "600" },
  sessionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  sessionTextBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sessionTextBtnLabel: { color: "#60a5fa", fontSize: 12, fontWeight: "600" },
  sessionTextBtnLabelDanger: { color: "#f87171", fontSize: 12, fontWeight: "600" },
  noAuthHint: { color: "#64748b", fontSize: 12, marginTop: 6 },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    marginBottom: 4,
  },
  templateInfoBox: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },
  templateInfoTitle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },
  templateInfoRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  templateInfoVar: {
    color: "#60a5fa",
    fontSize: 12,
    fontFamily: "monospace" as any,
    width: 110,
  },
  templateInfoDesc: {
    color: "#94a3b8",
    fontSize: 12,
    flex: 1,
  },
  templateHint: { color: "#64748b", fontSize: 12, marginBottom: 4 },
  templatePreview: {
    color: "#475569",
    fontSize: 12,
    marginBottom: 8,
    fontFamily: "monospace" as any,
  },
});
