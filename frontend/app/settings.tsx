import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getSettings,
  updateSettings,
  getAccounts,
  createAccount,
  getPlugins,
  healthCheck,
  getBaseUrl,
  setBaseUrl,
  type Account,
  type PluginInfo,
} from "../src/api/client";

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(getBaseUrl());
  const [connected, setConnected] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);

  const [newAccPluginId, setNewAccPluginId] = useState("");
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
    mutationFn: () =>
      createAccount({
        pluginId: newAccPluginId,
        label: newAccPluginId,
        credentials: { email: newAccEmail, password: newAccPassword },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setNewAccEmail("");
      setNewAccPassword("");
      setNewAccPluginId("");
      Alert.alert("完了", "アカウントを追加しました。");
    },
    onError: (err: Error) => Alert.alert("エラー", err.message),
  });

  const authPlugins = plugins.filter((p: PluginInfo) => p.supportedFeatures.auth);

  return (
    <ScrollView style={styles.container}>
      {/* API Connection */}
      <Text style={styles.sectionLabel}>サーバー接続</Text>
      <View style={styles.section}>
        <Text style={styles.fieldLabel}>サーバーURL</Text>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="http://192.168.1.x:3000"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        <View style={styles.connectionRow}>
          <TouchableOpacity style={styles.btn} onPress={testConnection} disabled={testing}>
            {testing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>接続テスト</Text>
            )}
          </TouchableOpacity>
          {connected !== null && (
            <View style={[styles.connectionStatus, connected ? styles.connectionOk : styles.connectionErr]}>
              <View style={[styles.connectionDot, { backgroundColor: connected ? "#4ade80" : "#f87171" }]} />
              <Text style={connected ? styles.statusOk : styles.statusErr}>
                {connected ? "接続OK" : "接続失敗"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Accounts */}
      <Text style={styles.sectionLabel}>アカウント</Text>
      <View style={styles.section}>
        {accounts.length === 0 ? (
          <Text style={styles.hint}>アカウントが未登録です。下のフォームから追加してください。</Text>
        ) : (
          accounts.map((acc: Account, i: number) => (
            <View key={acc.id} style={[styles.accountRow, i === accounts.length - 1 && styles.lastRow]}>
              <View>
                <Text style={styles.accountLabel}>{acc.label ?? acc.pluginId}</Text>
                <Text style={styles.accountPlugin}>{acc.pluginId}</Text>
              </View>
              <View style={[styles.activeBadge, acc.isActive ? styles.activeBadgeOn : styles.activeBadgeOff]}>
                <Text style={acc.isActive ? styles.activeTextOn : styles.activeTextOff}>
                  {acc.isActive ? "有効" : "無効"}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Add Account */}
      {authPlugins.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>アカウント追加</Text>
          <View style={styles.section}>
            <Text style={styles.fieldLabel}>プラグイン</Text>
            <View style={styles.pickerRow}>
              {authPlugins.map((p: PluginInfo) => (
                <TouchableOpacity
                  key={p.id}
                  style={[
                    styles.pickerOption,
                    newAccPluginId === p.id && styles.pickerSelected,
                  ]}
                  onPress={() => setNewAccPluginId(p.id)}
                >
                  <Text
                    style={[
                      styles.pickerText,
                      newAccPluginId === p.id && styles.pickerTextSelected,
                    ]}
                  >
                    {p.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {newAccPluginId !== "" && (
              <>
                <Text style={styles.fieldLabel}>メールアドレス</Text>
                <TextInput
                  style={styles.input}
                  placeholder="user@example.com"
                  placeholderTextColor="#64748b"
                  value={newAccEmail}
                  onChangeText={setNewAccEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <Text style={styles.fieldLabel}>パスワード</Text>
                <TextInput
                  style={styles.input}
                  placeholder="パスワード"
                  placeholderTextColor="#64748b"
                  value={newAccPassword}
                  onChangeText={setNewAccPassword}
                  secureTextEntry
                />
                <TouchableOpacity
                  style={[styles.btn, styles.btnGreen]}
                  onPress={() => addAccountMutation.mutate()}
                  disabled={addAccountMutation.isPending || !newAccEmail || !newAccPassword}
                >
                  {addAccountMutation.isPending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.btnText}>アカウントを追加</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </>
      )}

      {/* Plugins */}
      <Text style={styles.sectionLabel}>プラグイン一覧</Text>
      <View style={styles.section}>
        {plugins.length === 0 ? (
          <Text style={styles.hint}>プラグインがインストールされていません。</Text>
        ) : (
          plugins.map((p: PluginInfo, i: number) => (
            <View key={p.id} style={[styles.pluginRow, i === plugins.length - 1 && styles.lastRow]}>
              <View>
                <Text style={styles.pluginName}>{p.name}</Text>
                <Text style={styles.pluginMeta}>{p.id} &middot; v{p.version}</Text>
              </View>
              <View style={styles.featureTags}>
                {Object.entries(p.supportedFeatures)
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <View key={k} style={styles.featureTag}>
                      <Text style={styles.featureTagText}>{k}</Text>
                    </View>
                  ))}
              </View>
            </View>
          ))
        )}
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },

  // Section
  sectionLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  section: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
  },

  // Fields
  fieldLabel: { color: "#cbd5e1", fontSize: 13, fontWeight: "600", marginBottom: 4, marginTop: 8 },
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
  connectionDot: { width: 8, height: 8, borderRadius: 4 },

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

  // Accounts
  accountRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  lastRow: { borderBottomWidth: 0 },
  accountLabel: { color: "#fff", fontSize: 14, fontWeight: "600" },
  accountPlugin: { color: "#64748b", fontSize: 12, marginTop: 1 },
  activeBadge: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  activeBadgeOn: { backgroundColor: "#052e16" },
  activeBadgeOff: { backgroundColor: "#44403c" },
  activeTextOn: { color: "#4ade80", fontSize: 11, fontWeight: "600" },
  activeTextOff: { color: "#a8a29e", fontSize: 11, fontWeight: "600" },

  hint: { color: "#64748b", fontSize: 13 },

  // Plugin picker
  pickerRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  pickerOption: {
    backgroundColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pickerSelected: { backgroundColor: "#2563eb" },
  pickerText: { color: "#94a3b8", fontSize: 14, fontWeight: "500" },
  pickerTextSelected: { color: "#fff", fontWeight: "700" },

  // Plugins
  pluginRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  pluginName: { color: "#fff", fontSize: 14, fontWeight: "600" },
  pluginMeta: { color: "#64748b", fontSize: 12, marginTop: 1 },
  featureTags: { flexDirection: "row", gap: 4 },
  featureTag: {
    backgroundColor: "#334155",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  featureTagText: { color: "#94a3b8", fontSize: 10, fontWeight: "600" },
});
