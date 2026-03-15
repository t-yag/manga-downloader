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
import { toast } from "sonner-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  updateSettings,
  getAccounts,
  createAccount,
  updateAccount,
  getPlugins,
  healthCheck,
  getBaseUrl,
  setBaseUrl,
  type Account,
  type PluginInfo,
} from "../../src/api/client";

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [connected, setConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null);
  const [newAccEmail, setNewAccEmail] = useState("");
  const [newAccPassword, setNewAccPassword] = useState("");

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

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

  const addAccountMutation = useMutation({
    mutationFn: (pluginId: string) =>
      createAccount({
        pluginId,
        label: newAccEmail,
        credentials: { email: newAccEmail, password: newAccPassword },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setNewAccEmail("");
      setNewAccPassword("");
      setExpandedPluginId(null);
      toast.success("アカウントを追加しました。");
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

      {/* Plugins */}
      <View style={styles.sectionHeaderRow}>
        <Ionicons name="extension-puzzle-outline" size={16} color="#94a3b8" />
        <Text style={styles.sectionLabel}>プラグイン</Text>
      </View>
      <View style={[styles.section, { paddingVertical: 6 }]}>
        {plugins.length === 0 ? (
          <View style={styles.emptyHint}>
            <Text style={styles.hintText}>プラグインがありません</Text>
          </View>
        ) : (
          plugins.map((p: PluginInfo, i: number) => {
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
                <Text style={styles.pluginName}>{p.name}</Text>

                {/* Account status for auth plugins */}
                {needsAuth && pluginAccount && !isExpanded && (
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
  lastRow: { borderBottomWidth: 0, paddingBottom: 0 },
  pluginName: { color: "#fff", fontSize: 14, fontWeight: "600" },

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
  noAuthHint: { color: "#64748b", fontSize: 12, marginTop: 6 },
});
