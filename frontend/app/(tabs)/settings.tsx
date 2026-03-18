import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
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
  deleteAccount,
  clearAccountSession,
  importCookies,
  getPlugins,
  getCapabilities,
  healthCheck,
  getBaseUrl,
  setBaseUrl,
  type Account,
  type PluginInfo,
  type LoginMethod,
} from "../../src/api/client";
import { SOURCE_COLORS, DEFAULT_SOURCE_COLOR } from "../../src/constants";
import { colors, radius } from "../../src/theme";

const LOGIN_METHOD_INFO: Record<LoginMethod, {
  icon: string;
  label: string;
  short: string;
  how: string;
  onExpiry: string;
  auto: boolean;
}> = {
  credentials: {
    icon: "mail-outline",
    label: "メール/パスワード",
    short: "メール/PW",
    how: "認証情報をサーバーに保存し、Puppeteerで自動ログイン",
    onExpiry: "サーバーが自動で再ログイン（手動操作不要）",
    auto: true,
  },
  browser: {
    icon: "globe-outline",
    label: "ブラウザログイン",
    short: "ブラウザ",
    how: "サーバー側でPuppeteerブラウザが起動、手動でログイン操作（コンテナ・スマホ環境では利用不可）",
    onExpiry: "再度ブラウザログインが必要",
    auto: false,
  },
  cookie_import: {
    icon: "clipboard-outline",
    label: "Cookieインポート",
    short: "Cookie",
    how: "ブラウザのDevToolsからCookie値をコピー&ペースト",
    onExpiry: "再度Cookieのインポートが必要",
    auto: false,
  },
};

const ALL_LOGIN_METHODS = Object.keys(LOGIN_METHOD_INFO) as LoginMethod[];

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [connected, setConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null);
  const [loginMethodTab, setLoginMethodTab] = useState<LoginMethod>("credentials");
  const [newAccEmail, setNewAccEmail] = useState("");
  const [newAccPassword, setNewAccPassword] = useState("");
  const [cookieValues, setCookieValues] = useState<Record<string, string>>({});
  const [cookieExpires, setCookieExpires] = useState<Record<string, string>>({});
  const [showAuthInfo, setShowAuthInfo] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(false);

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

  const { data: capabilities } = useQuery({
    queryKey: ["capabilities"],
    queryFn: getCapabilities,
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
    mutationFn: ({ pluginId, method }: { pluginId: string; method: LoginMethod }) => {
      if (method === "credentials") {
        return createAccount({
          pluginId,
          label: newAccEmail,
          credentials: { email: newAccEmail, password: newAccPassword },
        });
      }
      // browser or cookie_import: create account without credentials
      return createAccount({ pluginId, label: pluginId });
    },
    onSuccess: async (account, { method }) => {
      if (method === "credentials") {
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
      } else if (method === "browser") {
        toast.success("アカウントを追加しました。ブラウザでログインしてください...");
        try {
          await loginAccount(account.id);
          toast.success("ログインしました。");
          setExpandedPluginId(null);
        } catch (err: any) {
          toast.error("ログイン失敗", { description: err.message });
        }
      } else if (method === "cookie_import") {
        const hasCookieData = Object.values(cookieValues).some((v) => v.trim());
        if (hasCookieData) {
          // Auto-import the cookies that were already filled in
          try {
            const cookieArray = Object.entries(cookieValues)
              .filter(([, v]) => v.trim())
              .map(([name, value]) => ({
                name,
                value: value.trim(),
                expires: cookieExpires[name]?.trim() || undefined,
              }));
            const result = await importCookies(account.id, cookieArray);
            if (result.valid) {
              setCookieValues({});
              setCookieExpires({});
              setExpandedPluginId(null);
              toast.success(result.message);
            } else {
              toast.error("Cookie インポート", { description: result.message });
            }
          } catch (err: any) {
            toast.error("Cookie インポート失敗", { description: err.message });
          }
        } else {
          toast.success("アカウントを追加しました。Cookieをインポートしてください。");
        }
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
      setNewAccPassword("");
      setEditingCredentials(false);
      toast.success("認証情報を更新しました。再ログインしてください。");
    },
    onError: (err: Error) => {
      toast.error("エラー", { description: err.message });
    },
  });

  const importCookiesMutation = useMutation({
    mutationFn: (accountId: number) => {
      const cookieArray = Object.entries(cookieValues)
        .filter(([, v]) => v.trim())
        .map(([name, value]) => ({
          name,
          value: value.trim(),
          expires: cookieExpires[name]?.trim() || undefined,
        }));
      return importCookies(accountId, cookieArray);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      if (result.valid) {
        setCookieValues({});
        setCookieExpires({});
        setExpandedPluginId(null);
        toast.success(result.message);
      } else {
        toast.error("Cookie インポート", { description: result.message });
      }
    },
    onError: (err: Error) => {
      toast.error("Cookie インポート失敗", { description: err.message });
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: (accountId: number) => deleteAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setExpandedPluginId(null);
      toast.success("アカウントを削除しました。");
    },
    onError: (err: Error) => {
      toast.error("削除失敗", { description: err.message });
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
        <Ionicons name="server-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.sectionLabel}>サーバー接続</Text>
      </View>
      <View style={styles.section}>
        <Text style={[styles.fieldLabel, { marginTop: 0 }]}>サーバーURL</Text>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="http://192.168.1.x:3000"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
        />
        <View style={styles.connectionRow}>
          <TouchableOpacity
            style={styles.btn}
            onPress={testConnection}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color={colors.white} size="small" />
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
                color={connected ? colors.success : colors.error}
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
        <Ionicons name="download-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.sectionLabel}>ダウンロード設定</Text>
      </View>
      <View style={styles.section}>
        <Text style={[styles.fieldLabel, { marginTop: 0 }]}>ベースディレクトリ</Text>
        <TextInput
          style={styles.input}
          value={basePath}
          onChangeText={setBasePath}
          placeholder="./data/downloads"
          placeholderTextColor={colors.textMuted}
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
              color={showTemplateInfo ? colors.accentLight : colors.textMuted}
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
          placeholderTextColor={colors.textMuted}
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
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.btnText}>保存</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Plugins */}
      <View style={styles.sectionHeaderRow}>
        <Ionicons name="layers-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.sectionLabel}>データソース</Text>
        <TouchableOpacity
          onPress={() => setShowAuthInfo(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ marginLeft: 2 }}
        >
          <Ionicons
            name="help-circle-outline"
            size={15}
            color={colors.textMuted}
          />
        </TouchableOpacity>
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

            // Available login methods for this plugin, filtered by environment
            const allMethods = p.loginMethods ?? [];
            const availableMethods = allMethods.filter(
              (m) => m !== "browser" || (capabilities?.enableBrowserLogin === true && Platform.OS === "web")
            );

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
                      color={colors.textMuted}
                    />
                    <Text style={styles.contentTypeBadgeText}>
                      {p.contentType === "series" ? "シリーズ" : "単巻"}
                    </Text>
                  </View>
                </View>

                {/* Auth section */}
                {needsAuth && (() => {
                  const s = pluginAccount?.session;
                  const hasCookies = !!s?.hasCookies;
                  const expired = s?.expiresAt && new Date(s.expiresAt) < new Date();
                  const cookieStatus: "active" | "expired" | "none" =
                    !hasCookies ? "none" : expired ? "expired" : "active";
                  const allMethods = ALL_LOGIN_METHODS;

                  return (
                    <View>
                      {/* Auth method buttons — always show all 3 */}
                      <View style={styles.authMethodRow}>
                        {allMethods.map((m) => {
                          const enabled = availableMethods.includes(m);
                          const active = isExpanded && loginMethodTab === m;
                          return (
                            <TouchableOpacity
                              key={m}
                              activeOpacity={enabled ? 0.7 : 1}
                              style={[
                                styles.methodBtn,
                                enabled
                                  ? active ? styles.methodBtnActive : styles.methodBtnEnabled
                                  : styles.methodBtnDisabled,
                              ]}
                              disabled={!enabled}
                              onPress={() => {
                                if (active) {
                                  setExpandedPluginId(null);
                                } else {
                                  setExpandedPluginId(p.id);
                                  setLoginMethodTab(m);
                                  setNewAccEmail(pluginAccount?.label ?? "");
                                  setNewAccPassword("");
                                  setCookieValues({});
                                  setCookieExpires({});
                                  setEditingCredentials(false);
                                }
                              }}
                            >
                              <Ionicons
                                name={LOGIN_METHOD_INFO[m].icon as any}
                                size={14}
                                color={active ? colors.accentLight : enabled ? colors.textSemi : colors.textDim}
                              />
                              <Text style={[
                                styles.methodBtnText,
                                active && styles.methodBtnTextActive,
                                !enabled && styles.methodBtnTextDisabled,
                              ]}>
                                {LOGIN_METHOD_INFO[m].short}
                              </Text>
                              {enabled && (
                                <Ionicons
                                  name={active ? "chevron-up" : "chevron-down"}
                                  size={10}
                                  color={active ? colors.accentLight : colors.textMuted}
                                />
                              )}
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {/* Cookie status */}
                      <View style={styles.cookieStatusRow}>
                        <View style={[
                          styles.cookieStatusBadge,
                          cookieStatus === "active" ? styles.sessionActive
                            : cookieStatus === "expired" ? styles.sessionExpired
                            : styles.sessionInactive,
                        ]}>
                          <View style={[styles.sessionDot, {
                            backgroundColor: cookieStatus === "active" ? colors.success
                              : cookieStatus === "expired" ? colors.warning
                              : colors.textMuted,
                          }]} />
                          <Text style={styles.cookieStatusLabel}>Cookie</Text>
                          <Text style={
                            cookieStatus === "active" ? styles.sessionTextActive
                              : cookieStatus === "expired" ? styles.sessionTextExpired
                              : styles.sessionTextInactive
                          }>
                            {cookieStatus === "active"
                              ? s?.expiresAt
                                ? `有効 (~${new Date(s.expiresAt).toLocaleDateString("ja-JP")})`
                                : "有効"
                              : cookieStatus === "expired"
                              ? "期限切れ"
                              : "未取得"}
                          </Text>
                        </View>
                        {hasCookies && (
                          <TouchableOpacity
                            style={styles.cookieClearBtn}
                            onPress={() => clearSessionMutation.mutate(pluginAccount!.id)}
                            disabled={clearSessionMutation.isPending}
                          >
                            <Ionicons name="trash-outline" size={12} color={colors.error} />
                            <Text style={styles.cookieClearText}>クリア</Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      {/* Expanded form for selected method */}
                      {isExpanded && (
                        <View style={styles.loginForm}>
                          {/* Credentials form */}
                          {loginMethodTab === "credentials" && (() => {
                            const hasCredentials = !!pluginAccount?.label;
                            return (hasCredentials && !editingCredentials) ? (
                              <>
                                <View style={styles.credentialSummary}>
                                  <View style={styles.credentialSummaryRow}>
                                    <Ionicons name="mail-outline" size={13} color={colors.textMuted} />
                                    <Text style={styles.credentialSummaryValue}>{pluginAccount.label}</Text>
                                  </View>
                                  <View style={styles.credentialSummaryRow}>
                                    <Ionicons name="lock-closed-outline" size={13} color={colors.textMuted} />
                                    <Text style={styles.credentialSummaryValue}>••••••••</Text>
                                  </View>
                                  <View style={styles.credentialSummaryActions}>
                                    <TouchableOpacity
                                      style={styles.credentialSecondaryBtn}
                                      onPress={() => setEditingCredentials(true)}
                                    >
                                      <Ionicons name="create-outline" size={12} color={colors.accentLight} />
                                      <Text style={styles.credentialSecondaryBtnText}>編集</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      style={styles.credentialSecondaryBtn}
                                      onPress={() => deleteAccountMutation.mutate(pluginAccount.id)}
                                      disabled={deleteAccountMutation.isPending}
                                    >
                                      <Ionicons name="trash-outline" size={12} color={colors.error} />
                                      <Text style={styles.credentialDeleteBtnText}>削除</Text>
                                    </TouchableOpacity>
                                  </View>
                                </View>
                                <View style={styles.loginFormButtons}>
                                  <TouchableOpacity
                                    style={styles.cancelBtn}
                                    onPress={() => setExpandedPluginId(null)}
                                  >
                                    <Text style={styles.cancelBtnText}>閉じる</Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={[styles.btn, { flex: 1 }]}
                                    onPress={() => loginMutation.mutate(pluginAccount.id)}
                                    disabled={loginMutation.isPending}
                                  >
                                    {loginMutation.isPending ? (
                                      <ActivityIndicator color={colors.white} size="small" />
                                    ) : (
                                      <Text style={styles.btnText}>再ログイン</Text>
                                    )}
                                  </TouchableOpacity>
                                </View>
                              </>
                            ) : (
                              <>
                                <TextInput
                                  style={styles.input}
                                  placeholder="メールアドレス"
                                  placeholderTextColor={colors.textMuted}
                                  value={newAccEmail}
                                  onChangeText={setNewAccEmail}
                                  autoCapitalize="none"
                                  keyboardType="email-address"
                                />
                                <TextInput
                                  style={styles.input}
                                  placeholder="パスワード"
                                  placeholderTextColor={colors.textMuted}
                                  value={newAccPassword}
                                  onChangeText={setNewAccPassword}
                                  secureTextEntry
                                />
                                <View style={styles.loginFormButtons}>
                                  <TouchableOpacity
                                    style={styles.cancelBtn}
                                    onPress={() => {
                                      if (hasCredentials) {
                                        setEditingCredentials(false);
                                      } else {
                                        setExpandedPluginId(null);
                                      }
                                    }}
                                  >
                                    <Text style={styles.cancelBtnText}>キャンセル</Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={[styles.btn, styles.btnGreen, { flex: 1 }]}
                                    onPress={() =>
                                      pluginAccount
                                        ? updateAccountMutation.mutate(pluginAccount.id)
                                        : addAccountMutation.mutate({ pluginId: p.id, method: "credentials" })
                                    }
                                    disabled={
                                      addAccountMutation.isPending ||
                                      updateAccountMutation.isPending ||
                                      !newAccEmail ||
                                      !newAccPassword
                                    }
                                  >
                                    {addAccountMutation.isPending || updateAccountMutation.isPending ? (
                                      <ActivityIndicator color={colors.white} size="small" />
                                    ) : (
                                      <Text style={styles.btnText}>
                                        {pluginAccount ? "更新" : "ログイン"}
                                      </Text>
                                    )}
                                  </TouchableOpacity>
                                </View>
                              </>
                            );
                          })()}

                          {/* Browser login */}
                          {loginMethodTab === "browser" && (
                            <>
                              <Text style={styles.cookieHint}>
                                サーバー側でブラウザが開きます。表示されたブラウザでログインするとCookieが保存されます。
                              </Text>
                              <View style={styles.loginFormButtons}>
                                <TouchableOpacity
                                  style={styles.cancelBtn}
                                  onPress={() => setExpandedPluginId(null)}
                                >
                                  <Text style={styles.cancelBtnText}>キャンセル</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={[styles.btn, styles.btnGreen, { flex: 1 }]}
                                  onPress={() => {
                                    if (pluginAccount) {
                                      loginMutation.mutate(pluginAccount.id);
                                      setExpandedPluginId(null);
                                    } else {
                                      addAccountMutation.mutate({ pluginId: p.id, method: "browser" });
                                    }
                                  }}
                                  disabled={addAccountMutation.isPending || loginMutation.isPending}
                                >
                                  {addAccountMutation.isPending || loginMutation.isPending ? (
                                    <ActivityIndicator color={colors.white} size="small" />
                                  ) : (
                                    <Text style={styles.btnText}>ブラウザを開く</Text>
                                  )}
                                </TouchableOpacity>
                              </View>
                            </>
                          )}

                          {/* Cookie import */}
                          {loginMethodTab === "cookie_import" && (() => {
                            const cookieNames = p.authCookieNames ?? [];
                            const hasCookieData = cookieNames.some((n) => cookieValues[n]?.trim());
                            return (
                              <>
                                <View style={styles.cookieHintBlock}>
                                  <Text style={styles.cookieHint}>
                                    {"1. "}
                                    {p.authUrl ? (
                                      <Text
                                        style={styles.cookieHintLink}
                                        onPress={() => Linking.openURL(p.authUrl!)}
                                      >
                                        {p.authUrl}
                                      </Text>
                                    ) : (
                                      <Text>サイト</Text>
                                    )}
                                    {" にログイン済みの状態でアクセス"}
                                  </Text>
                                  <Text style={styles.cookieHint}>
                                    {"2. DevTools > Application > Cookies から以下の Value と Expires をコピー"}
                                  </Text>
                                </View>
                                {cookieNames.map((name) => (
                                  <View key={name} style={styles.cookieFieldGroup}>
                                    <Text style={styles.cookieFieldLabel}>{name}</Text>
                                    <TextInput
                                      style={styles.input}
                                      placeholder="Value"
                                      placeholderTextColor={colors.textMuted}
                                      value={cookieValues[name] ?? ""}
                                      onChangeText={(v) => setCookieValues((prev) => ({ ...prev, [name]: v }))}
                                      autoCapitalize="none"
                                    />
                                    <TextInput
                                      style={styles.input}
                                      placeholder="Expires (例: 2027-04-22T04:32:37.832Z)"
                                      placeholderTextColor={colors.textMuted}
                                      value={cookieExpires[name] ?? ""}
                                      onChangeText={(v) => setCookieExpires((prev) => ({ ...prev, [name]: v }))}
                                      autoCapitalize="none"
                                    />
                                  </View>
                                ))}
                                <View style={styles.loginFormButtons}>
                                  <TouchableOpacity
                                    style={styles.cancelBtn}
                                    onPress={() => setExpandedPluginId(null)}
                                  >
                                    <Text style={styles.cancelBtnText}>キャンセル</Text>
                                  </TouchableOpacity>
                                  <TouchableOpacity
                                    style={[styles.btn, styles.btnGreen, { flex: 1 }]}
                                    onPress={() => {
                                      if (pluginAccount) {
                                        importCookiesMutation.mutate(pluginAccount.id);
                                      } else {
                                        addAccountMutation.mutate({ pluginId: p.id, method: "cookie_import" });
                                      }
                                    }}
                                    disabled={
                                      importCookiesMutation.isPending ||
                                      addAccountMutation.isPending ||
                                      !hasCookieData
                                    }
                                  >
                                    {importCookiesMutation.isPending || addAccountMutation.isPending ? (
                                      <ActivityIndicator color={colors.white} size="small" />
                                    ) : (
                                      <Text style={styles.btnText}>
                                        {pluginAccount ? "インポート" : "インポート"}
                                      </Text>
                                    )}
                                  </TouchableOpacity>
                                </View>
                              </>
                            );
                          })()}
                        </View>
                      )}
                    </View>
                  );
                })()}

                {!needsAuth && (
                  <Text style={styles.noAuthHint}>ログイン不要</Text>
                )}
              </View>
            );
          })
        )}
      </View>

      <View style={{ height: 40 }} />

      {/* Auth methods help modal */}
      <Modal
        visible={showAuthInfo}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAuthInfo(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowAuthInfo(false)}
        >
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>認証の仕組み</Text>

            {/* Overview */}
            <View style={styles.modalOverviewBox}>
              <Ionicons name="information-circle-outline" size={14} color={colors.accentLight} style={{ marginTop: 2 }} />
              <Text style={styles.modalOverviewText}>
                どの方式でログインしても、結果としてCookieがサーバーに保存されます。
                保存されたCookieはメタデータ取得やダウンロードに共通で使われます。
              </Text>
            </View>

            <View style={styles.modalDivider} />

            {/* Method cards */}
            {ALL_LOGIN_METHODS.map((m) => {
              const info = LOGIN_METHOD_INFO[m];
              return (
                <View key={m} style={styles.methodInfoItem}>
                  <View style={styles.methodInfoHeader}>
                    <Ionicons name={info.icon as any} size={14} color={colors.accentLight} />
                    <Text style={styles.methodInfoTitle}>{info.label}</Text>
                    {info.auto ? (
                      <View style={styles.autoRecoverBadge}>
                        <Ionicons name="refresh-outline" size={10} color={colors.success} />
                        <Text style={styles.autoRecoverText}>自動復旧</Text>
                      </View>
                    ) : (
                      <View style={styles.manualBadge}>
                        <Text style={styles.manualBadgeText}>手動更新</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.methodInfoBody}>
                    <View style={styles.methodInfoRow}>
                      <Text style={styles.methodInfoArrow}>→</Text>
                      <Text style={styles.methodInfoDesc}>{info.how}</Text>
                    </View>
                    <View style={styles.methodInfoRow}>
                      <Text style={styles.methodInfoArrow}>→</Text>
                      <Text style={styles.methodInfoDesc}>期限切れ時: {info.onExpiry}</Text>
                    </View>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setShowAuthInfo(false)}
            >
              <Text style={styles.modalCloseBtnText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16 },

  // Section
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 20,
    marginBottom: 8,
  },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  section: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // Fields
  fieldLabel: {
    color: colors.textSemi,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 4,
    marginTop: 8,
  },
  input: {
    backgroundColor: colors.bg,
    color: colors.white,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // Connection
  connectionRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  connectionStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  connectionOk: { backgroundColor: colors.successBg },
  connectionErr: { backgroundColor: colors.errorBg },

  // Buttons
  btn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
  },
  btnGreen: { backgroundColor: colors.successDark, marginTop: 8 },
  btnText: { color: colors.white, fontWeight: "700", fontSize: 14 },
  statusOk: { color: colors.success, fontSize: 13, fontWeight: "600" },
  statusErr: { color: colors.error, fontSize: 13, fontWeight: "600" },

  // Empty hint
  emptyHint: { flexDirection: "row", alignItems: "center", gap: 6 },
  hintText: { color: colors.textMuted, fontSize: 13, flex: 1 },

  // Plugins
  pluginCard: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderAccent,
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
  pluginName: { color: colors.white, fontSize: 14, fontWeight: "600" },
  contentTypeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  contentTypeBadgeText: { fontSize: 11, fontWeight: "600", color: colors.textMuted },

  // Cookie status
  cookieStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  cookieStatusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  cookieStatusLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    marginRight: 2,
  },
  cookieClearBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cookieClearText: {
    color: colors.error,
    fontSize: 11,
    fontWeight: "600",
  },
  loginForm: { marginTop: 10 },
  credentialSummary: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: 10,
    gap: 6,
    marginBottom: 8,
  },
  credentialSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  credentialSummaryValue: {
    color: colors.textSemi,
    fontSize: 13,
  },
  credentialSummaryActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 4,
  },
  credentialSecondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  credentialSecondaryBtnText: {
    color: colors.accentLight,
    fontSize: 12,
    fontWeight: "600",
  },
  credentialDeleteBtnText: {
    color: colors.error,
    fontSize: 12,
    fontWeight: "600",
  },
  loginFormButtons: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelBtnText: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  sessionActive: { backgroundColor: colors.successBg },
  sessionExpired: { backgroundColor: colors.warningBg },
  sessionInactive: { backgroundColor: colors.neutralBgDark },
  sessionDot: { width: 6, height: 6, borderRadius: 3 },
  sessionTextActive: { color: colors.success, fontSize: 11, fontWeight: "600" },
  sessionTextExpired: { color: colors.warning, fontSize: 11, fontWeight: "600" },
  sessionTextInactive: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  noAuthHint: { color: colors.textMuted, fontSize: 12, marginTop: 6 },
  cookieHintBlock: {
    marginBottom: 10,
    gap: 2,
  },
  cookieHint: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  cookieHintLink: {
    color: colors.accentLight,
    textDecorationLine: "underline" as const,
  },
  cookieFieldGroup: {
    marginBottom: 4,
  },
  cookieFieldLabel: {
    color: colors.accentLight,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: "monospace" as any,
    marginBottom: 4,
  },
  authMethodRow: {
    flexDirection: "row",
    gap: 7,
    marginTop: 8,
  },
  methodBtn: {
    width: 95,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "transparent",
  },
  methodBtnEnabled: {
    backgroundColor: colors.bgElevated,
    borderColor: colors.borderLight,
  },
  methodBtnDisabled: {
    backgroundColor: "transparent",
  },
  methodBtnActive: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accent,
  },
  methodBtnText: {
    color: colors.textSemi,
    fontSize: 11,
    fontWeight: "700",
  },
  methodBtnTextActive: {
    color: colors.accentLight,
  },
  methodBtnTextDisabled: {
    color: colors.textDim,
    fontSize: 10,
  },
  manualBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.warningBg,
  },
  manualBadgeText: {
    color: colors.warning,
    fontSize: 10,
    fontWeight: "700",
  },
  autoRecoverBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.successBg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  autoRecoverText: {
    color: colors.success,
    fontSize: 10,
    fontWeight: "700",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: 20,
    width: "100%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: {
    color: colors.white,
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 4,
  },
  modalOverviewBox: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: 12,
    marginBottom: 14,
  },
  modalOverviewText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 19,
    flex: 1,
  },
  methodInfoItem: {
    marginBottom: 14,
  },
  methodInfoHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  methodInfoTitle: {
    color: colors.white,
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  methodInfoBody: {
    paddingLeft: 20,
    gap: 2,
  },
  methodInfoRow: {
    flexDirection: "row",
    gap: 6,
  },
  methodInfoDesc: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },
  methodInfoArrow: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  modalDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: 12,
  },
  modalNote: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginBottom: 4,
  },
  modalCloseBtn: {
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingVertical: 8,
    marginTop: 4,
  },
  modalCloseBtnText: {
    color: colors.accentLight,
    fontSize: 14,
    fontWeight: "600",
  },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    marginBottom: 4,
  },
  templateInfoBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderAccent,
  },
  templateInfoTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },
  templateInfoRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  templateInfoVar: {
    color: colors.accentLight,
    fontSize: 12,
    fontFamily: "monospace" as any,
    width: 110,
  },
  templateInfoDesc: {
    color: colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  templateHint: { color: colors.textMuted, fontSize: 12, marginBottom: 4 },
  templatePreview: {
    color: colors.textDim,
    fontSize: 12,
    marginBottom: 8,
    fontFamily: "monospace" as any,
  },
});
