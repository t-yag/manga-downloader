import { Tabs } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
});

export default function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: "#2563eb",
          headerShown: false,
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
        <Tabs.Screen
          name="library/[id]"
          options={{
            href: null,
            tabBarItemStyle: { display: "none" },
          }}
        />
      </Tabs>
    </QueryClientProvider>
  );
}
