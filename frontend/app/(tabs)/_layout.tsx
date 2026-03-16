import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#60a5fa",
        tabBarInactiveTintColor: "#64748b",
        tabBarStyle: Platform.OS === "web"
          ? { display: "none" }
          : {
              backgroundColor: "#0f172a",
              borderTopColor: "#1e293b",
              borderTopWidth: 1,
              paddingBottom: 4,
              height: 56,
            },
        headerStyle: {
          backgroundColor: "#0f172a",
        },
        headerTintColor: "#f1f5f9",
        headerTitleStyle: {
          fontWeight: "700",
          fontSize: 17,
        },
        headerShadowVisible: false,
        ...(Platform.OS === "web" && { headerShown: false }),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "ライブラリ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="library" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="tags"
        options={{
          title: "タグ管理",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="pricetag" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="jobs/index"
        options={{
          title: "ジョブ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="download" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "設定",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
